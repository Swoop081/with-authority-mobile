import { Zone } from './page-instance.js';
import { HoldManager } from './submission.js';
import { BODY_PARTS } from './submission.js';
import { isMoveCard, isMomentumCard, isSpecialCard } from './host-functions.js';
import { Location } from './location.js';
import { hpScaledPinChance } from './win-conditions.js';

// Ties every confirmed subsystem together into an actual playable match.
// Where a rule wasn't confirmed (pin base %, AI reaction sophistication),
// a clearly-flagged placeholder is used.
export class GameLoop {
  constructor(game, interp, { rng = Math.random } = {}) {
    this.game = game;
    this.interp = interp;
    this.rng = rng;
    this.holds = new HoldManager(game.players, { log: game.log });
  }

  runScript(def, fieldName, ctx) {
    if (!def.hasScript(fieldName)) return undefined;
    const ast = def.getScriptAST(fieldName);
    return this.interp.run(ast, ctx);
  }

  // `thisPage` is the specific card whose script is about to run --
  // CRITICAL to get right, since the vast majority of real scripts open
  // with an `(eq #move #this)` or similar identity guard. `superstarPage`/
  // `targetPage` are the acting/opposing superstars. `movePage` defaults
  // to `thisPage` (the common case: a move's own script sees itself as
  // both #this and #move) but can be overridden for reactive cards like
  // Crowd Support, whose #this (itself) differs from #move (whatever
  // move actually connected that turn).
  baseCtx(thisPage, superstarPage, targetPage, movePage = thisPage) {
    return {
      this: thisPage, superstar: superstarPage, target: targetPage,
      move: movePage, page: thisPage, initiator: thisPage,
      incontrol: this.game.controlPlayerId, User: this.game.controlPlayerId, test: 0,
    };
  }

  // Draw at the start of a control-segment, respecting the confirmed
  // submission-hold draw-skip.
  maybeDraw(player) {
    if (!player.canDrawAtTurnStart()) {
      this.game.log(`${player.id} does not draw (submission hold applied).`);
      return;
    }
    const drawn = player.playbook.draw(1);
    if (drawn.length) this.game.log(`${player.id} draws ${drawn[0].name}.`);
  }

  // Pick a momentum card from hand to play, if any and if not already
  // played this turn-segment (confirmed: 1 per turn).
  maybePlayMomentum(player) {
    if (player.momentum.momentumPlayedThisTurn) return;
    const momentumCard = player.playbook.hand.find((pg) => isMomentumCard(pg.def));
    if (!momentumCard) return;
    const type = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']
      .find((t) => momentumCard.def.fields[`${t}_Points`]);
    if (!type) return;
    player.momentum.playMomentumCard(type, 1);
    player.playbook.playFromHand(momentumCard);
    momentumCard.zone = Zone.DISCARD;
    player.playbook.discard.push(momentumCard);
    this.game.log(`${player.id} plays momentum: +1 ${type}.`);
  }

