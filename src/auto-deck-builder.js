import { isMoveCard, isMomentumCard, isSpecialCard } from './host-functions.js';
import { canIncludeInDeck, DECK_SIZE_MIN, DECK_SIZE_MAX, MAX_COPIES_NON_BASIC } from './deck-rules.js';

// Implements a real, confirmed deck archetype (player's own words, 2024-08,
// validated directly against the card scripts -- e.g. Kick To Gut
// literally searches the whole playbook for the player's Stone Cold
// Stunner or any "victim below" move and draws it on connect, and
// becomes uncounterable once a "leg extended" move has already landed
// this match):
//
//   Pick one Finisher and one Trademark move (both confirmed real,
//   structured Modifiers tags: "Finisher" / "Trademark", gated by
//   Can_Only_Be_Played_By). Build the offense almost entirely from
//   those two Move_Types, so the opponent's Move_Type-specific counters
//   get exhausted before the real hits land. Bank only the momentum
//   types those moves actually need (~15 total). Round out with a wide
//   variety of counters. Roughly 3 copies of each supporting card.
//
// This is a real strategic pattern, not the only legal way to build a
// deck -- it's what the auto-builder uses as its default approach until
// the manual deck-builder screen exists.

function findSuperstarUNID(cardDb, superstarDef) {
  return superstarDef.unid;
}

function cardsWithModifierFor(cardDb, superstarDef, modifier) {
  const unid = superstarDef.unid;
  const baseFilename = superstarDef.filename.replace(/\.gac$/, '').replace(/(2E|EX[1-4]|LE|Tourn|W)$/, '') + '.gac';
  const baseDef = cardDb.get(baseFilename);
  const baseUnid = baseDef ? baseDef.unid : unid;
  const out = [];
  for (const def of cardDb.byFilename.values()) {
    const mods = (def.fields.Modifiers || '').split('|');
    const restriction = def.fields.Can_Only_Be_Played_By;
    if (!restriction) continue;
    const allowed = restriction.split('|').map((s) => s.trim());
    if ((allowed.includes(String(unid)) || allowed.includes(String(baseUnid))) && mods.includes(modifier)) out.push(def);
  }
  return out;
}

function costTypesOf(def) {
  const types = [];
  for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
    if (def.getNumericField(`${t}_Cost`, 0) > 0) types.push(t);
  }
  return types;
}

