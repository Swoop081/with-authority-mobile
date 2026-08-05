// Deck-building rules, confirmed against real starter deck data (2024-08
// player testimony + verification against all 80 extracted decks):
//   - Playbook size is NOT a fixed number -- real starter decks range
//     from 71 to 80 cards (verified directly: sizes cluster 71-78 with
//     one outlier at 80). Enforce a range, not an exact count.
//   - Max 5 copies of any single non-basic card. Verified: zero
//     violations across all 80 real decks once basic momentum cards are
//     excluded.
//   - Basic momentum cards (Strike1/Strength1/Technical1/Knowledge1/
//     Agility1 and their variant printings) are EXEMPT from the 5-copy
//     limit -- real decks run up to 12 copies of a single basic. This
//     mirrors "basic land" in Magic: The Gathering; these cards have no
//     unique identity/synergy value, they're pure resource fixing.
//   - Originally a pay-to-win system: starter decks + booster packs
//     purchased with real money via the deck builder. Since this is an
//     offline recreation with no shop, we're replacing that economy with
//     a post-match reward: win a match, get a random booster pack added
//     to your collection (see collection.js). This is a deliberate
//     design decision for the offline version, not a reproduction of
//     original online behavior.

export const DECK_SIZE_MIN = 71;
export const DECK_SIZE_MAX = 80;
export const MAX_COPIES_NON_BASIC = 5;

const BASIC_MOMENTUM_PATTERN = /^(Strike|Strength|Technical|Knowledge|Agility)\d*(2E|EX\d)?\.gac$/i;

export function isBasicMomentumCard(cardFilename) {
  return BASIC_MOMENTUM_PATTERN.test(cardFilename);
}

// `cardFilenames` is an array of .gac filenames (one entry per copy).
// Character-legality gates, confirmed 2024-08:
//   - Can_Only_Be_Played_By: a real, common restriction (257 of 1,121
//     cards) -- a pipe-separated list of superstar UNIDs. Confirmed
//     example: Stone Cold Stunner -> "2" -> resolves to stsa.gac, which
//     really is Stone Cold's own card. Cards without this field are
//     unrestricted.
//   - {Type}_Maximum on a superstar card gates which move costs of that
//     type are usable. CORRECTED after checking against real deck
//     composition (2024-08): the semantics are the OPPOSITE of the
//     initial reading. 0 (rare, 8 instances across all superstars) is
//     the hard block -- confirmed via Kurt Angle's real card, whose
//     Agility_Maximum is exactly 0, matching a contemporary review
//     ("Kurt Angle... can't use a single agility momentum"). -1 (the
//     most common value, 130 instances) means NO cap -- unlimited --
//     confirmed because Kane's own real starter deck is full of Strike
//     moves despite his Strike_Maximum being -1; if -1 meant "blocked"
//     his own deck would be illegal by his own restriction, which is a
//     contradiction. Positive 1-5 values are real, finite caps.

const EDITION_SUFFIX_RE = /(2E|EX[1-4]|LE|Tourn|W)$/;

// CONFIRMED (2024-08): real scripts distinguish WAGetUNID (exact
// printing) from WAGetBaseUNID (e.g. Stone Cold Stunner's own legality
// check: `(eq (WAGetBaseUNID #initiator) 2)`), and Kane's real Finisher/
// Trademark cards (Tombstone Piledriver, Top Rope Clothesline) are only
// ever restricted to UNID 7 (Kane 1st Edition) even on their own "2E"
// printings -- Kane 2nd Edition (a different UNID, 846) has no
// exclusive Finisher of his own in the data. This only makes sense if
// Can_Only_Be_Played_By is meant to match against the BASE character
// identity (edition suffix stripped), not the exact edition UNID.
// `cardDb`, when supplied, resolves that base UNID; without it this
// falls back to exact-UNID-only matching.
function baseUnidOf(superstarDef, cardDb) {
  if (!cardDb) return superstarDef.unid;
  const baseFilename = superstarDef.filename.replace(/\.gac$/, '').replace(EDITION_SUFFIX_RE, '') + '.gac';
  const baseDef = cardDb.get(baseFilename);
  return baseDef ? baseDef.unid : superstarDef.unid;
}

export function canIncludeInDeck(card, superstarDef, cardDb = null) {
  const restriction = card.fields?.Can_Only_Be_Played_By;
  if (restriction && restriction !== '0' && restriction !== 'Nil') {
    const allowedUnids = restriction.split('|').map((s) => s.trim());
    const baseUnid = baseUnidOf(superstarDef, cardDb);
    if (!allowedUnids.includes(String(superstarDef.unid)) && !allowedUnids.includes(String(baseUnid))) {
      return { legal: false, reason: `Only playable by UNID ${restriction}` };
    }
  }

  for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
    const cost = card.getNumericField ? card.getNumericField(`${t}_Cost`, 0) : Number(card.fields?.[`${t}_Cost`] || 0);
    if (!cost) continue;
    const max = Number(superstarDef.fields?.[`${t}_Maximum`]);
    if (Number.isNaN(max) || max === -1) continue; // -1 == unlimited, no restriction
    if (max === 0) {
      return { legal: false, reason: `${superstarDef.name} cannot use ${t} at all` };
    }
    if (cost > max) {
      return { legal: false, reason: `Needs ${cost} ${t}, but ${superstarDef.name}'s cap is ${max}` };
    }
  }

  return { legal: true, reason: null };
}

export function validateDeck(cardFilenames, cardDb = null) {
  const errors = [];
  const size = cardFilenames.length;

  if (size < DECK_SIZE_MIN || size > DECK_SIZE_MAX) {
    errors.push(`Deck size ${size} is outside the allowed range ${DECK_SIZE_MIN}-${DECK_SIZE_MAX}.`);
  }

  // CONFIRMED (real card, RulesEX1/"No Way Out Rules Page"): "All pages
  // with the exact same name always 'count as' each other" -- the
  // 5-copy cap applies per display NAME (grouping variant printings
  // like 1st/2nd Edition together), not per distinct filename. When a
  // card database is available, group by real name; otherwise fall back
  // to filename grouping (less accurate, but still catches same-file
  // stacking).
  const groupKey = (filename) => {
    if (cardDb) {
      const def = cardDb.get(filename);
      if (def) return def.name;
    }
    return filename;
  };

  const counts = new Map();
  for (const name of cardFilenames) {
    const key = groupKey(name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) {
    if (isBasicMomentumCard(key)) continue;
    if (cardDb) {
      // basic momentum cards' *names* are just "Strike"/"Strength"/etc,
      // which isBasicMomentumCard (filename-pattern-based) won't catch --
      // check the underlying card kind instead when we can.
      const anyFilenameForKey = cardFilenames.find((f) => groupKey(f) === key);
      const def = cardDb.get(anyFilenameForKey);
      if (def && ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge'].some((t) => def.fields[`${t}_Points`])) continue;
    }
    if (count > MAX_COPIES_NON_BASIC) {
      errors.push(`${key}: ${count} copies exceeds the ${MAX_COPIES_NON_BASIC}-copy limit.`);
    }
  }

  return { valid: errors.length === 0, errors, size };
}
