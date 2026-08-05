import { CardDatabase } from './src/card-database.js';
import { GameState } from './src/game-state.js';
import { buildHostFunctions, isMomentumCard } from './src/host-functions.js';
import { Interpreter } from './src/interpreter.js';
import { GameLoop } from './src/game-loop.js';
import { MatchController } from './src/match-controller.js';
import { Collection } from './src/collection.js';
import { autoBuildDeck } from './src/auto-deck-builder.js';
import { validateDeck, canIncludeInDeck } from './src/deck-rules.js';

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
  continueHoldBtn: document.getElementById('continue-hold-btn'),
  releaseHoldBtn: document.getElementById('release-hold-btn'),
  tapoutBtn: document.getElementById('tapout-btn'),
  returnRingBtn: document.getElementById('return-ring-btn'),
  newBtn: document.getElementById('new-btn'),
  changeBtn: document.getElementById('change-btn'),
  selectScreen: document.getElementById('select-screen'),
  matchScreen: document.getElementById('match-screen'),
  selectGrid: document.getElementById('select-grid'),
  selectSearch: document.getElementById('select-search'),
  selectConfirmBtn: document.getElementById('select-confirm-btn'),
  deckbuilderScreen: document.getElementById('deckbuilder-screen'),
  dbPortrait: document.getElementById('db-portrait'),
  dbSuperstarName: document.getElementById('db-superstar-name'),
  dbValidation: document.getElementById('db-validation'),
  dbTabCollection: document.getElementById('db-tab-collection'),
  dbTabDeck: document.getElementById('db-tab-deck'),
  dbDeckCount: document.getElementById('db-deck-count'),
  dbSearch: document.getElementById('db-search'),
  dbCardList: document.getElementById('db-card-list'),
  dbBackBtn: document.getElementById('db-back-btn'),
  dbAutoBtn: document.getElementById('db-auto-btn'),
  dbStartBtn: document.getElementById('db-start-btn'),
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

function costInfo(def) {
  let typed = null;
  for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
    const c = def.getNumericField(`${t}_Cost`, 0);
    if (c) { typed = `${c} ${t}`; break; }
  }
  const total = def.getNumericField('Momentum_Cost', 0);
  return { total: total || null, typed };
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
    if (state.phase === 'awaiting-escape') {
      return state.legalEscapes.some((m) => m.instanceId === pg.instanceId) ? 0 : 1;
    }
    if (state.phase === 'awaiting-ringside') {
      return state.ringsideMoves.some((m) => m.instanceId === pg.instanceId) ? 0 : 1;
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
  if (state.phase === 'awaiting-escape') return state.legalEscapes.some((m) => m.instanceId === pg.instanceId);
  if (state.phase === 'awaiting-ringside') return state.ringsideMoves.some((m) => m.instanceId === pg.instanceId);
  return false;
}

function playActionLabel(state) {
  if (state.phase === 'awaiting-reaction') return 'Counter';
  if (state.phase === 'awaiting-pin-reaction') return 'Break Pin';
  if (state.phase === 'awaiting-escape') return 'Escape';
  if (state.phase === 'awaiting-ringside') return 'Play';
  return 'Play';
}

function playCard(pg, state) {
  let next;
  if (state.phase === 'awaiting-action') {
    next = isMomentumCard(pg.def) && state.canPlayMomentum && !state.legalMoves.some((m) => m.instanceId === pg.instanceId)
      ? controller.submitMomentum(pg.instanceId)
      : controller.submitMove(pg.instanceId);
  } else if (state.phase === 'awaiting-reaction') {
    next = controller.submitCounter(pg.instanceId);
  } else if (state.phase === 'awaiting-pin-reaction') {
    next = controller.submitPinReaction(pg.instanceId);
  } else if (state.phase === 'awaiting-escape') {
    next = controller.submitEscape(pg.instanceId);
  } else if (state.phase === 'awaiting-ringside') {
    next = controller.submitRingsideMove(pg.instanceId);
  }
  render(next);
}

function toggleFlip(instanceId) {
  if (flippedCards.has(instanceId)) flippedCards.delete(instanceId);
  else flippedCards.add(instanceId);
}