  // Score every legal move in hand via its real AI_PlayPage script and
  // return the best one (or null). This is the actual per-card AI logic
  // confirmed to live in card data -- not a hand-built heuristic.
  chooseMove(player, opponent) {
    const legalMoves = player.playbook.hand.filter((pg) => {
      if (isSpecialCard(pg.def)) return this.isLegalToPlay(pg, player, opponent);
      if (!isMoveCard(pg.def)) return false;
      // CONFIRMED (real bug found via a real GitHub Pages test run):
      // Move_Type "defensive" marks a card as counter-only -- e.g. "Up
      // and Over": "This move may not be used offensively." 32 real
      // cards carry this. They remain fully eligible in chooseCounter
      // (that's their whole purpose); they must never be offered here.
      if (pg.def.fields.Move_Type === 'defensive') return false;
      return this.isLegalToPlay(pg, player, opponent);
    });
    if (legalMoves.length === 0) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const movePage of legalMoves) {
      movePage.setValue('AIScore', 0);
      const ctx = this.baseCtx(movePage, player.superstarPage, opponent.superstarPage);
      if (movePage.def.hasScript('AI_PlayPage')) {
        this.runScript(movePage.def, 'AI_PlayPage', ctx);
      } else {
        movePage.setValue('AIScore', 10); // no AI hook -- flat baseline priority
      }
      let score = movePage.getValue('AIScore');

      // DQ-risk awareness (not a data-driven rule -- a strategic layer
      // on top of the real per-card AI scores). Confirmed formula: DQ
      // chance is 5% per warning once you hit 5+. A player already
      // sitting on real risk should avoid piling on more warnings
      // unless nothing else is on offer. Heavily penalize (don't
      // outright ban -- a big finisher might still be worth the risk)
      // warning-granting cards once warnings are already elevated.
      if (player.warnings >= 3 && this.givesWarnings(movePage)) {
        score -= 40 + player.warnings * 10;
      }

      if (score > bestScore) {
        bestScore = score;
        best = movePage;
      }
    }
    return best;
  }

  givesWarnings(page) {
    for (const field of ['Move_Connected', 'Page_Played']) {
      const src = page.def.fields[field];
      if (typeof src === 'string' && src.includes('WAWarn')) return true;
    }
    return false;
  }

  canCoverCost(player, page) {
    const costMap = {};
    for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
      const c = page.def.getNumericField(`${t}_Cost`, 0);
      if (c) costMap[t] = c;
    }
    const generic = page.def.getNumericField('Momentum_Cost', 0);
    if (generic) costMap.Momentum = generic;
    return player.momentum.canCoverCost(costMap);
  }

  // CONFIRMED (2024-08 corpus check): 297 of 1,121 cards (26.5%) carry a
  // Can_Be_Played legality script that was never being checked -- e.g.
  // Throw Over The Ropes requires the target actually be in the ring,
  // Grounded-status cards refuse to be played twice, Distract The
  // Referee refuses if already active. Cost alone was an incomplete
  // legality check; this closes that gap for both offense and defense.
  isLegalToPlay(page, player, opponent) {
    if (!this.canCoverCost(player, page)) return false;
    if (!page.def.hasScript('Can_Be_Played')) return true;
    const ctx = this.baseCtx(page, player.superstarPage, opponent.superstarPage);
    ctx.page = page;
    const result = this.runScript(page.def, 'Can_Be_Played', ctx);
    return result !== false;
  }

  // CONFIRMED (2024-08 corpus check): the Counters field is a clean
  // pipe-separated list of Move_Type values (e.g. Inside Cradle:
  // "in close|standing above"), not free text -- exact match, not
  // substring. Counter cards also carry real costs (Elbow: Strike_Cost
  // 1, Inside Cradle: Technical_Cost 1) that were never being checked,
  // meaning the AI could previously "counter" with cards it couldn't
  // actually afford. Candidates are now filtered through the same
  // isLegalToPlay() gate as offensive moves (cost + Can_Be_Played), and
  // scored via their own real AI_PlayPage script where one exists (most
  // basic counter-moves don't have one -- confirmed on Duck/Dodge/Elbow/
  // Knee Lift/Inside Cradle -- so a simple documented-as-non-data-driven
  // heuristic covers that gap: prefer cheaper, higher-damage counters).
  chooseCounter(defender, movePage, attacker) {
    const moveType = movePage.def.fields.Move_Type;
    if (!moveType) return null;
    const candidates = defender.playbook.hand.filter((pg) => {
      const counters = (pg.def.fields.Counters || '').split('|').map((s) => s.trim().toLowerCase());
      return counters.includes(moveType.toLowerCase()) && this.isLegalToPlay(pg, defender, attacker);
    });
    if (candidates.length === 0) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      let score;
      if (candidate.def.hasScript('AI_PlayPage')) {
        candidate.setValue('AIScore', 0);
        const ctx = this.baseCtx(candidate, defender.superstarPage, attacker.superstarPage);
        this.runScript(candidate.def, 'AI_PlayPage', ctx);
        score = candidate.getValue('AIScore');
      } else {
        // Heuristic (not data-driven): prefer cheap, high-damage counters.
        const totalCost = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']
          .reduce((sum, t) => sum + candidate.def.getNumericField(`${t}_Cost`, 0), 0);
        score = 50 - totalCost * 5 + candidate.def.getNumericField('Damage', 0);
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  pickLeastValuableCard(hand) {
    const momentumCard = hand.find((pg) => isMomentumCard(pg.def));
    if (momentumCard) return momentumCard;
    let best = hand[0];
    let bestCost = Infinity;
    for (const pg of hand) {
      const cost = ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']
        .reduce((sum, t) => sum + pg.def.getNumericField(`${t}_Cost`, 0), 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = pg;
      }
    }
    return best;
  }

  // Free pin attempt -- confirmed always available with control, gated
  // only by the opponent being on the mat (checked by the caller).
  // Returns { turnConsumed, control } so the caller knows whether this
  // consumed the whole exchange (it always does, win or lose or block).
  attemptFreePin(attacker, defender) {
    // Reaction window: cards like "Grab The Ropes"/"That Was Three!"
    // can cancel a pin attempt outright, same principle as countering a
    // move. Identified heuristically by whether the card's own script
    // calls WABreakPin (confirmed real examples both do).
    const hasBreakPin = (pg) => ['Page_Played', 'Move_Connected'].some((field) => {
      const src = pg.def.fields[field];
      return typeof src === 'string' && src.includes('WABreakPin');
    });
    const candidate = defender.playbook.hand.find(hasBreakPin);
    const breaker = candidate && this.isLegalToPlay(candidate, defender, attacker) ? candidate : null;

    this.game.log(`${attacker.id} goes for a pin on ${defender.id} (on the mat).`);

    if (breaker) {
      defender.playbook.playFromHand(breaker);
      defender.playbook.discard.push(breaker);
      const ctx = this.baseCtx(breaker, defender.superstarPage, attacker.superstarPage);
      this.runScript(breaker.def, breaker.def.hasScript('Page_Played') ? 'Page_Played' : 'Move_Connected', ctx);
      this.game.log(`${defender.id} breaks the pin attempt with ${breaker.name}.`);
      // Control outcome is whatever the card's own script decided (it
      // may or may not call WAChangeControl); default to unchanged.
      return { turnConsumed: true, control: this.game.controlPlayerId };
    }

    const result = this.game.winTracker.attemptPin(attacker.id, defender, { type: 'pass' });
    if (result.result) {
      return { turnConsumed: true, control: null }; // match over
    }
    // Failed pin: confirmed attacker stays in control.
    return { turnConsumed: true, control: attacker.id };
  }

  // Damage_Bonus/Prevent_Damage/Prevent_Submission_Damage, confirmed
  // real (Kane's own card: reduces Impact damage against himself; his
  // Entrance card "Hellfire And Brimstone": +1 Strength damage, and full
  // immunity to Strike damage until turn 10). These were never invoked
  // anywhere before -- checked across the move itself, both superstars'
  // own innate scripts, and any ongoing passive/Entrance effects either
  // side has in play. Convention confirmed from the scripts themselves:
  // Prevent_Damage returns Nil (false) to block the damage entirely,
  // True to allow it.
  passiveSources(attacker, defender) {
    return [
      attacker.superstarPage, defender.superstarPage,
      ...attacker.activePassives, ...defender.activePassives,
    ].filter(Boolean);
  }

  computeFinalDamage(attacker, defender, movePage, baseDamage) {
    movePage.setValue('Damage_Bonus', 0);
    const sources = [movePage, ...this.passiveSources(attacker, defender)];
    for (const src of sources) {
      if (src.def.hasScript('Damage_Bonus')) {
        const ctx = this.baseCtx(src, attacker.superstarPage, defender.superstarPage, movePage);
        this.runScript(src.def, 'Damage_Bonus', ctx);
      }
    }
    return Math.max(0, baseDamage + (movePage.getValue('Damage_Bonus') || 0));
  }

  isDamagePrevented(attacker, defender, movePage, submissionMode = false) {
    const hook = submissionMode ? 'Prevent_Submission_Damage' : 'Prevent_Damage';
    const sources = [...this.passiveSources(attacker, defender), movePage];
    for (const src of sources) {
      if (src.def.hasScript(hook)) {
        const ctx = this.baseCtx(src, attacker.superstarPage, defender.superstarPage, movePage);
        if (this.runScript(src.def, hook, ctx) === false) return true;
      }
    }
    return false;
  }

  // Special cards (confirmed real category, includes Entrance cards):
  // resolve via Page_Played, never counter-eligible, uncontested.
  // Confirmed real mechanic: cards like Kane's Entrance stay in play for
  // the rest of the match applying ongoing Damage_Bonus/Prevent_Damage
  // effects, rather than being discarded after their one-time text
  // (e.g. "Draw a page") resolves. Detected generically: if the card
  // carries any of those three hooks, it's a persistent passive.
  resolveSpecialCard(attacker, defender, page) {
    attacker.playbook.playFromHand(page);
    page.playedByPlayerId = attacker.id;
    page.playedOnTurn = this.game.turn;
    const ctx = this.baseCtx(page, attacker.superstarPage, defender.superstarPage);
    this.runScript(page.def, 'Page_Played', ctx);
    const isPersistent = ['Damage_Bonus', 'Prevent_Damage', 'Prevent_Submission_Damage']
      .some((hook) => page.def.hasScript(hook));
    if (isPersistent) {
      page.zone = Zone.IN_PLAY;
      attacker.activePassives.push(page);
      this.game.log(`${attacker.id} plays ${page.name} (stays in play).`);
    } else {
      page.zone = Zone.DISCARD;
      attacker.playbook.discard.push(page);
      this.game.log(`${attacker.id} plays ${page.name}.`);
    }
  }

  applyMoveEffects(attacker, defender, movePage) {
    const baseDamage = movePage.def.getNumericField('Damage', 0);
    let damage = 0;
    if (baseDamage > 0 && !this.isDamagePrevented(attacker, defender, movePage)) {
      damage = this.computeFinalDamage(attacker, defender, movePage, baseDamage);
      defender.hitPoints = Math.max(0, defender.hitPoints - damage);
    }
    const connMomentum = movePage.def.getNumericField('Connected_Momentum', 0);
    if (connMomentum) {
      const method = movePage.def.fields.Method;
      if (method && ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge'].includes(method)) {
        attacker.momentum.values[method] += connMomentum;
      }
    }
    const ctx = this.baseCtx(movePage, attacker.superstarPage, defender.superstarPage);
    this.runScript(movePage.def, 'Move_Connected', ctx);
    this.game.log(`${movePage.name} connects: ${damage} damage. ${defender.id} HP -> ${defender.hitPoints}.`);

    // Generic hold establishment: confirmed the engine does this itself
    // based on a move's own fields (Modifiers contains "Hold" + a
    // {Part}_Submission_Damage field), NOT via a dedicated function call
    // in the move's script -- e.g. Abdominal Stretch has no script that
    // "applies" the hold, it just has Modifiers:"Hold" and
    // Back_Submission_Damage:6, and WAInSubmissionHold becomes true.
    const modifiers = (movePage.def.fields.Modifiers || '').split('|');
    if (modifiers.includes('Hold') && !this.isDamagePrevented(attacker, defender, movePage, true)) {
      for (const part of BODY_PARTS) {
        const dmg = movePage.def.getNumericField(`${part}_Submission_Damage`, 0);
        if (dmg > 0) {
          this.holds.applyHold(attacker.id, defender.id, part, dmg, movePage.name);
          defender.submission.activeHold.movePage = movePage; // needed for No_Counter_Played next turn
          break;
        }
      }
    }
  }

  // Confirmed mechanic: each turn a hold stays active, the trapped
  // player gets a chance to escape (a reversal card); if they can't/
  // don't, the hold's own No_Counter_Played script runs (this is where
  // per-card auto-escape chances like Abdominal Stretch's 25% live).
  // Simplified here: reuse the same counter-lookup as a normal move
  // reaction to represent "the trapped player had a suitable card."
  processActiveHolds() {
    for (const id of ['A', 'B']) {
      const player = this.game.players[id];
      const hold = player.submission.activeHold;
      if (!hold || !hold.movePage) continue;
      const holderId = hold.applierId;
      const holder = this.game.players[holderId];

      const escapeCard = this.chooseCounter(player, hold.movePage, holder);
      if (escapeCard) {
        player.playbook.playFromHand(escapeCard);
        player.playbook.discard.push(escapeCard);
        this.holds.reverseHold(id);
        this.game.log(`${id} escapes the hold with ${escapeCard.name}.`);
        continue;
      }

      const ctx = this.baseCtx(hold.movePage, player.superstarPage, holder.superstarPage);
      this.runScript(hold.movePage.def, 'No_Counter_Played', ctx);

      if (!player.submission.activeHold) {
        this.game.log(`${id}'s hold ended via its own escape-chance script.`);
        continue;
      }

      // Holder's continue/release choice: simplified AI -- continue if
      // they have spare cards to ditch and the target isn't close to
      // tapping, otherwise release. When continuing, ditch the least
      // valuable card in hand (a basic momentum card if one's available,
      // otherwise the cheapest move/special) rather than an arbitrary
      // first card.
      if (holder.playbook.hand.length > 3) {
        const cardToDitch = this.pickLeastValuableCard(holder.playbook.hand);
        this.holds.continueHold(holderId, cardToDitch);

        // TODO-CONFIRM: tap-out is a player choice ("until ... the
        // opponent taps out"), not an automatic threshold -- exact AI
        // judgment for when to give up isn't confirmed. Placeholder
        // heuristic: taps if this body part has taken heavy accumulated
        // damage and overall HP is also low.
        const partDamage = player.submission.damage[hold.part];
        if (partDamage >= 20 && player.hitPoints < player.maxHitPoints * 0.3) {
          const result = this.holds.tapOut(id);
          this.game.winTracker.declareSubmission(result.winner);
        }
      } else {
        this.holds.releaseHold(holderId);
      }
    }
  }

  // One full exchange: controlling player draws, may play momentum, then
  // plays a move (if they have a legal one) which the opponent reacts
  // to. Returns the id of whoever has control after this exchange, or
  // null if nobody could act (stalemate escape hatch).
  runExchange() {
    const control = this.runExchangeInner();
    // Count-out ticks once per exchange, after whatever action happened
    // (so a player who just returned to the ring this exchange doesn't
    // also get counted the same turn -- confirmed: "the referee tells
    // you the count at the end of each turn").
    if (!this.game.winTracker.isOver()) this.tickCountOuts();
    return this.game.winTracker.isOver() ? null : control;
  }

  tickCountOuts() {
    for (const pid of ['A', 'B']) {
      const p = this.game.players[pid];
      if (p.locationState.isRingside()) {
        const countedOut = this.game.countOutTracker.tickCount(p, this.game.referee);
        if (countedOut) {
          this.game.winTracker.declareCountOut(this.game.other(pid));
        }
      }
    }
  }

  runExchangeInner() {
    this.game.turn += 1;
    const attackerId = this.game.controlPlayerId;
    const defenderId = this.game.other(attackerId);
    const attacker = this.game.players[attackerId];
    const defender = this.game.players[defenderId];

    this.game.log(`\n--- Turn ${this.game.turn}: ${attackerId} in control ---`);

    if (this.game.winTracker.checkTurnLimit(this.game.turn)) return null;

    this.processActiveHolds();
    if (this.game.winTracker.isOver()) return null;

    // Confirmed: stun forces a pass.
    if (attacker.isStunned()) {
      attacker.consumeStunnedTurn();
      this.game.log(`${attackerId} is stunned and passes. Control flips to ${defenderId}.`);
      this.game.controlPlayerId = defenderId;
      return defenderId;
    }

    // Confirmed: "return to the ring" is a free action available on your
    // own turn, same principle as Pin. CORRECTED (2024-08): this was
    // never actually wired in -- the count-out ticker existed but no one
    // could ever escape it, which is why count-outs were dominating.
    // Treated as a genuine priority: a player at Ringside on their own
    // turn always takes it before considering anything else, reflecting
    // real urgency to not get counted out.
    if (attacker.locationState.isRingside()) {
      attacker.locationState.moveTo(Location.IN_RING);
      this.game.log(`${attackerId} returns to the ring (count reset).`);
      // CORRECTED: confirmed a free priority action, doesn't end the
      // turn -- falls through to continue normally below.
    }

    this.maybeDraw(attacker);
    this.maybePlayMomentum(attacker);

    // CORRECTED (2024-08): pinning is a free, always-available action
    // whenever you have control -- not gated behind owning a specific
    // "$PIN" card. The button is present even before anyone has played
    // a page. What actually gates SUCCESS is whether the opponent is on
    // the mat; attempting it otherwise is just a wasted turn (nothing to
    // pin). AI heuristic here: only actually go for it when the
    // opponent is on the mat, since attempting otherwise can never
    // succeed -- a human player could still press it anyway (their call
    // to waste a turn), but that's not a decision the AI should make.
    // Strategic gate (not a data-driven rule -- corrected from real
    // playtesting, 2024-08): pinning is free and repeatable every turn
    // the opponent is on the mat, so even the HP-scaled per-attempt
    // chance will eventually land if attempted blindly every time --
    // this was still producing pins with the opponent barely touched.
    // A sensible wrestler waits for a real opportunity rather than
    // going for a cover after every single takedown. Only actually
    // attempt when the roll is genuinely worth taking.
    const PIN_ATTEMPT_THRESHOLD = 0.45;
    if (defender.isOnMat() && !this.game.winTracker.isOver()
        && hpScaledPinChance(defender) >= PIN_ATTEMPT_THRESHOLD) {
      const pinResult = this.attemptFreePin(attacker, defender);
      if (pinResult.turnConsumed) return pinResult.control;
    }

    const movePage = this.chooseMove(attacker, defender);
    if (!movePage) {
      this.game.log(`${attackerId} has no legal move -- passes. Control flips to ${defenderId}.`);
      attacker.momentum.onOwnMoveConnected && null; // no attitude change on a pass-with-nothing-to-play
      this.game.controlPlayerId = defenderId;
      return defenderId;
    }

    // CONFIRMED (found via real match trace, "Stunning Blow"): not all
    // Special cards are passive/Entrance-style. Some -- "Damage
    // Specials" -- connect and deal damage via Move_Connected exactly
    // like a move (Stunning Blow has Damage + Move_Connected, no
    // Page_Played at all). Only route genuinely passive specials (no
    // Move_Connected/Damage) through the dedicated uncontested path;
    // Damage Specials fall through to the normal move pipeline below,
    // getting the real counter window and damage pipeline. Real
    // Move_Type-based counters won't match them (they typically have no
    // Move_Type of their own), which is itself accurate -- confirmed
    // via chooseCounter's existing guard already handling that case.
    if (isSpecialCard(movePage.def) && !movePage.def.hasScript('Move_Connected') && !movePage.def.getNumericField('Damage', 0)) {
      this.resolveSpecialCard(attacker, defender, movePage);
      return attackerId; // uncontested -- control stays, same as a connected move
    }

    attacker.playbook.playFromHand(movePage);
    movePage.zone = Zone.IN_PLAY;
    movePage.playedByPlayerId = attackerId;
    movePage.playedOnTurn = this.game.turn;
    this.game.log(`${attackerId} plays ${movePage.name}.`);

    const counterPage = this.chooseCounter(defender, movePage, attacker);
    if (counterPage) {
      defender.playbook.playFromHand(counterPage);
      this.game.log(`${defenderId} counters with ${counterPage.name}. Control flips to ${defenderId}.`);
      // Confirmed: no Attitude change on a counter (that's connect-only).
      // But the counter card's OWN effect must still run -- this is
      // where cards like Inside Cradle actually attempt their pin
      // (WASetOnMat + WAPinSuperstar live inside ITS Move_Connected,
      // not the original move's). Previously this was skipped entirely,
      // which meant no pin/submission/DQ path could ever be reached
      // through a counter -- a real gap, now fixed.
      const baseDamage = counterPage.def.getNumericField('Damage', 0);
      let damage = 0;
      if (baseDamage > 0 && !this.isDamagePrevented(defender, attacker, counterPage)) {
        damage = this.computeFinalDamage(defender, attacker, counterPage, baseDamage);
        attacker.hitPoints = Math.max(0, attacker.hitPoints - damage);
      }
      const ctx = this.baseCtx(counterPage, defender.superstarPage, attacker.superstarPage);
      this.runScript(counterPage.def, 'Move_Connected', ctx);
      if (damage) this.game.log(`${counterPage.name} (counter) deals ${damage} damage. ${attackerId} HP -> ${attacker.hitPoints}.`);
      attacker.playbook.discard.push(movePage);
      defender.playbook.discard.push(counterPage);
      this.game.controlPlayerId = defenderId;
      defender.momentum.resetTurnFlag();
      return defenderId;
    }

    // Pass -- move connects.
    attacker.momentum.onOwnMoveConnected();
    defender.momentum.onOpponentMoveConnected();
    this.applyMoveEffects(attacker, defender, movePage);
    attacker.playbook.discard.push(movePage);
    attacker.momentum.resetTurnFlag();
    // Control remains with attacker.
    return attackerId;
  }

  runMatch({ maxExchanges = 400 } = {}) {
    let exchanges = 0;
    while (!this.game.winTracker.isOver() && exchanges < maxExchanges) {
      const result = this.runExchange();
      exchanges++;
      if (result === null) break;
    }
    if (!this.game.winTracker.isOver()) {
      this.game.log('\nMatch ended without a formal win condition (exchange cap reached).');
    } else {
      this.game.log(`\n=== MATCH OVER: ${JSON.stringify(this.game.winTracker.result)} ===`);
    }
    return this.game.winTracker.result;
  }
}
