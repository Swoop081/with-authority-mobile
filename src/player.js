import { MomentumTrack } from './momentum.js';
import { Playbook } from './playbook.js';
import { SubmissionState } from './submission.js';
import { LocationState } from './location.js';

// Stun, confirmed against real gameplay (2024-08):
//   - Functionally a skip-turn: while stunned, your only legal action
//     when it's your turn to act is Pass.
//   - Lasts exactly one turn, then is cleared automatically.
//   - Not a once-per-game effect -- a wrestler can be stunned repeatedly
//     over the course of a match.
//   - Some cards stun as part of a move connecting (e.g. a move's text
//     says the opponent becomes stunned); others are described as being
//     playable "before a move" to set up a stun going into it.
//   - TODO-CONFIRM: WAStun() calls in real card scripts pass a numeric
//     argument (e.g. Stunning Blow calls WAStun(target, this, 2)). Since
//     stun is confirmed to always last exactly one turn regardless, this
//     second argument's meaning is still unclear -- it may be a stun
//     "strength"/stack count rather than a duration (this would explain
//     Kane's Can_Stun ability, which just blocks the *first* stun applied
//     to him rather than caring about a duration). Modeled here as a
//     simple boolean flag until this is clarified.

export class Player {
  constructor(id, playbookCards, { rng } = {}) {
    this.id = id;
    this.momentum = new MomentumTrack();
    this.playbook = new Playbook(playbookCards, rng ? { rng } : {});
    this.stunned = false;
    this.blockedFirstStun = false; // set true by cards like Kane's Can_Stun resistance
    this.submission = new SubmissionState();
    this.hasSubmissionApplied = false; // true while a hold is ON this player (WAInSubmissionHold)
    // CORRECTED (2024-08): the draw-skip applies to whoever is HOLDING
    // the submission, not the trapped player -- the trapped player draws
    // normally (so they have cards to escape/Autocounter with). Original
    // instruction was misread the first time; fixed here.
    this.isApplyingHold = false; // true while THIS player is maintaining a hold on their opponent

    // "On the mat" state, confirmed directly from real card scripts
    // (WASetOnMat/WAGetOnMat, e.g. Inside Cradle: WASetOnMat(#target,1)
    // then WAPinSuperstar(#superstar,#target,1)). Gates both pin
    // attempts and a whole category of moves that say "may only be
    // played offensively if opponent is on the mat." Confirmed from
    // card text that a failed pin removes the target from the mat.
    // TODO-CONFIRM: the exact base pin-success formula -- pins are
    // probabilistic (cards reference bonuses like "+35% pin chance"),
    // but the base % isn't visible in any card data; it lives in the
    // compiled WAPinSuperstar implementation.
    this.onMat = false;

    // Warnings/DQ, confirmed directly from the real "DQ Warning" card
    // text: "Once you receive 5 or more Warnings you have a 5% chance
    // per warning of being Disqualified." Real cards add warnings via
    // WAWarn(player, amount) -- e.g. Eye Rake (+2), Chair Shot (+4/+5).
    // TODO-CONFIRM: exactly when the DQ chance is rolled (each turn?
    // each time a new warning is added?).
    this.warnings = 0;

    this.locationState = new LocationState();

    // Auto-counter economy, confirmed (2024-08):
    //   Costs 7 cards ditched from hand the first use in a match, then
    //   +1 cost for each subsequent use that same match. This is a
    //   universal defensive option available regardless of hand
    //   contents (unlike card-based counters), used sparingly given the
    //   steep cost. Strategic guidance from the player: only worth using
    //   against high-damage moves or when at real risk of submitting.
    this.autoCounterUsesThisMatch = 0;
  }

  autoCounterCost() {
    return 7 + this.autoCounterUsesThisMatch;
  }

  // `ditchFn` should pick and ditch `cost` cards from this player's hand
  // (game/UI decides which cards). Returns false if the hand can't cover
  // the cost.
  useAutoCounter(ditchFn) {
    const cost = this.autoCounterCost();
    if (this.playbook.hand.length < cost) return false;
    ditchFn(cost);
    this.autoCounterUsesThisMatch += 1;
    return true;
  }

  // Turn-start draw is skipped by whoever is APPLYING a submission hold
  // (they're occupied maintaining it) -- the trapped player draws
  // normally, since they need cards in hand to escape or Autocounter.
  canDrawAtTurnStart() {
    return !this.isApplyingHold;
  }

  setOnMat(value) {
    this.onMat = value;
  }

  isOnMat() {
    return this.onMat;
  }

  addWarnings(n) {
    this.warnings += n;
  }

  isStunned() {
    return this.stunned;
  }

  // `source` / `resistanceCheck` allow card-specific hooks (e.g. Kane) to
  // veto a stun before it's applied. resistanceCheck, if provided, should
  // return false to block the stun.
  applyStun(resistanceCheck = null) {
    if (resistanceCheck && resistanceCheck() === false) {
      return false; // resisted, e.g. Kane's first-stun immunity
    }
    this.stunned = true;
    return true;
  }

  // Called when this player's turn-to-act comes up and they were stunned
  // going into it. Clears the stun after consuming this turn.
  consumeStunnedTurn() {
    const wasStunned = this.stunned;
    this.stunned = false;
    return wasStunned;
  }
}
