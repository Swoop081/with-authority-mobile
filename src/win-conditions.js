// Win conditions, confirmed against real gameplay (2024-08) plus direct
// script evidence pulled from real cards:
//   1. Pin -- CONFIRMED mechanic: requires the target to be "on the mat"
//      (WASetOnMat/WAGetOnMat, set by specific moves), then a pin is
//      attempted via WAPinSuperstar. Pinning is probabilistic -- cards
//      reference modifiers like "+35% pin chance bonus" -- and a failed
//      pin removes the target from the mat (confirmed by card text) but
//      keeps the attacker in control. TODO-CONFIRM: the base pin-success
//      percentage itself isn't visible in any card data.
//   2. Submission -- opponent taps out while a hold is active (see
//      submission.js).
//   3. Disqualification -- CONFIRMED mechanic and exact formula, pulled
//      directly from the real "DQ Warning" card text: "Once you receive
//      5 or more Warnings you have a 5% chance per warning of being
//      Disqualified." Warnings are added via WAWarn(player, amount) by
//      specific cards (Eye Rake +2, Chair Shot +4/+5, etc.). A separate
//      "Distract The Referee" card confirms the referee can be distracted
//      for 2-7 turns, during which warnings aren't given, pins aren't
//      counted, and submissions aren't accepted.
//   4. Count-out -- confirmed to exist. Exact trigger conditions
//      (presumably being outside the ring for N turns) not yet confirmed.
//   5. Turn limit -- 50 turns. If nobody has won by then, the match ends
//      in a draw.

export const TURN_LIMIT = 50;

// HP-scaled pin chance curve (tuning constant, not extracted from real
// data -- see attemptPin's comment for why). At full health: 8% --
// pinning someone who hasn't been touched should almost never work. At
// 0 HP: 80% -- should be close to a formality by then. Linear between.
export function hpScaledPinChance(defender) {
  const hpFraction = Math.max(0, Math.min(1, defender.hitPoints / defender.maxHitPoints));
  const MIN_CHANCE = 0.08;
  const MAX_CHANCE = 0.80;
  return MIN_CHANCE + (MAX_CHANCE - MIN_CHANCE) * (1 - hpFraction);
}

export const WinReason = Object.freeze({
  PIN: 'pin',
  SUBMISSION: 'submission',
  DISQUALIFICATION: 'disqualification',
  COUNT_OUT: 'count_out',
  DRAW: 'draw',
});

export class MatchResult {
  constructor(winnerId, reason) {
    this.winnerId = winnerId; // null for a draw
    this.reason = reason;
  }
}

// Referee state, confirmed directly from the real "Distract The Referee"
// card script: while distracted (a random 2-7 turn duration: WARandom(1,6)+1),
// the referee "does not give warnings, count pins or accept submissions"
// -- confirmed via that card's Can_Pin/Can_Warn/Can_Submit fields all
// being set to Nil while it's in play. Duration ticks down once per turn
// (Begin_Refresh) and the effect ends early if a Referee-type Special is
// played by the other side.
export class RefereeState {
  constructor() {
    this.distractedTurnsRemaining = 0;
  }

  isDistracted() {
    return this.distractedTurnsRemaining > 0;
  }

  distract(turns) {
    this.distractedTurnsRemaining = turns;
  }

  tickTurn() {
    if (this.distractedTurnsRemaining > 0) this.distractedTurnsRemaining -= 1;
  }

  canGiveWarnings() {
    return !this.isDistracted();
  }

  canCountPin() {
    return !this.isDistracted();
  }

  canAcceptSubmission() {
    return !this.isDistracted();
  }
}

export class WinConditionTracker {
  constructor({ log = console.log, rng = Math.random, referee = new RefereeState() } = {}) {
    this.log = log;
    this.rng = rng;
    this.referee = referee;
    this.result = null; // set once the match ends
  }

  isOver() {
    return this.result !== null;
  }

  checkTurnLimit(currentTurn) {
    if (this.isOver()) return this.result;
    if (currentTurn >= TURN_LIMIT) {
      this.result = new MatchResult(null, WinReason.DRAW);
      this.log(`Turn ${currentTurn} reached with no winner -- match ends in a draw.`);
    }
    return this.result;
  }

