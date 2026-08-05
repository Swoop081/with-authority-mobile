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
  aHpBar: document.getElementById('a-hp-bar'),
  bHpBar: document.getElementById('b-hp-bar'),
  aMomentum: document.getElementById('a-momentum'),
  bMomentum: document.getElementById('b-momentum'),
  aHand: document.getElementById('a-hand'),
  bHand: document.getElementById('b-hand'),
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
    chip.className = 'momentum-chip';
    chip.style.setProperty('--chip-color', TYPE_COLORS[t]);
    chip.innerHTML = `<span class="chip-label">${t.slice(0, 3).toUpperCase()}</span><span class="chip-val">${player.momentum.get(t)}</span>`;
    target.appendChild(chip);
  }
}

function renderStats() {
  const A = game.players.A, B = game.players.B;
  els.aName.textContent = A.superstarPage.name;
  els.bName.textContent = B.superstarPage.name;
  const aImg = cardImageUrl(A.superstarPage.filename);
  const bImg = cardImageUrl(B.superstarPage.filename);
  if (aImg) els.aPortrait.src = aImg;
  if (bImg) els.bPortrait.src = bImg;
  els.aHp.textContent = `${A.hitPoints} / ${A.maxHitPoints}`;
  els.bHp.textContent = `${B.hitPoints} / ${B.maxHitPoints}`;
  els.aHpBar.style.width = `${Math.max(0, (A.hitPoints / A.maxHitPoints) * 100)}%`;
  els.bHpBar.style.width = `${Math.max(0, (B.hitPoints / B.maxHitPoints) * 100)}%`;
  renderMomentum(els.aMomentum, A);
  renderMomentum(els.bMomentum, B);
  els.turn.textContent = `Turn ${game.turn} / 50`;
  renderHand(A, B);
  renderOpponentHand(B);
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
  const color = isMomentum ? (TYPE_COLORS[Object.keys(pg.def.fields).find((k) => k.endsWith('_Points'))?.replace('_Points', '')] || TYPE_COLORS.Attitude)
    : TYPE_COLORS[pg.def.fields.Method] || '#8a7128';

  const card = document.createElement('div');
  card.className = 'flip-card' + (legal ? '' : ' card-locked');
  card.style.setProperty('--type-color', color);
  const flipped = flippedCards.has(pg.instanceId);
  if (flipped) card.classList.add('flipped');

  const inner = document.createElement('div');
  inner.className = 'flip-card-inner';

  const front = document.createElement('div');
  front.className = 'flip-face front';
  const img = cardImageUrl(pg.filename);
  if (img) {
    front.innerHTML = `<img src="${img}" alt="" /><div class="card-name-strip">${pg.name}</div>`;
  } else {
    front.innerHTML = `<div class="card-back-generic">${pg.name}</div>`;
  }

  const back = document.createElement('div');
  back.className = 'flip-face back';
  const costLbl = costLabel(pg.def);
  const dmg = pg.def.getNumericField('Damage', 0);
  back.innerHTML = `
    <div class="back-name">${pg.name}</div>
    ${costLbl ? `<div class="back-stat">Cost: ${costLbl}</div>` : ''}
    ${dmg ? `<div class="back-stat">Damage: ${dmg}</div>` : ''}
    <div class="back-text">${(pg.def.text || '').split('\r\n')[0].slice(0, 90)}</div>
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
function renderOpponentHand(opponent) {
  els.bHand.innerHTML = '';
  for (let i = 0; i < opponent.playbook.hand.length; i++) {
    const back = document.createElement('div');
    back.className = 'flip-card';
    back.innerHTML = '<div class="flip-card-inner"><div class="flip-face front"><div class="card-back-generic">?</div></div></div>';
    els.bHand.appendChild(back);
  }
}

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
  const bHand = B.playbook.drawStartingHand();
  game.controlPlayerId = 'A';

  loop = new GameLoop(game, interp, { rng });
  matchOver = false;
  running = false;
  flippedCards = new Set();
  els.log.innerHTML = '';
  els.result.textContent = '';
  els.result.className = '';
  logLine('=== New match: ' + A.superstarPage.name + ' vs ' + B.superstarPage.name + ' ===');
  logLine(`A\u2019s starting hand (5): ${aHand.map((c) => c.name).join(', ')}`);
  logLine(`B\u2019s starting hand (5): ${bHand.map((c) => c.name).join(', ')}`);
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
