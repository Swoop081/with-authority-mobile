import { Player } from './player.js';
import { PageInstance, Zone } from './page-instance.js';
import { ValueBag } from './value-bag.js';
import { WinConditionTracker } from './win-conditions.js';
import { RefereeState } from './win-conditions.js';
import { CountOutTracker } from './location.js';

// Ties together everything built so far into one match. Single
// superstar per player (1v1 foundation, per player's explicit
// direction -- tag team is architecturally deferrable, not built yet).
export class GameState {
  constructor(cardDb, { log = console.log, rng = Math.random } = {}) {
    this.cardDb = cardDb;
    this.log = log;
    this.rng = rng;
    this.turn = 0;
    this.controlPlayerId = null;
    this.gameMap = new ValueBag(); // backs WAGameMap()
    this.referee = new RefereeState();
    this.countOutTracker = new CountOutTracker({ log, rng });
    this.winTracker = new WinConditionTracker({ log, rng, referee: this.referee });
    this.players = {}; // filled by addPlayer
  }

  // `deckFilenames` = array of .gac filenames (one per copy) for the
  // player's playbook. `superstarFilename` = which of those (or a
  // separate given card) represents their active wrestler-in-play.
  addPlayer(id, superstarFilename, deckFilenames) {
    const nonSuperstarCards = deckFilenames.map((fn) => this.cardDb.get(fn)).filter(Boolean);
    const player = new Player(id, nonSuperstarCards, { rng: this.rng });
    // Playbook stored CardDefinitions for now; wrap into PageInstances.
    player.playbook.library = player.playbook.library.map((def) => {
      const inst = new PageInstance(def, id);
      inst.zone = Zone.PLAYBOOK;
      return inst;
    });

    const superstarDef = this.cardDb.get(superstarFilename);
    const superstarPage = new PageInstance(superstarDef, id);
    superstarPage.zone = Zone.IN_PLAY;
    superstarPage.player = player; // back-reference so value routing can find momentum/HP
    player.superstarPage = superstarPage;
    player.hitPoints = superstarDef.getNumericField('Hit_Points', 50);
    player.maxHitPoints = player.hitPoints;

    this.players[id] = player;
    return player;
  }

  other(id) {
    return id === 'A' ? 'B' : 'A';
  }

  opponentOf(id) {
    return this.players[this.other(id)];
  }
}
