import { Zone } from './page-instance.js';
import { isMoveCard, isMomentumCard, isSpecialCard } from './host-functions.js';
import { Location } from './location.js';
import { hpScaledPinChance } from './win-conditions.js';

// Wraps a GameLoop (unchanged, still the AI engine) and adds a pausable
// state machine for a human player. Every rule -- cost checks, legality,
// Move_Type "defensive" exclusion, the free pin action, HP-scaled pin
// chance, the strategic pin threshold for the AI side, warnings/DQ
// avoidance, count-out ticking -- is the exact same tested logic, just
// invoked with an early-return instead of an automatic AI choice
// whenever the human is the one who needs to decide.
//
// SCOPE (v1): submission hold escapes/continue-release, tap-out, and
// ringside return-to-ring stay automatic for BOTH players, same as they
// already were. Making those interactive too is a natural follow-up,
// not included here to keep the first playable version manageable.
const PIN_ATTEMPT_THRESHOLD = 0.45;

export class MatchController {
  constructor(game, loop, { humanPlayerId = 'A' } = {}) {
    this.game = game;
    this.loop = loop;
    this.humanPlayerId = humanPlayerId;
    this.phase = 'idle'; // idle | awaiting-action | awaiting-reaction | awaiting-pin-reaction | match-over
    this.ctx = null;
  }

  isHumanTurn() {
    return this.game.controlPlayerId === this.humanPlayerId;
  }

  // Drives the match forward (AI turns happen instantly, in a loop)
  // until either the match ends or the human needs to make a decision.
  // Call this once after setup, and again after every submit* call.
  advance() {
    let guard = 0;
    while (this.phase === 'idle' && guard < 1000) {
      this.step();
      guard++;
    }
    return this.describe();
  }

  // A snapshot of what's needed right now, for the UI to render.
  describe() {
    if (this.phase === 'match-over') {
      return { phase: 'match-over', result: this.game.winTracker.result };
    }
    if (this.phase === 'awaiting-action') {
      const { attackerId, defenderId } = this.ctx;
      const attacker = this.game.players[attackerId];
      const defender = this.game.players[defenderId];
      return {
        phase: 'awaiting-action',
        playerId: attackerId,
        canPlayMomentum: !attacker.momentum.momentumPlayedThisTurn
          && attacker.playbook.hand.some((pg) => isMomentumCard(pg.def)),
        legalMoves: this.getLegalMoves(attacker, defender),
        canAttemptPin: defender.isOnMat(),
      };
    }
    if (this.phase === 'awaiting-reaction') {
      const { defenderId, movePage } = this.ctx;
      const defender = this.game.players[defenderId];
      const attacker = this.game.players[this.ctx.attackerId];
      return {
        phase: 'awaiting-reaction',
        playerId: defenderId,
        incomingMove: movePage,
        legalCounters: this.getLegalCounters(defender, movePage, attacker),
      };
    }
    if (this.phase === 'awaiting-pin-reaction') {
      const { defenderId, attackerId } = this.ctx;
      const defender = this.game.players[defenderId];
      const attacker = this.game.players[attackerId];
      return {
        phase: 'awaiting-pin-reaction',
        playerId: defenderId,
        legalBreakers: this.getLegalPinBreakers(defender, attacker),
      };
    }
    if (this.phase === 'awaiting-escape') {
      const { holdPlayerId, holderId, hold } = this.ctx;
      const player = this.game.players[holdPlayerId];
      const holder = this.game.players[holderId];
      return {
        phase: 'awaiting-escape',
        playerId: holdPlayerId,
        holdMoveName: hold.movePage.name,
        bodyPart: hold.part,
        legalEscapes: this.getLegalCounters(player, hold.movePage, holder),
      };
    }
    if (this.phase === 'awaiting-hold-decision') {
      const { holderId, holdPlayerId, hold } = this.ctx;
      const holder = this.game.players[holderId];
      return {
        phase: 'awaiting-hold-decision',
        playerId: holderId,
        trappedPlayerId: holdPlayerId,
        holdMoveName: hold.movePage.name,
        hand: holder.playbook.hand,
        canContinue: holder.playbook.hand.length > 3,
      };
    }
    if (this.phase === 'awaiting-tapout') {
      const { holdPlayerId, hold } = this.ctx;
      const player = this.game.players[holdPlayerId];
      return {
        phase: 'awaiting-tapout',
        playerId: holdPlayerId,
        bodyPart: hold.part,
        bodyPartDamage: player.submission.damage[hold.part],
        hitPoints: player.hitPoints,
        maxHitPoints: player.maxHitPoints,
      };
    }
    if (this.phase === 'awaiting-ringside') {
      const { attackerId, defenderId } = this.ctx;
      const attacker = this.game.players[attackerId];
      const opponent = this.game.players[defenderId];
      return {
        phase: 'awaiting-ringside',
        playerId: attackerId,
        // A Ringside-eligible move, if they have one, is a real
        // alternative to returning immediately -- rare, but real.
        ringsideMoves: attacker.playbook.hand.filter((pg) =>
          isMoveCard(pg.def) && this.loop.isLegalToPlay(pg, attacker, opponent)),
      };
    }
    return { phase: this.phase };
  }

