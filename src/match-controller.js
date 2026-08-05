import { Zone } from './page-instance.js';
import { isMoveCard, isMomentumCard } from './host-functions.js';
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
    return { phase: this.phase };
  }

  // ---- legality helpers (read-only, mirror the AI's candidate lists) ----

  getLegalMoves(player, opponent) {
    return player.playbook.hand.filter((pg) => {
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

  step() {
    this.game.turn += 1;
    const attackerId = this.game.controlPlayerId;
    const defenderId = this.game.other(attackerId);
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];
    this.game.log(`\n--- Turn ${this.game.turn}: ${attackerId} in control ---`);

    if (this.game.winTracker.checkTurnLimit(this.game.turn)) { this.phase = 'match-over'; return; }

    this.loop.processActiveHolds();
    if (this.game.winTracker.isOver()) { this.phase = 'match-over'; return; }

    if (attacker.isStunned()) {
      attacker.consumeStunnedTurn();
      this.game.log(`${attackerId} is stunned and passes. Control flips to ${defenderId}.`);
      this.game.controlPlayerId = defenderId;
      this.finishExchange(defenderId);
      return;
    }

    if (attacker.locationState.isRingside()) {
      attacker.locationState.moveTo(Location.IN_RING);
      this.game.log(`${attackerId} returns to the ring (count reset).`);
      this.game.controlPlayerId = defenderId;
      this.finishExchange(defenderId);
      return;
    }

    this.loop.maybeDraw(attacker);

    if (attackerId === this.humanPlayerId) {
      this.ctx = { attackerId, defenderId };
      this.phase = 'awaiting-action';
      return;
    }

    // AI attacker: identical to GameLoop.runExchangeInner from here down.
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

  beginMove(attackerId, defenderId, movePage) {
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];
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
      const damage = counterPage.def.getNumericField('Damage', 0);
      if (damage) attacker.hitPoints = Math.max(0, attacker.hitPoints - damage);
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
}
