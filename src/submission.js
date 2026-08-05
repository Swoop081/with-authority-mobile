// Submission system, confirmed against real gameplay (2024-08):
//   - Four trackable body parts: Head, Arm, Back, Leg. CORRECTED (was
//     originally guessed as "Body" -- real card field is
//     Back_Submission_Damage, confirmed 2024-08).
//   - A successful submission move damages the specific body part the
//     card names, by the amount the card specifies.
//   - After a submission connects, the applying player chooses each
//     subsequent turn:
//       a. Continue the hold -- costs ditching 1 card from hand
//          (permanently gone, not recoverable). The hold stays active.
//       b. Release the hold -- ends the hold, but the releasing player
//          keeps possession/control.
//   - CORRECTED (2024-08): the APPLYING player skips their turn-start
//     draw while maintaining the hold -- the trapped player draws
//     normally, since they need cards in hand to escape or Autocounter.
//     (Original read of the instruction had this backwards; fixed.)
//   - Each turn the hold is active, the trapped player gets a chance to
//     play a reversal card to escape. If they can't/don't, the
//     continue/release cycle repeats.
//   - The hold ends when: the applying player releases it, the trapped
//     player reverses/escapes, or the trapped player taps out (submits
//     -- a match-ending loss).

export const BODY_PARTS = ['Head', 'Arm', 'Back', 'Leg'];

export class SubmissionState {
  constructor() {
    // Per body part accumulated submission damage, per player (the
    // player who OWNS the body part, i.e. who has been damaged there).
    this.damage = {
      Head: 0, Arm: 0, Back: 0, Leg: 0,
    };
    this.activeHold = null; // { applierId, targetId, part, cardName }
  }

  applySubmissionDamage(part, amount) {
    if (!BODY_PARTS.includes(part)) throw new Error('Unknown body part: ' + part);
    this.damage[part] += amount;
  }
}

export class HoldManager {
  constructor(players, { log = console.log } = {}) {
    this.players = players; // { A: Player, B: Player }
    this.log = log;
  }

  other(id) {
    return id === 'A' ? 'B' : 'A';
  }

  // A submission move just connected: apply body-part damage and open
  // the hold.
  applyHold(applierId, targetId, part, amount, cardName) {
    const target = this.players[targetId];
    const applier = this.players[applierId];
    target.submission.applySubmissionDamage(part, amount);
    target.submission.activeHold = { applierId, targetId, part, cardName };
    target.hasSubmissionApplied = true; // WAInSubmissionHold(target) -- true while held
    applier.isApplyingHold = true; // gates the APPLIER's next draw, not the target's
    this.log(`${applierId} applies ${cardName} to ${targetId}'s ${part} (+${amount} submission damage, ` +
             `total ${target.submission.damage[part]}).`);
  }

  // Applying player's choice each turn the hold is active.
  continueHold(applierId, cardToDitch) {
    const targetId = this.other(applierId);
    const target = this.players[targetId];
    if (!target.submission.activeHold) throw new Error('No active hold to continue');
    this.players[applierId].playbook.ditch(cardToDitch); // permanently gone
    this.log(`${applierId} continues the hold, ditching ${cardToDitch.name}.`);
    return { continued: true };
  }

  releaseHold(applierId) {
    const targetId = this.other(applierId);
    const target = this.players[targetId];
    target.submission.activeHold = null;
    target.hasSubmissionApplied = false;
    this.players[applierId].isApplyingHold = false;
    this.log(`${applierId} releases the hold on ${targetId}. ${applierId} keeps possession.`);
    // Confirmed: releasing keeps control/possession with the applier.
    return { control: applierId };
  }

  // Trapped player successfully plays a reversal card.
  reverseHold(targetId) {
    const target = this.players[targetId];
    const applierId = target.submission.activeHold?.applierId;
    target.submission.activeHold = null;
    target.hasSubmissionApplied = false;
    if (applierId) this.players[applierId].isApplyingHold = false;
    this.log(`${targetId} reverses the hold and escapes.`);
  }

  // Trapped player gives up.
  tapOut(targetId) {
    const applierId = this.other(targetId);
    this.log(`${targetId} taps out! ${applierId} wins by submission.`);
    return { winner: applierId, reason: 'submission' };
  }
}