  // ---- legality helpers (read-only, mirror the AI's candidate lists) ----

  getLegalMoves(player, opponent) {
    return player.playbook.hand.filter((pg) => {
      if (isSpecialCard(pg.def)) return this.loop.isLegalToPlay(pg, player, opponent);
      if (!isMoveCard(pg.def)) return false;
      if (pg.def.fields.Move_Type === 'defensive') return false;
      return this.loop.isLegalToPlay(pg, player, opponent);
    });
  }

  getLegalCounters(defender, movePage, attacker) {
    const moveType = movePage.def.fields.Move_Type;
    if (!moveType) return [];
    return defender.playbook.hand.filter((pg) => {
      const counters = (pg.def.fields.Counters || '').split('|').map((s) => s.trim().toLowerCase());
      return counters.includes(moveType.toLowerCase()) && this.loop.isLegalToPlay(pg, defender, attacker);
    });
  }

  getLegalPinBreakers(defender, attacker) {
    const hasBreakPin = (pg) => ['Page_Played', 'Move_Connected'].some((field) => {
      const src = pg.def.fields[field];
      return typeof src === 'string' && src.includes('WABreakPin');
    });
    return defender.playbook.hand.filter((pg) => hasBreakPin(pg) && this.loop.isLegalToPlay(pg, defender, attacker));
  }

  // ---- the driving step (only ever called while phase === 'idle') ----

  processHoldsInteractive(startIndex = 0) {
    const order = ['A', 'B'];
    for (let i = startIndex; i < order.length; i++) {
      const id = order[i];
      const player = this.game.players[id];
      const hold = player.submission.activeHold;
      if (!hold || !hold.movePage) continue;
      const holderId = hold.applierId;
      const holder = this.game.players[holderId];

      // 1. Escape attempt (trapped player plays a reversal card, if any).
      if (id === this.humanPlayerId) {
        this.ctx = { holdPlayerId: id, holderId, hold, resumeIndex: i };
        this.phase = 'awaiting-escape';
        return true;
      }
      const escapeCard = this.loop.chooseCounter(player, hold.movePage, holder);
      if (!this.resolveEscapeAttempt(id, holderId, hold, escapeCard)) continue;

      // 2. Holder's continue/release decision.
      if (holderId === this.humanPlayerId) {
        this.ctx = { holdPlayerId: id, holderId, hold, resumeIndex: i };
        this.phase = 'awaiting-hold-decision';
        return true;
      }
      if (!this.resolveHolderDecisionAI(holderId, hold)) continue;

      // 3. Tap-out decision (only reached if the holder continued).
      if (id === this.humanPlayerId) {
        this.ctx = { holdPlayerId: id, holderId, hold, resumeIndex: i };
        this.phase = 'awaiting-tapout';
        return true;
      }
      this.resolveTapOutAI(id, hold);
    }
    return false;
  }

