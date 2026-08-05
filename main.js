import { CardDatabase } from './src/card-database.js';
import { GameState } from './src/game-state.js';
import { buildHostFunctions, isMomentumCard } from './src/host-functions.js';
import { Interpreter } from './src/interpreter.js';
import { GameLoop } from './src/game-loop.js';
import { MatchController } from './src/match-controller.js';

const els = {
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  aName: document.getElementById('a-name'),
  bName: document.getElementById('b-name'),
  aPortrait: document.getElementById('a-portrait'),
  bPortrait: document.getElementById('b-portrait'),
  aHp: document.getElementById('a-hp'),
  bHp: document.getElementById('b-hp'),
  aMomentum: document.getElementById('a-momentum'),
  bMomentum: document.getElementById('b-momentum'),
  aBody: document.getElementById('a-body'),
  bBody: document.getElementById('b-body'),
  aHand: document.getElementById('a-hand'),
  turn: document.getElementById('turn'),
  result: document.getElementById('result'),
  actionPrompt: document.getElementById('action-prompt'),
  pinBtn: document.getElementById('pin-btn'),
  passBtn: document.getElementById('pass-btn'),
  newBtn: document.getElementById('new-btn'),
};

const MOMENTUM_TYPES = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge', 'Attitude'];
const TYPE_COLORS = {
  Strike: '#3f6f9e', Strength: '#c07a2b', Technical: '#9e3838',
  Agility: '#3d7a4f', Knowledge: '#a3822a', Attitude: '#c9a227',
};
// Best-guess mapping from the real momentum-icons.png sprite sheet to
// stat types -- the sheet itself doesn't label which icon is which, so
// this is an inference (graduation cap -> Knowledge and dumbbell ->
// Strength are unambiguous; the wrench/hammer/spring assignments to
// Technical/Strike/Agility are a reasonable guess, not confirmed).
const MOMENTUM_ICONS = {
  Strike: 'images/icon-strike.png', Strength: 'images/icon-strength.png',
  Technical: 'images/icon-technical.png', Agility: 'images/icon-agility.png',
  Knowledge: 'images/icon-knowledge.png', Attitude: 'images/icon-attitude.png',
};
const BODY_PARTS = ['Head', 'Arm', 'Back', 'Leg'];

let db, game, interp, loop, controller, imageMap = {};
let flippedCards = new Set(); // instanceIds currently showing their back

function cardImageUrl(cardFilename) {
  const img = imageMap[cardFilename];
  return img ? `images/${img}` : null;
}

function logLine(msg) {
  const line = document.createElement('div');
  line.className = 'log-line';
  if (/wins by|draw|COUNT OUT|DISQUALIFIED/i.test(msg)) line.classList.add('log-highlight');
  line.textContent = msg;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function renderMomentum(target, player) {
  target.innerHTML = '';
  for (const t of MOMENTUM_TYPES) {
    const chip = document.createElement('div');
    chip.className = 'momentum-chip';
    chip.style.setProperty('--chip-color', TYPE_COLORS[t]);
    chip.innerHTML = `<img src="${MOMENTUM_ICONS[t]}" alt="${t}" title="${t}" /><span class="chip-val">${player.momentum.get(t)}</span>`;
    target.appendChild(chip);
  }
}

function renderBodyDamage(target, player) {
  target.innerHTML = '';
  for (const part of BODY_PARTS) {
    const chip = document.createElement('div');
    chip.className = 'body-damage-chip';
    const dmg = player.submission.damage[part] || 0;
    chip.innerHTML = `${part[0]} <b>${dmg}</b>`;
    target.appendChild(chip);
  }
}

function costLabel(def) {
  for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
    const c = def.getNumericField(`${t}_Cost`, 0);
    if (c) return `${c} ${t}`;
  }
  const mc = def.getNumericField('Momentum_Cost', 0);
  return mc ? `${mc} Momentum` : null;
}

// Sorting spec (player's own words): momentum cards first while you
// haven't played one yet this turn; once you have, momentum cards drop
// to the end and playable cards move to the front. Adapts per phase --
// during a reaction, legal counters/breakers lead instead.
function sortHandForDisplay(state) {
  const A = game.players.A;
  const hand = [...A.playbook.hand];

  function tier(pg) {
    if (state.phase === 'awaiting-action') {
      const isMom = isMomentumCard(pg.def);
      if (isMom) return state.canPlayMomentum ? 0 : 3;
      const legal = state.legalMoves.some((m) => m.instanceId === pg.instanceId);
      return legal ? 1 : 2;
    }
    if (state.phase === 'awaiting-reaction') {
      return state.legalCounters.some((m) => m.instanceId === pg.instanceId) ? 0 : 1;
    }
    if (state.phase === 'awaiting-pin-reaction') {
      return state.legalBreakers.some((m) => m.instanceId === pg.instanceId) ? 0 : 1;
    }
    return 0;
  }

  return hand.map((pg, i) => ({ pg, t: tier(pg), i })).sort((a, b) => (a.t - b.t) || (a.i - b.i)).map((x) => x.pg);
}

