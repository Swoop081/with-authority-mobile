// Momentum tracking, confirmed against real gameplay (not inferred).
//
// Confirmed rules (from direct player testimony, 2024-08):
//  - Six momentum types: Strike, Strength, Technical, Agility, Knowledge,
//    Attitude.
//  - Attitude is NOT played from cards. It changes only as a byproduct of
//    combat: +1 when your move connects, -1 when an opponent's move
//    connects on you.
//  - The other five types are banked by playing basic momentum cards
//    (Strike1, Strength1, etc.), one per turn maximum, playable at the
//    start of whichever player currently has control.
//  - Momentum is permanent for the rest of the match -- it is never lost,
//    reset, or (per the player) spent down when a move consumes it as a
//    cost. TODO-CONFIRM: does paying a move's cost actually decrement the
//    banked value, or does the move only require the value to be >= cost
//    while leaving it untouched? The "momentum is permanent, you don't
//    lose it" statement suggests costs are a *threshold check*, not a
//    *spend*. Implemented that way below (canCoverCost is non-destructive)
//    until/unless this is corrected.
//  - Total Momentum = sum of all six values. This is what the generic
//    Momentum_Cost field (seen ranging 0-17 on high-end cards) checks
//    against, distinct from the five typed _Cost fields.

export const MOMENTUM_TYPES = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge', 'Attitude'];

export class MomentumTrack {
  constructor() {
    this.values = { Strike: 0, Strength: 0, Technical: 0, Agility: 0, Knowledge: 0, Attitude: 0 };
    this.momentumPlayedThisTurn = false;
  }

  get(type) {
    return this.values[type] ?? 0;
  }

  total() {
    return MOMENTUM_TYPES.reduce((sum, t) => sum + this.values[t], 0);
  }

  // Called when playing a basic momentum card (Strike1, Strength1, ...).
  // Enforces the "one momentum card per turn" rule. Returns false if the
  // play is not allowed right now.
  playMomentumCard(type, amount = 1) {
    if (type === 'Attitude') {
      throw new Error('Attitude cannot be played directly from a card');
    }
    if (this.momentumPlayedThisTurn) return false;
    this.values[type] += amount;
    this.momentumPlayedThisTurn = true;
    return true;
  }

  // Combat byproduct -- not gated by the once-per-turn rule, and not a
  // player choice. Confirmed: the losing side's Attitude cannot go below 0.
  onOwnMoveConnected() {
    this.values.Attitude += 1;
  }

  onOpponentMoveConnected() {
    this.values.Attitude = Math.max(0, this.values.Attitude - 1);
  }

  // Non-destructive threshold check for playing a move with a given cost.
  // costMap example: { Strike: 1 } or { Momentum: 5 } for the generic cost.
  canCoverCost(costMap) {
    for (const [type, amount] of Object.entries(costMap)) {
      if (amount <= 0) continue;
      if (type === 'Momentum') {
        if (this.total() < amount) return false;
      } else if (this.get(type) < amount) {
        return false;
      }
    }
    return true;
  }

  // Reset the once-per-turn momentum flag; call when control/turn passes
  // to this player.
  resetTurnFlag() {
    this.momentumPlayedThisTurn = false;
  }
}
