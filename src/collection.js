// Offline progression system.
//
// NOT a reconstruction of original behavior -- this is a deliberate
// design decision for the offline recreation (player's call, 2024-08).
//
// Original game: pay-to-win. Starter decks (fixed) + real-money booster
// packs, opened and added via an online deck builder against a live
// "Collectible Bits" account. Confirmed from real card text: a booster
// contained 15 cards -- Rare/Uncommon/Common with a chance of Very Rare.
// The actual rarity weighting lived server-side and isn't recoverable
// from the client data.
//
// Offline replacement: no purchases, no server. Instead, winning a match
// rewards a random booster pack (15 cards drawn from the full card pool)
// added permanently to the player's collection, which then unlocks more
// options in the deck builder between matches. Uniform random for now,
// since the original rarity weights are unrecoverable -- easy to swap
// for a weighted table later if we ever reconstruct one.

const BOOSTER_SIZE = 15;

export class Collection {
  constructor() {
    this.owned = new Map(); // cardFilename -> count owned
  }

  static fromStarterDeck(cardFilenames) {
    const c = new Collection();
    for (const name of cardFilenames) c.add(name);
    return c;
  }

  add(cardFilename, count = 1) {
    this.owned.set(cardFilename, (this.owned.get(cardFilename) || 0) + count);
  }

  countOf(cardFilename) {
    return this.owned.get(cardFilename) || 0;
  }

  // Checks a proposed deck list (array of filenames, one entry per copy)
  // against what's actually owned.
  canBuildDeck(cardFilenames) {
    const needed = new Map();
    for (const name of cardFilenames) needed.set(name, (needed.get(name) || 0) + 1);
    const shortfalls = [];
    for (const [name, count] of needed) {
      const owned = this.countOf(name);
      if (owned < count) shortfalls.push({ card: name, owned, needed: count });
    }
    return { canBuild: shortfalls.length === 0, shortfalls };
  }
}

// `cardPool` is the full list of available card filenames (e.g. every
// .gac in the extracted set, or a curated subset) to draw from.
export function openBooster(cardPool, { size = BOOSTER_SIZE, rng = Math.random } = {}) {
  const drawn = [];
  for (let i = 0; i < size; i++) {
    const idx = Math.floor(rng() * cardPool.length);
    drawn.push(cardPool[idx]);
  }
  return drawn;
}

// Call after a match win. Mutates `collection` in place and returns the
// booster contents that were awarded, for UI display ("You won a
// booster pack!").
export function awardBoosterForWin(collection, cardPool, options = {}) {
  const contents = openBooster(cardPool, options);
  for (const card of contents) collection.add(card);
  return contents;
}
