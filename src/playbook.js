// Playbook (deck) and hand, confirmed against real gameplay.
//
// CONFIRMED (player testimony, 2024-08):
//   - A playbook is 70 cards.
//   - Starting hand is 5 cards, drawn before play begins.
//   - Each player draws 1 card at the start of their turn.
//   - Some moves/specials grant extra draws when their card text says so
//     (implemented via the WADrawPage/WADrawPageByUNID host functions,
//     not part of the base draw rule here).

export class Playbook {
  constructor(cards, { rng = Math.random } = {}) {
    // `cards` is an array of card objects/refs, length should be 70 for a
    // legal playbook but we don't enforce that here (deck builder's job).
    this.library = [...cards];
    this.hand = [];
    this.discard = [];
    this.rng = rng;
    this.shuffle();
  }

  shuffle() {
    // Fisher-Yates
    for (let i = this.library.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.library[i], this.library[j]] = [this.library[j], this.library[i]];
    }
  }

  draw(n = 1) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      if (this.library.length === 0) break; // deck-out; win-condition hook goes here later
      const card = this.library.shift();
      this.hand.push(card);
      drawn.push(card);
    }
    return drawn;
  }

  drawStartingHand() {
    return this.draw(5);
  }

  playFromHand(card) {
    const idx = this.hand.indexOf(card);
    if (idx === -1) throw new Error('Card not in hand');
    this.hand.splice(idx, 1);
    return card;
  }

  ditch(card) {
    // Cards leaving play via a "ditch" effect go to the discard pile.
    const idx = this.hand.indexOf(card);
    if (idx !== -1) this.hand.splice(idx, 1);
    this.discard.push(card);
  }
}
