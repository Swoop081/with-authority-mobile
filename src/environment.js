export class Environment {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map();
  }

  child() {
    return new Environment(this);
  }

  has(name) {
    return this.vars.has(name) || (this.parent && this.parent.has(name));
  }

  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }

  // sett/setq semantics observed in the scripts: assigns in the nearest
  // scope that already defines the variable, otherwise defines it locally.
  set(name, value) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) {
        env.vars.set(name, value);
        return;
      }
      env = env.parent;
    }
    this.vars.set(name, value);
  }

  define(name, value) {
    this.vars.set(name, value);
  }
}