function buildHandSlot(pg, state) {
  const actionable = isCardActionable(pg, state);
  const slot = document.createElement('div');
  slot.className = 'hand-slot';
  slot.appendChild(buildFlipCard(pg, state, actionable));

  const btn = document.createElement('button');
  btn.className = 'card-play-btn';
  btn.textContent = playActionLabel(state);
  btn.disabled = !actionable;
  btn.addEventListener('click', () => playCard(pg, state));
  slot.appendChild(btn);

  return slot;
}

function buildFlipCard(pg, state, actionable) {
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
  const cost = costInfo(pg.def);
  const dmg = pg.def.getNumericField('Damage', 0);
  const method = pg.def.fields.Move_Type || pg.def.fields.Method || '';
  const costText = cost.total ? `Cost: ${cost.total}` : (cost.typed ? `Cost: ${cost.typed}` : '');
  front.innerHTML = `
    ${img ? `<img class="front-photo" src="${img}" alt="" />` : ''}
    <div class="front-statbar">
      <div class="front-name">${pg.name}</div>
      ${(costText || dmg) ? `<div class="front-meta"><span>${costText}</span><span>${dmg ? 'DMG: ' + dmg : ''}</span></div>` : ''}
      ${method ? `<div class="front-method">${method}</div>` : ''}
    </div>
  `;

  const back = document.createElement('div');
  back.className = 'flip-face back' + (DARK_BACK[kind] ? ' dark-back' : '');
  back.style.backgroundImage = `url('${BACK_TEMPLATE[kind]}')`;
  back.innerHTML = `
    <div class="back-content">
      <div class="back-name">${pg.name}</div>
      ${cost.total ? `<div class="back-stat">Cost: ${cost.total}</div>` : ''}
      ${cost.typed ? `<div class="back-stat">Requires: ${cost.typed}</div>` : ''}
      ${dmg ? `<div class="back-stat">Damage: ${dmg}</div>` : ''}
      ${method ? `<div class="back-stat">Type: ${method}</div>` : ''}
      <div class="back-text">${(pg.def.text || '').split('\r\n')[0].slice(0, 140)}</div>
    </div>
  `;

  inner.appendChild(front);
  inner.appendChild(back);
  card.appendChild(inner);
  // Tap always flips now -- playing is a deliberate, separate action via
  // the button below, so the card itself can always show full art/text.
  card.addEventListener('click', () => { toggleFlip(pg.instanceId); render(); });
  return card;
}

function renderHand(state) {
  const sorted = sortHandForDisplay(state);
  els.aHand.innerHTML = '';
  for (const pg of sorted) els.aHand.appendChild(buildHandSlot(pg, state));
}