  // Returns true if the hold is STILL active after the escape attempt
  // (false means it ended -- either the escape landed or the move's own
  // No_Counter_Played script ended it).
  resolveEscapeAttempt(id, holderId, hold, escapeCard) {
    const player = this.game.players[id];
    const holder = this.game.players[holderId];
    if (escapeCard) {
      player.playbook.playFromHand(escapeCard);
      player.playbook.discard.push(escapeCard);
      this.loop.holds.reverseHold(id);
      this.game.log(`${id} escapes the hold with ${escapeCard.name}.`);
      return false;
    }
    const ctx = this.loop.baseCtx(hold.movePage, player.superstarPage, holder.superstarPage);
    this.loop.runScript(hold.movePage.def, 'No_Counter_Played', ctx);
    if (!player.submission.activeHold) {
      this.game.log(`${id}'s hold ended via its own escape-chance script.`);
      return false;
    }
    return true;
  }

  // AI holder logic (unchanged heuristic): continue if they have spare
  // cards, otherwise release. Returns true if continued.
  resolveHolderDecisionAI(holderId, hold) {
    const holder = this.game.players[holderId];
    if (holder.playbook.hand.length > 3) {
      const cardToDitch = this.loop.pickLeastValuableCard(holder.playbook.hand);
      this.loop.holds.continueHold(holderId, cardToDitch);
      return true;
    }
    this.loop.holds.releaseHold(holderId);
    return false;
  }

  // TODO-CONFIRM (same placeholder heuristic as before): tap-out is
  // confirmed to be a player choice, but the exact judgment threshold
  // for the AI isn't -- kept as-is here, only the human side is now a
  // real choice.
  resolveTapOutAI(id, hold) {
    const player = this.game.players[id];
    const partDamage = player.submission.damage[hold.part];
    if (partDamage >= 20 && player.hitPoints < player.maxHitPoints * 0.3) {
      const result = this.loop.holds.tapOut(id);
      this.game.winTracker.declareSubmission(result.winner);
    }
  }

  // Continues processing after the escape stage of player `id`'s hold
  // has been resolved (hold confirmed still active). Returns true if
  // this paused for a new human decision.
  continueAfterEscape(id, holderId, hold, resumeIndex) {
    if (holderId === this.humanPlayerId) {
      this.ctx = { holdPlayerId: id, holderId, hold, resumeIndex };
      this.phase = 'awaiting-hold-decision';
      return true;
    }
    const continued = this.resolveHolderDecisionAI(holderId, hold);
    if (!continued) return this.processHoldsInteractive(resumeIndex + 1);
    return this.continueAfterHolderContinues(id, hold, resumeIndex);
  }

  // Continues after the holder has decided to keep the hold applied.
  continueAfterHolderContinues(id, hold, resumeIndex) {
    if (id === this.humanPlayerId) {
      this.ctx = { holdPlayerId: id, holderId: hold.applierId, hold, resumeIndex };
      this.phase = 'awaiting-tapout';
      return true;
    }
    this.resolveTapOutAI(id, hold);
    return this.processHoldsInteractive(resumeIndex + 1);
  }

  // Shared tail: everything that happens once all holds for this
  // exchange are resolved. Used both by the normal step() and by every
  // hold-resolver below once they're done.
  continueTurnAfterHolds(attackerId, defenderId) {
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];

    if (attacker.isStunned()) {
      attacker.consumeStunnedTurn();
      this.game.log(`${attackerId} is stunned and passes. Control flips to ${defenderId}.`);
      this.game.controlPlayerId = defenderId;
      this.finishExchange(defenderId);
      return;
    }

    if (attacker.locationState.isRingside()) {
      if (attackerId === this.humanPlayerId) {
        this.ctx = { attackerId, defenderId };
        this.phase = 'awaiting-ringside';
        return;
      }
      attacker.locationState.moveTo(Location.IN_RING);
      this.game.log(`${attackerId} returns to the ring (count reset).`);
    }