function isCardActionable(pg, state) {
  if (state.phase === 'awaiting-action') {
    return (isMomentumCard(pg.def) && state.canPlayMomentum) || state.legalMoves.some((m) => m.instanceId === pg.instanceId);
  }
  if (state.phase === 'awaiting-reaction') return state.legalCounters.some((m) => m.instanceId === pg.instanceId);
  if (state.phase === 'awaiting-pin-reaction') return state.legalBreakers.some((m) => m.instanceId === pg.instanceId);
  return false;
}

function onCardTapped(pg, state) {
  if (!isCardActionable(pg, state)) {
    // Not playable right now -- just flip it to inspect instead.
    toggleFlip(pg.instanceId);
    render();
    return;
  }
  let next;
  if (state.phase === 'awaiting-action') {
    next = isMomentumCard(pg.def) && state.canPlayMomentum && !state.legalMoves.some((m) => m.instanceId === pg.instanceId)
      ? controller.submitMomentum(pg.instanceId)
      : controller.submitMove(pg.instanceId);
  } else if (state.phase === 'awaiting-reaction') {
    next = controller.submitCounter(pg.instanceId);
  } else if (state.phase === 'awaiting-pin-reaction') {
    next = controller.submitPinReaction(pg.instanceId);
  }
  render(next);
}

function toggleFlip(instanceId) {
  if (flippedCards.has(instanceId)) flippedCards.delete(instanceId);
  else flippedCards.add(instanceId);
}

function buildFlipCard(pg, state) {
  const actionable = isCardActionable(pg, state);
  const isMomentum = isMomentumCard(pg.def);
  const kind = pg.def.template?.includes('Special') ? 'special'
    : isMomentum ? 'momentum'
    : (pg.def.fields.Hit_Points !== undefined) ? 'superstar'
    : 'move';
  const color = isMomentum ? (TYPE_COLORS[Object.keys(pg.def.fields).find((k) => k.endsWith('_Points'))?.replace('_Points', '')] || TYPE_COLORS.Attitude)
    : TYPE_COLORS[pg.def.fields.Method] || '#8a7128';

  const FRONT_TEMPLATE = { move: 'images/page-front.png', momentum: 'images/monmentum-front.png', special: 'images/specials-front.png', superstar: 'images/superstar-front.png' };
  const BACK_TEMPLATE = { move: 'images/card-back-page.png', momentum: 'images/momentum-back.png', special: 'images/specials-back.png', superstar: 'images/superstar-back.png' };
  const DARK_BACK = { move: true, momentum: true, special: false, superstar: false };

  const card = document.createElement('div');
  card.className = 'flip-card' + (actionable ? ' card-actionable' : ' card-locked');
  card.style.setProperty('--type-color', color);
  if (flippedCards.has(pg.instanceId)) card.classList.add('flipped');

  const inner = document.createElement('div');
  inner.className = 'flip-card-inner';

  const front = document.createElement('div');
  front.className = 'flip-face front';
  front.style.backgroundImage = `url('${FRONT_TEMPLATE[kind]}')`;
  const img = cardImageUrl(pg.filename);
  const costLbl = costLabel(pg.def);
  const dmg = pg.def.getNumericField('Damage', 0);
  const method = pg.def.fields.Move_Type || pg.def.fields.Method || '';
  front.innerHTML = `
    ${img ? `<img class="front-photo" src="${img}" alt="" />` : ''}
    <div class="front-statbar">
      <div class="front-name">${pg.name}</div>
      <div class="front-meta">
        <span>${costLbl ? 'Cost: ' + costLbl : ''}</span>
        <span>${dmg ? 'DMG: ' + dmg : ''}</span>
      </div>
      ${method ? `<div class="front-method">${method}</div>` : ''}
    </div>
  `;

  const back = document.createElement('div');
  back.className = 'flip-face back' + (DARK_BACK[kind] ? ' dark-back' : '');
  back.style.backgroundImage = `url('${BACK_TEMPLATE[kind]}')`;
  back.innerHTML = `
    <div class="back-content">
      <div class="back-name">${pg.name}</div>
      ${costLbl ? `<div class="back-stat">Cost: ${costLbl}</div>` : ''}
      ${dmg ? `<div class="back-stat">Damage: ${dmg}</div>` : ''}
      ${method ? `<div class="back-stat">Type: ${method}</div>` : ''}
      <div class="back-text">${(pg.def.text || '').split('\r\n')[0].slice(0, 140)}</div>
    </div>
  `;

  inner.appendChild(front);
  inner.appendChild(back);
  card.appendChild(inner);
  card.addEventListener('click', () => onCardTapped(pg, state));
  return card;
}

function renderHand(state) {
  const sorted = sortHandForDisplay(state);
  els.aHand.innerHTML = '';
  for (const pg of sorted) els.aHand.appendChild(buildFlipCard(pg, state));
}

