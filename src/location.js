// Location / count-out system.
//
// CONFIRMED from real card scripts: a location state machine exists with
// (at least) $InTheRing and $Ringside, moved between via WAMove(target,
// WAFindLocation('$Ringside)). Many moves (Throw Over The Ropes, etc.)
// require the target be $InTheRing to be legal, and a category of cards
// (Drop Onto The Barricade, Off The Barricade, ...) require being at
// $Ringside instead -- confirmed exactly as the player described.
//
// CONFIRMED from real card scripts: a "RefNoCountOut" flag on the game
// map suppresses count-outs entirely, set by special referee/GM cards
// (Earl Hebner: 5-turn grace, no count-outs, forced return after;
// Jimmy Korderas: extends the grace window based on WATurnsAtLocation).
// This confirms a *baseline* count-out rule exists that these specials
// override -- but the baseline formula itself lives in the compiled
// engine, not in any card's data.
//
// CONFIRMED from player testimony (2024-08):
//   - You reach Ringside either by playing a move that sends the
//     opponent there, or by voluntarily exiting.
//   - While at Ringside you may Pass (opponent can choose to Return To
//     The Ring on their turn) or you can act from Ringside.
//   - The referee announces a count at the end of each turn, rising by
//     2-3 per turn.
//   - Reaching a count of 10 while one or both players are still outside
//     the ring is a count-out.
//   - Roughly 2-3 turns outside is safe based on memory; the count is
//     what actually matters, not a fixed turn number.
//
// TODO-CONFIRM: exact count-out trigger when BOTH players are outside
// simultaneously (double count-out -> draw? whoever's count hits 10
// first loses? not yet confirmed).

export const Location = Object.freeze({
  IN_RING: 'InTheRing',
  RINGSIDE: 'Ringside',
});

export class LocationState {
  constructor() {
    this.location = Location.IN_RING;
    this.turnsAtLocation = 0; // confirmed used by real cards (WATurnsAtLocation)
    this.count = 0; // referee's count while at Ringside
  }

  moveTo(location) {
    this.location = location;
    this.turnsAtLocation = 0;
    if (location === Location.IN_RING) this.count = 0;
  }

  isInRing() {
    return this.location === Location.IN_RING;
  }

  isRingside() {
    return this.location === Location.RINGSIDE;
  }
}

export class CountOutTracker {
  constructor({ log = console.log, rng = Math.random, countPerTurnMin = 2, countPerTurnMax = 3 } = {}) {
    this.log = log;
    this.rng = rng;
    this.countPerTurnMin = countPerTurnMin;
    this.countPerTurnMax = countPerTurnMax;
  }

  randomIncrement() {
    const span = this.countPerTurnMax - this.countPerTurnMin + 1;
    return this.countPerTurnMin + Math.floor(this.rng() * span);
  }

  // Call once at the end of every turn for each player currently at
  // Ringside. `refereeState` gates this exactly like real "RefNoCountOut"
  // cards do. Returns true if this player is counted out.
  tickCount(player, refereeState) {
    const loc = player.locationState;
    player.locationState.turnsAtLocation += 1;
    if (!loc.isRingside()) return false;
    if (refereeState && refereeState.isDistracted()) {
      this.log(`Referee distracted -- no count given for ${player.id}.`);
      return false;
    }
    if (refereeState && refereeState.countOutSuppressed) {
      this.log(`Count-outs suppressed (special in play) -- no count for ${player.id}.`);
      return false;
    }
    const inc = this.randomIncrement();
    loc.count = Math.min(10, loc.count + inc);
    this.log(`Referee counts ${player.id}: ${loc.count}${loc.count >= 10 ? ' -- COUNT OUT' : ''}`);
    return loc.count >= 10;
  }
}