function renderStats() {
  const A = game.players.A, B = game.players.B;
  els.aName.textContent = A.superstarPage.name;
  els.bName.textContent = B.superstarPage.name;
  // Real per-superstar art (Kane specifically has extra dramatic
  // close-up headshot crops we composited earlier; everyone else uses
  // their regular resolved card art, which exists for all 1,121 cards).
  els.aPortrait.src = A.superstarPage.filename === 'Kane.gac' ? 'images/kane-headshot.png'
    : A.superstarPage.filename === 'Kane2E.gac' ? 'images/kane-headshot2.png'
    : cardImageUrl(A.superstarPage.filename) || 'images/kane-headshot.png';
  els.bPortrait.src = B.superstarPage.filename === 'Kane.gac' ? 'images/kane-headshot.png'
    : B.superstarPage.filename === 'Kane2E.gac' ? 'images/kane-headshot2.png'
    : cardImageUrl(B.superstarPage.filename) || 'images/kane-headshot2.png';
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

  // Reset every action button to hidden; each phase below shows only
  // the ones relevant to it.
  for (const btn of [els.pinBtn, els.passBtn, els.continueHoldBtn, els.releaseHoldBtn, els.tapoutBtn, els.returnRingBtn]) {
    btn.style.display = 'none';
  }
  els.passBtn.textContent = 'Pass';

  if (state.phase === 'match-over') {
    const r = state.result;
    els.result.textContent = r.winnerId
      ? `${game.players[r.winnerId].superstarPage.name} wins by ${r.reason.replace('_', ' ')}!`
      : 'Draw \u2014 turn limit reached.';
    els.result.className = r.winnerId ? 'result-win' : 'result-draw';
    els.actionPrompt.style.display = 'none';
    els.aHand.innerHTML = '';
    return;
  }

  els.result.textContent = '';
  els.result.className = '';
  els.actionPrompt.style.display = 'block';

  if (state.phase === 'awaiting-action') {
    els.actionPrompt.className = 'your-turn';
    els.actionPrompt.textContent = state.canPlayMomentum
      ? 'Your turn \u2014 play a momentum card, a move, or pass.'
      : 'Your turn \u2014 play a move or pass.';
    if (state.canAttemptPin) els.pinBtn.style.display = 'block';
    els.passBtn.style.display = 'block';
  } else if (state.phase === 'awaiting-reaction') {
    els.actionPrompt.className = 'reaction';
    els.actionPrompt.textContent = `Opponent plays ${state.incomingMove.name} \u2014 counter it, or pass to let it connect.`;
    els.passBtn.style.display = 'block';
    els.passBtn.textContent = 'Pass (let it connect)';
  } else if (state.phase === 'awaiting-pin-reaction') {
    els.actionPrompt.className = 'reaction';
    els.actionPrompt.textContent = 'Opponent is going for a pin! Break it, or pass and take the risk.';
    els.passBtn.style.display = 'block';
    els.passBtn.textContent = 'Pass (risk the pin)';
  } else if (state.phase === 'awaiting-escape') {
    els.actionPrompt.className = 'reaction';
    els.actionPrompt.textContent = `Caught in ${state.holdMoveName} (${state.bodyPart})! Play an escape card, or pass to stay trapped.`;
    els.passBtn.style.display = 'block';
    els.passBtn.textContent = 'Pass (stay trapped)';
  } else if (state.phase === 'awaiting-hold-decision') {
    els.actionPrompt.className = 'your-turn';
    els.actionPrompt.textContent = `You have ${state.trappedPlayerId} in ${state.holdMoveName}. Keep applying pressure (ditches a card), or let them go?`;
    if (state.canContinue) els.continueHoldBtn.style.display = 'block';
    els.releaseHoldBtn.style.display = 'block';
  } else if (state.phase === 'awaiting-tapout') {
    els.actionPrompt.className = 'reaction';
    els.actionPrompt.textContent = `${state.bodyPart} damage: ${state.bodyPartDamage}. HP: ${state.hitPoints}/${state.maxHitPoints}. Tap out, or keep fighting?`;
    els.tapoutBtn.style.display = 'block';
    els.passBtn.style.display = 'block';
    els.passBtn.textContent = 'Keep Fighting';
  } else if (state.phase === 'awaiting-ringside') {
    els.actionPrompt.className = 'your-turn';
    els.actionPrompt.textContent = state.ringsideMoves.length
      ? 'You\u2019re at Ringside \u2014 return to the ring, or play a Ringside move instead.'
      : 'You\u2019re at Ringside \u2014 return to the ring (free action).';
    els.returnRingBtn.style.display = 'block';
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
  else if (state.phase === 'awaiting-escape') next = controller.submitEscape(null);
  render(next);
});
els.continueHoldBtn.addEventListener('click', () => render(controller.submitHoldDecision('continue', null)));
els.releaseHoldBtn.addEventListener('click', () => render(controller.submitHoldDecision('release', null)));
els.tapoutBtn.addEventListener('click', () => render(controller.submitTapOut(true)));
els.returnRingBtn.addEventListener('click', () => render(controller.submitReturnToRing()));
els.newBtn.addEventListener('click', () => startMatch(chosenA, chosenB));
els.changeBtn.addEventListener('click', showSelectScreen);

let roster = null;
let chosenA = null;

