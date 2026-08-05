import { CardDatabase } from './src/card-database.js';
import { GameState } from './src/game-state.js';
import { buildHostFunctions } from './src/host-functions.js';
import { Interpreter } from './src/interpreter.js';
import { GameLoop } from './src/game-loop.js';

const els = {
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  aName: document.getElementById('a-name'),
  bName: document.getElementById('b-name'),
  aHp: document.getElementById('a-hp'),
  bHp: document.getElementById('b-hp'),
  aHpBar: document.getElementById('a-hp-bar'),
  bHpBar: document.getElementById('b-hp-bar'),
  aMomentum: document.getElementById('a-momentum'),
  bMomentum: document.getElementById('b-momentum'),
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

let db, game, interp, loop, running = false, matchOver = false;

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
  els.aHp.textContent = `${A.hitPoints} / ${A.maxHitPoints}`;
  els.bHp.textContent = `${B.hitPoints} / ${B.maxHitPoints}`;
  els.aHpBar.style.width = `${Math.max(0, (A.hitPoints / A.maxHitPoints) * 100)}%`;
  els.bHpBar.style.width = `${Math.max(0, (B.hitPoints / B.maxHitPoints) * 100)}%`;
  renderMomentum(els.aMomentum, A);
  renderMomentum(els.bMomentum, B);
  els.turn.textContent = `Turn ${game.turn} / 50`;
}

async function init() {
  els.status.textContent = 'Loading real card data\u2026';
  const [cardDb, decks] = await Promise.all([
    CardDatabase.loadFromUrl('data/cards.json'),
    fetch('data/decks.json').then((r) => r.json()),
  ]);
  db = cardDb;
  window.__DECKS = decks;
  els.status.textContent = `Loaded ${db.byFilename.size} real cards.`;
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
  A.playbook.drawStartingHand();
  B.playbook.drawStartingHand();
  game.controlPlayerId = 'A';

  loop = new GameLoop(game, interp, { rng });
  matchOver = false;
  running = false;
  els.log.innerHTML = '';
  els.result.textContent = '';
  els.result.className = '';
  logLine('=== New match: ' + A.superstarPage.name + ' vs ' + B.superstarPage.name + ' ===');
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
