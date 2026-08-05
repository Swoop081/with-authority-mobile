import { CardDatabase } from './src/card-database.js';
import { GameState } from './src/game-state.js';
import { buildHostFunctions, isMomentumCard } from './src/host-functions.js';
import { Interpreter } from './src/interpreter.js';
import { GameLoop } from './src/game-loop.js';

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
  stepBtn: document.getElementById('step-btn'),
  runBtn: document.getElementById('run-btn'),
  newBtn: document.getElementById('new-btn'),
  speedSel: document.getElementById('speed-sel'),
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
// Flag if these look wrong against the original and they're easy to
// re-map.
const MOMENTUM_ICONS = {
  Strike: 'images/icon-strike.png', Strength: 'images/icon-strength.png',
  Technical: 'images/icon-technical.png', Agility: 'images/icon-agility.png',
  Knowledge: 'images/icon-knowledge.png',
};
const BODY_PARTS = ['Head', 'Arm', 'Back', 'Leg'];

let db, game, interp, loop, running = false, matchOver = false, imageMap = {};
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
    chip.className = 'momentum-chip' + (t === 'Attitude' ? ' attitude-chip' : '');
    chip.style.setProperty('--chip-color', TYPE_COLORS[t]);
    const iconSrc = MOMENTUM_ICONS[t];
    chip.innerHTML = iconSrc
      ? `<img src="${iconSrc}" alt="${t}" title="${t}" /><span class="chip-val">${player.momentum.get(t)}</span>`
      : `<span class="chip-val" style="color:${TYPE_COLORS.Attitude}">WWF</span><span class="chip-val">${player.momentum.get(t)}</span>`;
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

function renderStats() {
  const A = game.players.A, B = game.players.B;
  els.aName.textContent = A.superstarPage.name;
  els.bName.textContent = B.superstarPage.name;
  // Real full-body cutout art (properly composited from the game's
  // split color+mask sprite format), not the small square card icon.
  els.aPortrait.src = 'images/kane-headshot.png';
  els.bPortrait.src = 'images/kane-headshot2.png';
  els.aHp.innerHTML = `${A.hitPoints}<span> HP</span>`;
  els.bHp.innerHTML = `${B.hitPoints}<span> HP</span>`;
  renderMomentum(els.aMomentum, A);
  renderMomentum(els.bMomentum, B);
  renderBodyDamage(els.aBody, A);
  renderBodyDamage(els.bBody, B);
  els.turn.textContent = `Turn ${game.turn} / 50`;
  renderHand(A, B);
}

// Sorting spec (2024-08, player's own words): momentum cards first while
// you haven't played one yet this turn; once you have, momentum cards
// drop to the end (they're spent for the turn) and playable moves move
// to the front instead. Anything currently unplayable sits at the very
// back either way, so you're never hunting through dead cards for what
// you can actually do right now.
function sortHandForDisplay(player, opponent) {
  const hand = [...player.playbook.hand];
  const momentumAvailable = !player.momentum.momentumPlayedThisTurn;

  function tier(pg) {
    const isMomentum = isMomentumCard(pg.def);
    if (isMomentum) return momentumAvailable ? 0 : 3;
    const legal = loop.isLegalToPlay(pg, player, opponent);
    return legal ? 1 : 2;
  }

  return hand
    .map((pg, i) => ({ pg, t: tier(pg), i }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.pg);
}

function renderHand(player, opponent) {
  const sorted = sortHandForDisplay(player, opponent);
  els.aHand.innerHTML = '';
  for (const pg of sorted) {
    els.aHand.appendChild(buildFlipCard(pg, player, opponent));
  }
}

function buildFlipCard(pg, player, opponent) {
  const legal = loop.isLegalToPlay(pg, player, opponent);
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
  card.className = 'flip-card' + (legal ? '' : ' card-locked');
  card.style.setProperty('--type-color', color);
  const flipped = flippedCards.has(pg.instanceId);
  if (flipped) card.classList.add('flipped');

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

  card.addEventListener('click', () => {
    if (flippedCards.has(pg.instanceId)) flippedCards.delete(pg.instanceId);
    else flippedCards.add(pg.instanceId);
    card.classList.toggle('flipped');
  });

  return card;
}

function costLabel(def) {
  for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
    const c = def.getNumericField(`${t}_Cost`, 0);
    if (c) return `${c} ${t}`;
  }
  const mc = def.getNumericField('Momentum_Cost', 0);
  return mc ? `${mc} Momentum` : null;
}

// Confirmed rule this whole build follows: you never see the opponent's
// hand contents, only that they have cards -- their identities are only
// revealed in the log at the moment they're actually played.
// Confirmed rule this whole build follows: you never see the opponent's
// hand contents, only that they have cards -- their identities are only
// revealed in the log at the moment they're actually played. No visual
// or textual representation of their hand is shown at all.

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
  matchOver = false;
  running = false;
  flippedCards = new Set();
  els.log.innerHTML = '';
  els.result.textContent = '';
  els.result.className = '';
  logLine('=== New match: ' + A.superstarPage.name + ' vs ' + B.superstarPage.name + ' ===');
  logLine(`Your starting hand (5): ${aHand.map((c) => c.name).join(', ')}`);
  renderStats();
  els.stepBtn.disabled = false;
  els.runBtn.disabled = false;
}

function step() {
  if (matchOver) return;
  const result = loop.runExchange();
  renderStats();
  if (game.winTracker.isOver()) {
    matchOver = true;
    running = false;
    const r = game.winTracker.result;
    els.result.textContent = r.winnerId
      ? `${game.players[r.winnerId].superstarPage.name} wins by ${r.reason.replace('_', ' ')}!`
      : 'Draw \u2014 turn limit reached.';
    els.result.className = r.winnerId ? 'result-win' : 'result-draw';
    els.stepBtn.disabled = true;
    els.runBtn.textContent = 'Run';
  }
  return result;
}

function runLoop() {
  if (!running || matchOver) return;
  step();
  const speed = Number(els.speedSel.value);
  setTimeout(runLoop, speed);
}

els.stepBtn.addEventListener('click', step);
els.runBtn.addEventListener('click', () => {
  running = !running;
  els.runBtn.textContent = running ? 'Pause' : 'Run';
  if (running) runLoop();
});
els.newBtn.addEventListener('click', newMatch);

init();