async function init() {
  const [cardDb, imgMap, rosterData] = await Promise.all([
    CardDatabase.loadFromUrl('data/cards.json'),
    fetch('data/image_map.json').then((r) => r.json()),
    fetch('data/roster.json').then((r) => r.json()),
  ]);
  db = cardDb;
  imageMap = imgMap;
  roster = rosterData;
  showSelectScreen();
}

function showSelectScreen() {
  els.matchScreen.style.display = 'none';
  els.deckbuilderScreen.style.display = 'none';
  els.selectScreen.style.display = 'flex';
  renderSelectGrid('');
}

function renderSelectGrid(query) {
  els.selectGrid.innerHTML = '';
  const entries = Object.entries(roster)
    .filter(([, info]) => info.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [filename, info] of entries) {
    const card = document.createElement('div');
    card.className = 'select-card' + (filename === chosenA ? ' chosen' : '');
    card.innerHTML = `<img src="images/${info.image}" alt="" /><div class="select-name">${info.name}</div>`;
    card.addEventListener('click', () => {
      chosenA = filename;
      els.selectConfirmBtn.disabled = false;
      renderSelectGrid(els.selectSearch.value);
    });
    els.selectGrid.appendChild(card);
  }
}
els.selectSearch.addEventListener('input', () => renderSelectGrid(els.selectSearch.value));
els.selectConfirmBtn.addEventListener('click', () => {
  if (!chosenA) return;
  showDeckBuilder(chosenA);
});

// Builds one player's collection purely from THEIR OWN real starter
// deck(s) -- confirmed real rule this whole match setup follows: the
// raw starter lists were never meant to be played as-is, they're the
// collection a real deck gets auto-built FROM (see auto-deck-builder.js
// for the Finisher/Trademark-focused strategy itself).
function buildCollectionFor(superstarFilename) {
  const info = roster[superstarFilename];
  const collection = new Collection();
  const counts = {};
  for (const cards of Object.values(info.decks)) {
    for (const f of cards) {
      if (f.startsWith('UNKNOWN_ID_')) continue; // a handful of UNIDs (3 total) never resolved to a real filename during extraction
      counts[f] = (counts[f] || 0) + 1;
    }
  }
  for (const [f, n] of Object.entries(counts)) collection.add(f, n);
  return collection;
}

// ---- Deck builder ----
let dbCollection = null, dbDef = null, dbTab = 'collection', currentDeck = [];

function showDeckBuilder(superstarFilename) {
  chosenA = superstarFilename;
  dbCollection = buildCollectionFor(superstarFilename);
  dbDef = db.get(superstarFilename);
  currentDeck = autoBuildDeck(dbCollection, db, dbDef, { log: () => {} });
  dbTab = 'collection';

  els.selectScreen.style.display = 'none';
  els.deckbuilderScreen.style.display = 'flex';
  els.dbPortrait.src = `images/${roster[superstarFilename].image}`;
  els.dbSuperstarName.textContent = roster[superstarFilename].name;
  setDbTab('collection');
}

function setDbTab(tab) {
  dbTab = tab;
  els.dbTabCollection.classList.toggle('active', tab === 'collection');
  els.dbTabDeck.classList.toggle('active', tab === 'deck');
  renderDeckBuilderList();
}
els.dbTabCollection.addEventListener('click', () => setDbTab('collection'));
els.dbTabDeck.addEventListener('click', () => setDbTab('deck'));
els.dbSearch.addEventListener('input', renderDeckBuilderList);
els.dbBackBtn.addEventListener('click', showSelectScreen);
els.dbAutoBtn.addEventListener('click', () => {
  currentDeck = autoBuildDeck(dbCollection, db, dbDef, { log: () => {} });
  renderDeckBuilderList();
});
els.dbStartBtn.addEventListener('click', () => {
  const others = Object.keys(roster).filter((f) => f !== chosenA);
  const chosenB = others[Math.floor(Math.random() * others.length)];
  els.deckbuilderScreen.style.display = 'none';
  els.matchScreen.style.display = 'block';
  startMatch(chosenA, chosenB, currentDeck);
});

function deckCountByName(filename) {
  const name = db.get(filename)?.name;
  return currentDeck.filter((f) => db.get(f)?.name === name).length;
}