export function autoBuildDeck(collection, cardDb, superstarDef, { log = () => {} } = {}) {
  const finishers = cardsWithModifierFor(cardDb, superstarDef, 'Finisher');
  const trademarks = cardsWithModifierFor(cardDb, superstarDef, 'Trademark');

  const owned = (def) => collection.countOf(def.filename) > 0;
  // CONFIRMED (player's own observation, validated against real data --
  // Kane genuinely has two distinct Finisher-tagged moves, Tombstone
  // Piledriver and Choke Slam To Hell): when a superstar has multiple
  // real Finisher/Trademark options, each edition should build toward a
  // DIFFERENT one rather than both converging on the same pick -- that's
  // the actual point of there being more than one. Deterministic but
  // edition-distinct: pick based on the specific card filename actually
  // playing this match, not just "first owned".
  function pickVariant(options, ownedOnly) {
    const pool = ownedOnly.length ? ownedOnly : options;
    if (pool.length === 0) return null;
    let hash = 0;
    for (const ch of superstarDef.filename) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return pool[hash % pool.length];
  }
  const finisher = pickVariant(finishers, finishers.filter(owned));
  const trademark = pickVariant(trademarks, trademarks.filter(owned));

  const focusTypes = new Set([finisher?.fields.Move_Type, trademark?.fields.Move_Type].filter(Boolean));
  log(`Deck focus: ${finisher ? finisher.name : '(no finisher owned)'} [${finisher?.fields.Move_Type}] + `
    + `${trademark ? trademark.name : '(no trademark owned)'} [${trademark?.fields.Move_Type}]`);

  // Which momentum types the focus-type moves (plus the finisher/trademark
  // themselves) actually draw on -- both their Method (typed momentum
  // gained on connect) and their own cost types.
  const neededMomentumTypes = new Set();
  for (const [filename, count] of collection.owned) {
    if (count <= 0) continue;
    const def = cardDb.get(filename);
    if (!def || !isMoveCard(def)) continue;
    if (!focusTypes.has(def.fields.Move_Type)) continue;
    if (def.fields.Method) neededMomentumTypes.add(def.fields.Method);
    for (const t of costTypesOf(def)) neededMomentumTypes.add(t);
  }
  if (finisher) { if (finisher.fields.Method) neededMomentumTypes.add(finisher.fields.Method); costTypesOf(finisher).forEach((t) => neededMomentumTypes.add(t)); }
  if (trademark) { if (trademark.fields.Method) neededMomentumTypes.add(trademark.fields.Method); costTypesOf(trademark).forEach((t) => neededMomentumTypes.add(t)); }

  const deck = []; // array of filenames, one entry per copy
  const nameCounts = new Map(); // display-name -> copies added so far (the real cap boundary)
  const addCopies = (filename, count) => {
    const def = cardDb.get(filename);
    const key = def ? def.name : filename;
    const isBasic = def && isMomentumCard(def);
    for (let i = 0; i < count; i++) {
      if (!isBasic) {
        const current = nameCounts.get(key) || 0;
        if (current >= MAX_COPIES_NON_BASIC) break; // confirmed: cap is per NAME, not per filename
        nameCounts.set(key, current + 1);
      }
      deck.push(filename);
    }
  };

  // 1. The finisher and trademark themselves -- every owned copy.
  if (finisher) addCopies(finisher.filename, collection.countOf(finisher.filename));
  if (trademark) addCopies(trademark.filename, collection.countOf(trademark.filename));

  // 1b. Special cards (confirmed real category, includes Entrance cards
  // like Kane's "Hellfire And Brimstone" -- these have no Method field,
  // so none of the other steps below would ever pick them up). Include
  // every owned, legal one -- they're typically unique/flavor-locked,
  // not stacked to 3x like generic moves.
  let specialsAdded = 0;
  for (const [filename, count] of collection.owned) {
    if (count <= 0) continue;
    const def = cardDb.get(filename);
    if (!def || !isSpecialCard(def)) continue;
    if (!canIncludeInDeck(def, superstarDef, cardDb).legal) continue;
    if (deck.includes(filename)) continue;
    addCopies(filename, Math.min(1, count));
    specialsAdded++;
  }
  log(`Specials/Entrance: ${specialsAdded} distinct cards included`);

  // 2. Focus-type offense: ~3 copies of every owned move matching the
  // focus types (respecting ownership, the 5-copy cap, and character
  // legality via canIncludeInDeck).
  const focusCandidates = [];
  for (const [filename, count] of collection.owned) {
    if (count <= 0) continue;
    const def = cardDb.get(filename);
    if (!def || !isMoveCard(def)) continue;
    if (!focusTypes.has(def.fields.Move_Type)) continue;
    if (def === finisher || def === trademark) continue;
    if (!canIncludeInDeck(def, superstarDef, cardDb).legal) continue;
    focusCandidates.push({ def, owned: count });
  }
  for (const { def, owned: n } of focusCandidates) {
    addCopies(def.filename, Math.min(3, n, MAX_COPIES_NON_BASIC));
  }
  log(`Focus-type offense: ${focusCandidates.length} distinct cards from types [${[...focusTypes].join(', ')}]`);

  // 3. Momentum: only the needed types, ~15 total, split evenly.
  const momentumCandidates = [];
  for (const [filename, count] of collection.owned) {
    if (count <= 0) continue;
    const def = cardDb.get(filename);
    if (!def || !isMomentumCard(def)) continue;
    const type = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']
      .find((t) => def.fields[`${t}_Points`]);
    if (type && neededMomentumTypes.has(type)) momentumCandidates.push({ def, owned: count });
  }
  const MOMENTUM_TARGET = 15;
  const perType = Math.ceil(MOMENTUM_TARGET / Math.max(1, momentumCandidates.length));
  let momentumAdded = 0;
  for (const { def, owned: n } of momentumCandidates) {
    if (momentumAdded >= MOMENTUM_TARGET) break;
    const take = Math.min(perType, n, MOMENTUM_TARGET - momentumAdded);
    addCopies(def.filename, take);
    momentumAdded += take;
  }
  log(`Momentum: ${momentumAdded} cards across types [${[...neededMomentumTypes].join(', ')}]`);

  // 4. Counters: wide variety -- one copy each of as many distinct owned
  // counter cards as needed to reach the legal deck-size floor, biased
  // toward covering different Move_Types so the opponent's likely
  // offense is broadly answerable.
  const counterCandidates = [];
  for (const [filename, count] of collection.owned) {
    if (count <= 0) continue;
    const def = cardDb.get(filename);
    if (!def || !isMoveCard(def) || !def.fields.Counters) continue;
    if (!canIncludeInDeck(def, superstarDef, cardDb).legal) continue;
    if (deck.includes(filename)) continue; // don't double up cards already added above
    counterCandidates.push({ def, owned: count });
  }
  const seenCounterTypes = new Set();
  counterCandidates.sort((a, b) => {
    const aCovers = a.def.fields.Counters.split('|').some((t) => !seenCounterTypes.has(t.trim()));
    const bCovers = b.def.fields.Counters.split('|').some((t) => !seenCounterTypes.has(t.trim()));
    return (bCovers ? 1 : 0) - (aCovers ? 1 : 0);
  });
  for (const { def, owned: n } of counterCandidates) {
    if (deck.length >= DECK_SIZE_MAX - 3) break;
    addCopies(def.filename, Math.min(2, n));
    def.fields.Counters.split('|').forEach((t) => seenCounterTypes.add(t.trim()));
  }
  log(`Counters: covering ${seenCounterTypes.size} distinct Move_Types`);

  // 5. Pad to the legal floor if still short, with any other legal,
  // owned, unused cards (generic support). CORRECTED (found via the
  // deck-builder screen, real case: Booker T has 78 cards owned but the
  // first version of this step only produced a 57-card deck): the old
  // version only considered move cards and capped each at 2 extra
  // copies, which could run out of eligible candidates even with a
  // collection well above the legal floor. Now considers momentum and
  // Special cards too, and takes as many legal copies of each candidate
  // as needed (respecting the real per-name cap, enforced inside
  // addCopies) rather than an arbitrary 2-copy ceiling.
  if (deck.length < DECK_SIZE_MIN) {
    for (const [filename, count] of collection.owned) {
      if (deck.length >= DECK_SIZE_MIN) break;
      const def = cardDb.get(filename);
      if (!def) continue;
      if (!(isMoveCard(def) || isMomentumCard(def) || isSpecialCard(def))) continue;
      if (!canIncludeInDeck(def, superstarDef, cardDb).legal) continue;
      const already = deck.filter((f) => f === filename).length;
      const room = count - already;
      const take = Math.min(room, DECK_SIZE_MIN - deck.length);
      if (take > 0) addCopies(filename, take);
    }
  }

  // Trim to the legal ceiling if somehow over.
  while (deck.length > DECK_SIZE_MAX) deck.pop();

  log(`Final deck size: ${deck.length} (legal range ${DECK_SIZE_MIN}-${DECK_SIZE_MAX})`);
  return deck;
}
