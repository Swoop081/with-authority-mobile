import { ValueBag } from './value-bag.js';

export const Zone = Object.freeze({
  PLAYBOOK: 'playbook',
  HAND: 'hand',
  IN_PLAY: 'in_play',
  DISCARD: 'discard',
  OUT_OF_GAME: 'out_of_game',
});

let nextInstanceId = 1;

// A PageInstance is a specific physical copy of a card in the game --
// distinct from CardDefinition, which is the shared static template
// (rules text, base stats, scripts). Two copies of "Clothesline" in the
// same deck are two different PageInstances sharing one CardDefinition.
export class PageInstance extends ValueBag {
  constructor(def, ownerId) {
    super();
    this.instanceId = nextInstanceId++;
    this.def = def; // CardDefinition
    this.ownerId = ownerId; // which player's card this is
    this.zone = Zone.PLAYBOOK;
    this.playedByPlayerId = null; // WAGetPlayedBy -- may differ from owner (e.g. stolen/forced cards)
    this.playedOnTurn = null; // WAGetTurnPlayedOn / WAGetPlayedOn
  }

  get name() {
    return this.def.name;
  }

  get filename() {
    return this.def.filename;
  }
}
