// Scripts read/write arbitrary named state on cards, superstars, and the
// game map via WAGetValue/WASetValue/WAAddValue/WARemoveValue/WAHasValue
// (e.g. Used_Special, Distracted, Blocked_Stun, SpecialActive -- all
// card-specific, ad hoc). This is a generic key/value bag every such
// object gets.
//
// Some keys are NOT ad hoc, though -- they're confirmed to route to a
// specific subsystem we already built:
//   Strike_Momentum, Strength_Momentum, Technical_Momentum,
//   Agility_Momentum, Knowledge_Momentum  -> MomentumTrack (typed)
//   Generic_Momentum                      -> MomentumTrack Attitude
//     (confirmed: Crowd Support and Eye Rake both read/write
//     Generic_Momentum for what their card text calls "Attitude")
//   Hit_Points                            -> Player.hitPoints
export const MOMENTUM_KEY_MAP = {
  Strike_Momentum: 'Strike',
  Strength_Momentum: 'Strength',
  Technical_Momentum: 'Technical',
  Agility_Momentum: 'Agility',
  Knowledge_Momentum: 'Knowledge',
  Generic_Momentum: 'Attitude',
};

export class ValueBag {
  constructor() {
    this.values = new Map();
  }

  getValue(key) {
    if (this.values.has(key)) return this.values.get(key);
    return 0; // scripts freely do arithmetic on unset keys; default to 0
  }

  setValue(key, value) {
    this.values.set(key, value);
  }

  addValue(key, amount) {
    const cur = this.values.has(key) ? this.values.get(key) : 0;
    this.values.set(key, cur + amount);
  }

  removeValue(key) {
    this.values.delete(key);
  }

  hasValue(key) {
    return this.values.has(key);
  }
}
