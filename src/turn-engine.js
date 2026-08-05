// Turn / exchange resolution.
//
// CONFIRMED (player testimony, 2024-08):
//   While a player has control, they repeat this exchange loop:
//     1. May play at most one momentum card this turn-segment.
//     2. Play a move (must satisfy its cost via momentum.canCoverCost).
//     3. Opponent reacts:
//          a. Opponent has no suitable counter -> presses Pass.
//             - Move connects.
//             - Controlling player: Attitude +1.
//             - Opponent: Attitude -1, floored at 0.
//             - Control REMAINS with the controlling player; loop back
//               to step 1 (fresh momentum-card opportunity + next move).
//          b. Opponent plays a counter -- either a general reversal
//             (Duck/Dodge/Block-type card) or a specific "counters X"
//             card matching the move's type/modifier.
//             - Control FLIPS to the countering player.
//             - No Attitude change for either side (Attitude only moves
//               on a connected/passed-through move).
//             - Some counter cards deal damage back to the original
//               attacker if the card specifies it (applyCounterDamage).
//             - The countering player (now in control) can immediately
//               play a momentum card then a move -- the cycle repeats
//               exactly as in step 1, just with roles swapped.

export class ExchangeEngine {
  constructor(playerA, playerB, { log = console.log } = {}) {
    this.players = { A: playerA, B: playerB };
    this.log = log;
  }

  other(id) {
    return id === 'A' ? 'B' : 'A';
  }

  // Called once at the moment a player gains control (start of match, or
  // after a control change once we implement the counter branch).
  startControl(playerId) {
    this.players[playerId].momentum.resetTurnFlag();
  }

  // Checks whether `playerId` is forced to pass this turn due to stun.
  // Confirmed: stun is a skip-turn -- while stunned, Pass is the only
  // legal action, and the stun clears after this turn is consumed.
  mustPassDueToStun(playerId) {
    const player = this.players[playerId];
    if (player.isStunned && player.isStunned()) {
      player.consumeStunnedTurn();
      return true;
    }
    return false;
  }

  // `move` is a resolved card object with a costMap and connect effects.
  // `reaction` describes the opponent's response for this prototype:
  //   { type: 'pass' } | { type: 'counter', card: ... }  (counter TODO)
  resolveMove(attackerId, move, reaction) {
    const attacker = this.players[attackerId];
    const defenderId = this.other(attackerId);
    const defender = this.players[defenderId];

    if (this.mustPassDueToStun(attackerId)) {
      // TODO-CONFIRM: control-on-stunned-pass is an assumption, not yet
      // confirmed -- treating it like an ordinary pass (control goes to
      // the other player) since that's the only pattern established so
      // far, but this hasn't been explicitly verified.
      this.log(`${attackerId} is stunned and must pass. Stun cleared.`);
      return { result: 'stunned-pass', control: defenderId, stunCleared: true };
    }

    if (!attacker.momentum.canCoverCost(move.costMap)) {
      throw new Error(`${attackerId} cannot cover cost for ${move.name}`);
    }

    if (reaction.type === 'pass') {
      // Confirmed branch.
      attacker.momentum.onOwnMoveConnected();
      defender.momentum.onOpponentMoveConnected();
      this.log(`${move.name} connects. ${attackerId} Attitude -> ${attacker.momentum.get('Attitude')}, ` +
               `${defenderId} Attitude -> ${defender.momentum.get('Attitude')}`);
      if (typeof move.applyDamage === 'function') {
        move.applyDamage(attacker, defender);
      }
      // Control remains with attacker -- fresh momentum opportunity.
      this.startControl(attackerId);
      return { result: 'connected', control: attackerId };
    }

    if (reaction.type === 'counter') {
      // Confirmed: control flips to the countering player. No Attitude
      // change on a counter -- Attitude only moves on a connected
      // (passed-through) move. Some counter cards deal damage back to
      // the original attacker if the card specifies it.
      this.log(`${defenderId} counters ${move.name} with ${reaction.card?.name}. Control flips to ${defenderId}.`);
      if (reaction.card && typeof reaction.card.applyCounterDamage === 'function') {
        reaction.card.applyCounterDamage(defender, attacker);
      }
      this.startControl(defenderId);
      return { result: 'countered', control: defenderId };
    }

    throw new Error('Unknown reaction type: ' + reaction.type);
  }
}