function nonBasicCapReached(filename) {
  const def = db.get(filename);
  if (isMomentumCard(def)) return false;
  return deckCountByName(filename) >= 5;
}

function renderDeckBuilderList() {
  const query = els.dbSearch.value.toLowerCase();
  els.dbCardList.innerHTML = '';

  // Build the set of unique filenames to show, grouped by owned count.
  const filenames = dbTab === 'collection'
    ? [...dbCollection.owned.keys()].filter((f) => dbCollection.countOf(f) > 0)
    : [...new Set(currentDeck)];

  const rows = filenames
    .map((f) => db.get(f))
    .filter((def) => def && def.name.toLowerCase().includes(query))
    .filter((def) => !(def.fields.Hit_Points !== undefined)) // never list the superstar card itself
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const def of rows) {
    const filename = def.filename;
    const owned = dbCollection.countOf(filename);
    const inDeck = currentDeck.filter((f) => f === filename).length;
    const legal = canIncludeInDeck(def, dbDef, db).legal;
    const row = document.createElement('div');
    row.className = 'db-card-row' + (!legal ? ' illegal' : '');
    const img = cardImageUrl(filename);
    const cost = costInfo(def);
    const costText = cost.total ? `Cost ${cost.total}` : (cost.typed ? `Cost ${cost.typed}` : 'No cost');
    row.innerHTML = `
      ${img ? `<img src="${img}" alt="" />` : '<div style="width:40px;height:48px;background:#222;border-radius:4px;flex-shrink:0;"></div>'}
      <div class="db-card-info">
        <div class="db-card-name">${def.name}</div>
        <div class="db-card-meta">${legal ? costText : 'Not legal for this superstar'} \u00b7 Owned: ${owned}</div>
      </div>
      <div class="db-card-count">${inDeck} in deck</div>
      <button class="db-card-btn remove" ${inDeck === 0 ? 'disabled' : ''}>\u2212</button>
      <button class="db-card-btn add" ${(!legal || inDeck >= owned || nonBasicCapReached(filename)) ? 'disabled' : ''}>+</button>
    `;
    row.querySelector('.remove').addEventListener('click', () => {
      const idx = currentDeck.indexOf(filename);
      if (idx !== -1) currentDeck.splice(idx, 1);
      renderDeckBuilderList();
    });
    row.querySelector('.add').addEventListener('click', () => {
      currentDeck.push(filename);
      renderDeckBuilderList();
    });
    els.dbCardList.appendChild(row);
  }

  els.dbDeckCount.textContent = currentDeck.length;
  const validation = validateDeck(currentDeck, db);
  els.dbValidation.textContent = validation.valid
    ? `${currentDeck.length} cards \u2014 legal deck`
    : `${currentDeck.length} cards \u2014 ${validation.errors[0] || 'invalid'}`;
  els.dbValidation.className = validation.valid ? 'valid' : 'invalid';
  els.dbStartBtn.disabled = !validation.valid;
}

function startMatch(superstarA, superstarB, customDeckA = null) {
  chosenA = superstarA;
  const rng = Math.random;
  game = new GameState(db, { log: logLine, rng });
  const hostFns = buildHostFunctions(game);
  interp = new Interpreter(hostFns, { warnOnUnknown: false });

  const collectionA = buildCollectionFor(superstarA);
  const collectionB = buildCollectionFor(superstarB);
  const defA = db.get(superstarA);
  const defB = db.get(superstarB);
  const deckA = customDeckA || autoBuildDeck(collectionA, db, defA, { log: (m) => logLine('[deck A] ' + m) });
  const deckB = autoBuildDeck(collectionB, db, defB, { log: (m) => logLine('[deck B] ' + m) });
  const validA = validateDeck(deckA, db);
  const validB = validateDeck(deckB, db);
  if (!validA.valid) logLine('[deck A] WARNING: ' + validA.errors.join('; '));
  if (!validB.valid) logLine('[deck B] WARNING: ' + validB.errors.join('; '));

  const A = game.addPlayer('A', superstarA, deckA);
  const B = game.addPlayer('B', superstarB, deckB);
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