    this.loop.maybeDraw(attacker);

    if (attackerId === this.humanPlayerId) {
      this.ctx = { attackerId, defenderId };
      this.phase = 'awaiting-action';
      return;
    }

    this.loop.maybePlayMomentum(attacker);

    if (defender.isOnMat() && hpScaledPinChance(defender) >= PIN_ATTEMPT_THRESHOLD) {
      this.beginPinAttempt(attackerId, defenderId);
      return;
    }

    const movePage = this.loop.chooseMove(attacker, defender);
    if (!movePage) {
      this.game.log(`${attackerId} has no legal move -- passes. Control flips to ${defenderId}.`);
      this.game.controlPlayerId = defenderId;
      this.finishExchange(defenderId);
      return;
    }
    this.beginMove(attackerId, defenderId, movePage);
  }

  step() {
    this.game.turn += 1;
    const attackerId = this.game.controlPlayerId;
    const defenderId = this.game.other(attackerId);
    this.game.log(`\n--- Turn ${this.game.turn}: ${attackerId} in control ---`);

    if (this.game.winTracker.checkTurnLimit(this.game.turn)) { this.phase = 'match-over'; return; }

    if (this.processHoldsInteractive()) return; // paused for human input
    if (this.game.winTracker.isOver()) { this.phase = 'match-over'; return; }

    this.continueTurnAfterHolds(attackerId, defenderId);
  }

  beginMove(attackerId, defenderId, movePage) {
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];

    if (isSpecialCard(movePage.def) && !movePage.def.hasScript('Move_Connected') && !movePage.def.getNumericField('Damage', 0)) {
      this.loop.resolveSpecialCard(attacker, defender, movePage);
      this.finishExchange(attackerId); // uncontested -- control stays
      return;
    }

    attacker.playbook.playFromHand(movePage);
    movePage.zone = Zone.IN_PLAY;
    movePage.playedByPlayerId = attackerId;
    movePage.playedOnTurn = this.game.turn;
    this.game.log(`${attackerId} plays ${movePage.name}.`);

    if (defenderId === this.humanPlayerId) {
      this.ctx = { attackerId, defenderId, movePage };
      this.phase = 'awaiting-reaction';
      return;
    }

    const counterPage = this.loop.chooseCounter(defender, movePage, attacker);
    this.resolveMove(attackerId, defenderId, movePage, counterPage);
  }

  resolveMove(attackerId, defenderId, movePage, counterPage) {
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];
    if (counterPage) {
      defender.playbook.playFromHand(counterPage);
      this.game.log(`${defenderId} counters with ${counterPage.name}. Control flips to ${defenderId}.`);
      const baseDamage = counterPage.def.getNumericField('Damage', 0);
      let damage = 0;
      if (baseDamage > 0 && !this.loop.isDamagePrevented(defender, attacker, counterPage)) {
        damage = this.loop.computeFinalDamage(defender, attacker, counterPage, baseDamage);
        attacker.hitPoints = Math.max(0, attacker.hitPoints - damage);
      }
      const ctx = this.loop.baseCtx(counterPage, defender.superstarPage, attacker.superstarPage);
      this.loop.runScript(counterPage.def, 'Move_Connected', ctx);
      if (damage) this.game.log(`${counterPage.name} (counter) deals ${damage} damage. ${attackerId} HP -> ${attacker.hitPoints}.`);
      attacker.playbook.discard.push(movePage);
      defender.playbook.discard.push(counterPage);
      this.game.controlPlayerId = defenderId;
      defender.momentum.resetTurnFlag();
      this.finishExchange(defenderId);
      return;
    }

    attacker.momentum.onOwnMoveConnected();
    defender.momentum.onOpponentMoveConnected();
    this.loop.applyMoveEffects(attacker, defender, movePage);
    attacker.playbook.discard.push(movePage);
    attacker.momentum.resetTurnFlag();
    this.finishExchange(attackerId);
  }

  beginPinAttempt(attackerId, defenderId) {
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];
    this.game.log(`${attackerId} goes for a pin on ${defenderId} (on the mat).`);

    if (defenderId === this.humanPlayerId) {
      this.ctx = { attackerId, defenderId };
      this.phase = 'awaiting-pin-reaction';
      return;
    }

    const result = this.loop.attemptFreePin(attacker, defender);
    this.finishExchange(result.control);
  }

  finishExchange(control) {
    if (!this.game.winTracker.isOver()) this.loop.tickCountOuts();
    this.game.controlPlayerId = this.game.winTracker.isOver() ? this.game.controlPlayerId : control;
    this.phase = this.game.winTracker.isOver() ? 'match-over' : 'idle';
    this.ctx = null;
  }

  // ---- resolvers the UI calls in response to a human decision ----

  submitMomentum(instanceId) {
    if (this.phase !== 'awaiting-action') return this.describe();
    const { attackerId } = this.ctx;
    const player = this.game.players[attackerId];
    const card = player.playbook.hand.find((pg) => pg.instanceId === instanceId);
    if (!card || !isMomentumCard(card.def) || player.momentum.momentumPlayedThisTurn) return this.describe();
    const type = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']
      .find((t) => card.def.fields[`${t}_Points`]);
    if (!type) return this.describe();
    player.momentum.playMomentumCard(type, 1);
    player.playbook.playFromHand(card);
    card.zone = Zone.DISCARD;
    player.playbook.discard.push(card);
    this.game.log(`${attackerId} plays momentum: +1 ${type}.`);
    return this.describe(); // still 'awaiting-action' -- can now also play a move
  }

  submitMove(instanceId) {
    if (this.phase !== 'awaiting-action') return this.describe();
    const { attackerId, defenderId } = this.ctx;
    const player = this.game.players[attackerId];
    const movePage = player.playbook.hand.find((pg) => pg.instanceId === instanceId);
    if (!movePage) return this.describe();
    this.beginMove(attackerId, defenderId, movePage);
    return this.advance();
  }

  submitPin() {
    if (this.phase !== 'awaiting-action') return this.describe();
    const { attackerId, defenderId } = this.ctx;
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];
    if (!defender.isOnMat()) return this.describe();
    this.game.log(`${attackerId} goes for a pin on ${defenderId} (on the mat).`);
    const result = this.loop.attemptFreePin(attacker, defender);
    this.finishExchange(result.control);
    return this.advance();
  }

  submitPass() {
    if (this.phase !== 'awaiting-action') return this.describe();
    const { attackerId, defenderId } = this.ctx;
    this.game.log(`${attackerId} passes. Control flips to ${defenderId}.`);
    this.game.controlPlayerId = defenderId;
    this.finishExchange(defenderId);
    return this.advance();
  }

  submitCounter(instanceId) {
    if (this.phase !== 'awaiting-reaction') return this.describe();
    const { attackerId, defenderId, movePage } = this.ctx;
    const defender = this.game.players[defenderId];
    const counterPage = instanceId ? defender.playbook.hand.find((pg) => pg.instanceId === instanceId) : null;
    this.resolveMove(attackerId, defenderId, movePage, counterPage);
    return this.advance();
  }

  submitPinReaction(instanceId) {
    if (this.phase !== 'awaiting-pin-reaction') return this.describe();
    const { attackerId, defenderId } = this.ctx;
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];

    if (instanceId) {
      const breaker = defender.playbook.hand.find((pg) => pg.instanceId === instanceId);
      if (breaker) {
        defender.playbook.playFromHand(breaker);
        defender.playbook.discard.push(breaker);
        const ctx = this.loop.baseCtx(breaker, defender.superstarPage, attacker.superstarPage);
        this.loop.runScript(breaker.def, breaker.def.hasScript('Page_Played') ? 'Page_Played' : 'Move_Connected', ctx);
        this.game.log(`${defenderId} breaks the pin attempt with ${breaker.name}.`);
        this.finishExchange(this.game.controlPlayerId);
        return this.advance();
      }
    }

    const result = this.game.winTracker.attemptPin(attackerId, defender, { type: 'pass' });
    if (result.result) {
      this.finishExchange(null);
    } else {
      this.finishExchange(attackerId); // failed pin -- confirmed attacker stays in control
    }
    return this.advance();
  }

  submitEscape(instanceId) {
    if (this.phase !== 'awaiting-escape') return this.describe();
    const { holdPlayerId, holderId, hold, resumeIndex } = this.ctx;
    const player = this.game.players[holdPlayerId];
    const escapeCard = instanceId ? player.playbook.hand.find((pg) => pg.instanceId === instanceId) : null;
    const stillActive = this.resolveEscapeAttempt(holdPlayerId, holderId, hold, escapeCard);
    const paused = stillActive
      ? this.continueAfterEscape(holdPlayerId, holderId, hold, resumeIndex)
      : this.processHoldsInteractive(resumeIndex + 1);
    if (!paused) {
      if (this.game.winTracker.isOver()) { this.phase = 'match-over'; return this.describe(); }
      const attackerId = this.game.controlPlayerId;
      this.continueTurnAfterHolds(attackerId, this.game.other(attackerId));
    }
    return this.advance();
  }

  submitHoldDecision(action, ditchInstanceId) {
    if (this.phase !== 'awaiting-hold-decision') return this.describe();
    const { holdPlayerId, holderId, hold, resumeIndex } = this.ctx;
    const holder = this.game.players[holderId];
    let continued = false;
    if (action === 'continue') {
      const card = ditchInstanceId
        ? holder.playbook.hand.find((pg) => pg.instanceId === ditchInstanceId)
        : this.loop.pickLeastValuableCard(holder.playbook.hand);
      if (card) {
        this.loop.holds.continueHold(holderId, card);
        continued = true;
      } else {
        this.loop.holds.releaseHold(holderId);
      }
    } else {
      this.loop.holds.releaseHold(holderId);
    }
    const paused = continued
      ? this.continueAfterHolderContinues(holdPlayerId, hold, resumeIndex)
      : this.processHoldsInteractive(resumeIndex + 1);
    if (!paused) {
      if (this.game.winTracker.isOver()) { this.phase = 'match-over'; return this.describe(); }
      const attackerId = this.game.controlPlayerId;
      this.continueTurnAfterHolds(attackerId, this.game.other(attackerId));
    }
    return this.advance();
  }

  submitTapOut(tapOut) {
    if (this.phase !== 'awaiting-tapout') return this.describe();
    const { holdPlayerId, resumeIndex } = this.ctx;
    if (tapOut) {
      const result = this.loop.holds.tapOut(holdPlayerId);
      this.game.winTracker.declareSubmission(result.winner);
      this.phase = 'match-over';
      return this.describe();
    }
    const paused = this.processHoldsInteractive(resumeIndex + 1);
    if (!paused) {
      const attackerId = this.game.controlPlayerId;
      this.continueTurnAfterHolds(attackerId, this.game.other(attackerId));
    }
    return this.advance();
  }

  submitReturnToRing() {
    if (this.phase !== 'awaiting-ringside') return this.describe();
    const { attackerId, defenderId } = this.ctx;
    const attacker = this.game.players[attackerId];
    attacker.locationState.moveTo(Location.IN_RING);
    this.game.log(`${attackerId} returns to the ring (count reset).`);
    this.loop.maybeDraw(attacker);
    this.ctx = { attackerId, defenderId };
    this.phase = 'awaiting-action';
    return this.advance();
  }

  // Rare alternative to returning immediately: play a Ringside-eligible
  // move instead of taking the free return-to-ring action this turn.
  submitRingsideMove(instanceId) {
    if (this.phase !== 'awaiting-ringside') return this.describe();
    const { attackerId, defenderId } = this.ctx;
    const attacker = this.game.players[attackerId];
    const movePage = attacker.playbook.hand.find((pg) => pg.instanceId === instanceId);
    if (!movePage) return this.describe();
    this.beginMove(attackerId, defenderId, movePage);
    return this.advance();
  }
}