function renderStats() {
  const A = game.players.A, B = game.players.B;
  els.aName.textContent = A.superstarPage.name;
  els.bName.textContent = B.superstarPage.name;
  els.aPortrait.src = 'images/kane-headshot.png';
  els.bPortrait.src = 'images/kane-headshot2.png';
  els.aHp.innerHTML = `${A.hitPoints}<span> HP</span>`;
  els.bHp.innerHTML = `${B.hitPoints}<span> HP</span>`;
  renderMomentum(els.aMomentum, A);
  renderMomentum(els.bMomentum, B);
  renderBodyDamage(els.aBody, A);
  renderBodyDamage(els.bBody, B);
  els.turn.textContent = `Turn ${game.turn} / 50`;
}

function render(state = controller.describe()) {
  renderStats();

  if (state.phase === 'match-over') {
    const r = state.result;
    els.result.textContent = r.winnerId
      ? `${game.players[r.winnerId].superstarPage.name} wins by ${r.reason.replace('_', ' ')}!`
      : 'Draw \u2014 turn limit reached.';
    els.result.className = r.winnerId ? 'result-win' : 'result-draw';
    els.actionPrompt.style.display = 'none';
    els.pinBtn.style.display = 'none';
    els.passBtn.style.display = 'none';
    els.aHand.innerHTML = '';
    return;
  }

  els.result.textContent = '';
  els.result.className = '';

  if (state.phase === 'awaiting-action') {
    els.actionPrompt.style.display = 'block';
    els.actionPrompt.className = 'your-turn';
    els.actionPrompt.textContent = state.canPlayMomentum
      ? 'Your turn \u2014 play a momentum card, a move, or pass.'
      : 'Your turn \u2014 play a move or pass.';
    els.pinBtn.style.display = state.canAttemptPin ? 'block' : 'none';
    els.pinBtn.disabled = false;
    els.passBtn.style.display = 'block';
  } else if (state.phase === 'awaiting-reaction') {
    els.actionPrompt.style.display = 'block';
    els.actionPrompt.className = 'reaction';
    els.actionPrompt.textContent = `Opponent plays ${state.incomingMove.name} \u2014 counter it, or pass to let it connect.`;
    els.pinBtn.style.display = 'none';
    els.passBtn.style.display = 'block';
    els.passBtn.textContent = 'Pass (let it connect)';
  } else if (state.phase === 'awaiting-pin-reaction') {
    els.actionPrompt.style.display = 'block';
    els.actionPrompt.className = 'reaction';
    els.actionPrompt.textContent = 'Opponent is going for a pin! Break it, or pass and take the risk.';
    els.pinBtn.style.display = 'none';
    els.passBtn.style.display = 'block';
    els.passBtn.textContent = 'Pass (risk the pin)';
  }
  if (state.phase !== 'awaiting-reaction' && state.phase !== 'awaiting-pin-reaction') {
    els.passBtn.textContent = 'Pass';
  }

  renderHand(state);
}

els.pinBtn.addEventListener('click', () => render(controller.submitPin()));
els.passBtn.addEventListener('click', () => {
  const state = controller.describe();
  let next;
  if (state.phase === 'awaiting-action') next = controller.submitPass();
  else if (state.phase === 'awaiting-reaction') next = controller.submitCounter(null);
  else if (state.phase === 'awaiting-pin-reaction') next = controller.submitPinReaction(null);
  render(next);
});
els.newBtn.addEventListener('click', newMatch);

async function init() {
  els.status.textContent = 'Loading real card data\u2026';
  const [cardDb, decks, imgMap] = await Promise.all([
    CardDatabase.loadFromUrl('data/cards.json'),
    fetch('data/decks.json').then((r) => r.json()),
    fetch('data/image_map.json').then((r) => r.json()),
  ]);
  db = cardDb;
  imageMap = imgMap;
  window.__DECKS = decks;
  els.status.textContent = `Loaded ${db.byFilename.size} real cards, ${Object.keys(imageMap).length} with real art.`;
  newMatch();
}

function newMatch() {
  const rng = Math.random;
  game = new GameState(db, { log: logLine, rng });
  const hostFns = buildHostFunctions(game);
  interp = new Interpreter(hostFns, { warnOnUnknown: false });

  const decks = window.__DECKS;
  const A = game.addPlayer('A', 'Kane.gac', decks.Kane.filter((c) => c !== 'Kane.gac'));
  const B = game.addPlayer('B', 'Kane2E.gac', decks.Kane2E.filter((c) => c !== 'Kane2E.gac'));
  const aHand = A.playbook.drawStartingHand();
  B.playbook.drawStartingHand();
  game.controlPlayerId = 'A';

  loop = new GameLoop(game, interp, { rng });
  controller = new MatchController(game, loop, { humanPlayerId: 'A' });
  flippedCards = new Set();
  els.log.innerHTML = '';
  logLine('=== New match: ' + A.superstarPage.name + ' vs ' + B.superstarPage.name + ' ===');
  logLine(`Your starting hand (5): ${aHand.map((c) => c.name).join(', ')}`);

  const state = controller.advance();
  render(state);
}

init();