  // Adds warnings to `player` (a Player instance) if the referee isn't
  // distracted, per WAWarn's real usage (e.g. Eye Rake +2, Chair Shot
  // +4/+5). Confirmed formula: once warnings >= 5, there's a 5% chance
  // PER WARNING of DQ. TODO-CONFIRM: exact roll timing -- rolled here,
  // immediately after the warning is added, until we learn otherwise.
  addWarnings(playerId, player, opponentId, amount) {
    if (this.isOver()) return this.result;
    if (!this.referee.canGiveWarnings()) {
      this.log(`Referee is distracted -- ${amount} warning(s) on ${playerId} not given.`);
      return this.result;
    }
    player.addWarnings(amount);
    this.log(`${playerId} receives ${amount} warning(s), total ${player.warnings}.`);
    if (player.warnings >= 5) {
      const chance = 0.05 * player.warnings;
      const dq = this.rng() < chance;
      this.log(`DQ roll for ${playerId}: ${(chance * 100).toFixed(0)}% chance -- ${dq ? 'DISQUALIFIED' : 'survives'}.`);
      if (dq) {
        this.declareDisqualification(opponentId);
      }
    }
    return this.result;
  }

  // `defender` must expose isOnMat(). `basePinChance` is a TUNING
  // VALUE, not extracted from data (the real formula is lost -- it
  // lived in the compiled WAPinSuperstar implementation). CORRECTED
  // (2024-08, from real playtesting): a flat 50% regardless of how much
  // damage had actually been dealt was letting matches end by pinfall
  // with the opponent still above 50 HP (out of 75), making health feel
  // irrelevant. Replaced with an HP-scaled curve: pinning a fresh
  // opponent is genuinely hard, pinning someone nearly finished is
  // genuinely likely. Cards' own "+35% pin chance" style bonuses still
  // stack on top via `bonusChance`.
  // (0-1) until the real formula is confirmed; `bonusChance` lets a
  // specific card's modifier (e.g. "+35%") be applied on top.
  //
  // CONFIRMED (2024-08): a pin attempt is NOT a bare probability roll --
  // the defender gets the same pass-or-react window as a regular move
  // first. If they have (and choose to play) a pin-breaking card (e.g.
  // "Grab The Ropes", "That Was Three!"), the pin is cancelled entirely
  // and no roll happens at all. Only if the defender passes does the
  // percentage roll occur. `reaction` mirrors ExchangeEngine.resolveMove:
  //   { type: 'pass' } | { type: 'counter', card }
  //
  // Real cards differ on what happens to control after a cancelled pin:
  //   - "Grab The Ropes": attacker KEEPS control, just can't re-attempt
  //     the pin until another move is played.
  //   - "That Was Three!": control FLIPS to the defender (its own script
  //     calls WAChangeControl).
  // This is per-card, not a uniform rule -- once real card scripts run
  // through the interpreter, each card's own effect decides the outcome.
  // For now, a cancelled pin just reports 'pin-countered' and leaves
  // control resolution to the caller/card script.
  attemptPin(attackerId, defender, reaction, { basePinChance = null, bonusChance = 0 } = {}) {
    if (this.isOver()) return { success: false, result: this.result };
    if (!this.referee.canCountPin()) {
      this.log(`Referee is distracted -- pin attempt on ${defender.id} not counted.`);
      return { success: false, result: this.result, refereeDistracted: true };
    }
    if (!defender.isOnMat()) {
      throw new Error('Cannot attempt a pin -- target is not on the mat');
    }
    if (reaction && reaction.type === 'counter') {
      this.log(`${defender.id} plays ${reaction.card?.name} -- pin attempt cancelled, no roll. ` +
               `(Control outcome depends on the specific card's own effect.)`);
      return { success: false, result: this.result, cancelled: true, card: reaction.card };
    }
    const base = basePinChance !== null ? basePinChance : hpScaledPinChance(defender);
    const chance = Math.min(1, Math.max(0, base + bonusChance));
    const success = this.rng() < chance;
    if (success) {
      this.declarePin(attackerId);
    } else {
      // Confirmed: a failed pin removes the target from the mat, but the
      // attacker stays in control.
      defender.setOnMat(false);
      this.log(`Pin attempt on ${defender.id} fails (chance was ${(chance * 100).toFixed(0)}%). ` +
               `${defender.id} is removed from the mat. ${attackerId} stays in control.`);
    }
    return { success, result: this.result };
  }

  declarePin(winnerId) {
    if (this.isOver()) return this.result;
    this.result = new MatchResult(winnerId, WinReason.PIN);
    this.log(`${winnerId} wins by pinfall.`);
    return this.result;
  }

  declareSubmission(winnerId) {
    if (this.isOver()) return this.result;
    this.result = new MatchResult(winnerId, WinReason.SUBMISSION);
    this.log(`${winnerId} wins by submission.`);
    return this.result;
  }

  declareDisqualification(winnerId) {
    if (this.isOver()) return this.result;
    this.result = new MatchResult(winnerId, WinReason.DISQUALIFICATION);
    this.log(`${winnerId} wins by disqualification.`);
    return this.result;
  }

  declareCountOut(winnerId) {
    if (this.isOver()) return this.result;
    this.result = new MatchResult(winnerId, WinReason.COUNT_OUT);
    this.log(`${winnerId} wins by count-out.`);
    return this.result;
  }
}
