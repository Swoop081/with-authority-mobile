import { Environment } from './environment.js';

// Truthiness: only JS false/undefined/null are falsy (Nil parses to false).
// Everything else -- including 0, '', empty arrays -- is truthy, matching
// the Lisp-family convention this DSL clearly follows (scripts explicitly
// compare against 0 rather than relying on it being falsy).
export function isTruthy(v) {
  return v !== false && v !== undefined && v !== null;
}

function toList(v) {
  if (v === false || v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

export class ScriptError extends Error {}

const SPECIAL_FORMS = new Set(['if', 'block', 'sett', 'setq', 'loop', 'enum']);

const PRIMITIVES = {
  eq: (a, b) => valueEquals(a, b),
  and: (...args) => args.every(isTruthy),
  or: (...args) => args.some(isTruthy),
  not: (a) => !isTruthy(a),
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
  greater: (a, b) => a > b,
  lesser: (a, b) => a < b,
  'greater-eq': (a, b) => a >= b,
  'lesser-eq': (a, b) => a <= b,
  cat: (...args) => args.map(stringify).join(''),
  cons: (list, item) => [...toList(list), item],
  item: (list, idx) => {
    const arr = toList(list);
    // Scripts index lists 1-based (paired with WARandom(1, count)).
    return arr[idx - 1];
  },
  count: (list) => toList(list).length,
  true: () => true,
};

function stringify(v) {
  if (v === false || v === undefined || v === null) return '';
  if (v === true) return 'True';
  if (typeof v === 'object' && v.name) return v.name;
  return String(v);
}

function valueEquals(a, b) {
  if (a === b) return true;
  // Cards/players compare by identity, but scripts frequently compare a
  // card object against a UNID number or name string too.
  if (a && typeof a === 'object' && 'unid' in a && typeof b === 'number') {
    return a.unid === b;
  }
  if (b && typeof b === 'object' && 'unid' in b && typeof a === 'number') {
    return b.unid === a;
  }
  if (a && typeof a === 'object' && 'name' in a && typeof b === 'string') {
    return a.name === b;
  }
  if (b && typeof b === 'object' && 'name' in b && typeof a === 'string') {
    return b.name === a;
  }
  return false;
}

export class Interpreter {
  constructor(hostFunctions, options = {}) {
    this.host = hostFunctions; // { FuncName: (interp, ctx, env, args) => value }
    this.warnOnUnknown = options.warnOnUnknown !== false;
    this.unknownCalls = new Set();
  }

  run(ast, ctx, env = new Environment()) {
    return this.eval(ast, env, ctx);
  }

  eval(node, env, ctx) {
    switch (node.kind) {
      case 'num':
        return node.value;
      case 'str':
        return node.value;
      case 'bool':
        return node.value;
      case 'nil':
        return false;
      case 'quoted':
        // Quoted symbols are literal tag strings, e.g. 'Impact -> "Impact"
        return node.expr.kind === 'sym' ? node.expr.name : this.eval(node.expr, env, ctx);
      case 'ctxvar': {
        if (!(node.name in ctx)) return false;
        return ctx[node.name];
      }
      case 'sym': {
        if (env.has(node.name)) return env.get(node.name);
        // Bare capitalized constants used by scripts that we don't yet
        // model numerically (e.g. momentum-type tags). Fall back to the
        // symbol name itself so comparisons/logging remain meaningful.
        return node.name;
      }
      case 'list':
        return this.evalList(node, env, ctx);
      default:
        throw new ScriptError('Unknown AST node kind: ' + node.kind);
    }
  }

  evalList(node, env, ctx) {
    if (node.items.length === 0) return false;
    const head = node.items[0];
    const fname = head.kind === 'sym' ? head.name : null;

    if (fname && SPECIAL_FORMS.has(fname)) {
      return this.evalSpecialForm(fname, node.items.slice(1), env, ctx);
    }

    if (fname && fname in PRIMITIVES) {
      const args = node.items.slice(1).map((n) => this.eval(n, env, ctx));
      return PRIMITIVES[fname](...args);
    }

    if (fname && fname in this.host) {
      const args = node.items.slice(1).map((n) => this.eval(n, env, ctx));
      return this.host[fname](this, ctx, env, args);
    }

    if (fname) {
      if (this.warnOnUnknown && !this.unknownCalls.has(fname)) {
        this.unknownCalls.add(fname);
        console.warn('[wa-engine] Unimplemented function called:', fname);
      }
      // Fail soft so the rest of the script can still run.
      node.items.slice(1).forEach((n) => this.eval(n, env, ctx));
      return false;
    }

    // Head is not a symbol (e.g. a nested list evaluating to a function
    // is not a pattern seen in this DSL) -- evaluate as a plain sequence.
    let result = false;
    for (const item of node.items) result = this.eval(item, env, ctx);
    return result;
  }

  evalSpecialForm(name, args, env, ctx) {
    switch (name) {
      case 'if': {
        // (if (cond1 result1) (cond2 result2) ...) -- cond-style.
        for (const clause of args) {
          if (clause.kind !== 'list' || clause.items.length !== 2) {
            throw new ScriptError('Malformed if-clause');
          }
          const [condNode, resultNode] = clause.items;
          if (isTruthy(this.eval(condNode, env, ctx))) {
            return this.eval(resultNode, env, ctx);
          }
        }
        return false;
      }
      case 'block': {
        const childEnv = env.child();
        let result = false;
        for (const item of args) result = this.eval(item, childEnv, ctx);
        return result;
      }
      case 'sett':
      case 'setq': {
        const [nameNode, valueNode] = args;
        if (nameNode.kind !== 'sym') throw new ScriptError('sett requires a symbol name');
        const value = this.eval(valueNode, env, ctx);
        env.set(nameNode.name, value);
        return value;
      }
      case 'loop': {
        const [condNode, bodyNode] = args;
        let result = false;
        let guard = 0;
        while (isTruthy(this.eval(condNode, env, ctx))) {
          result = this.eval(bodyNode, env, ctx);
          guard++;
          if (guard > 100000) throw new ScriptError('loop exceeded safety limit');
        }
        return result;
      }
      case 'enum': {
        const [listNode, varNode, bodyNode] = args;
        if (varNode.kind !== 'sym') throw new ScriptError('enum requires a symbol variable');
        const list = toList(this.eval(listNode, env, ctx));
        let result = false;
        for (const item of list) {
          const childEnv = env.child();
          childEnv.define(varNode.name, item);
          result = this.eval(bodyNode, childEnv, ctx);
        }
        return result;
      }
      default:
        throw new ScriptError('Unhandled special form: ' + name);
    }
  }
}
