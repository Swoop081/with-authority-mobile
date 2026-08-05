// Parser for the With Authority! card scripting DSL.
//
// Grammar observed from decompiled card data:
//   expr    := atom | list
//   list    := '(' expr* ')'
//   atom    := number | string | symbol | quoted-symbol
//
// Symbols starting with '#' are context variables (#this, #target, #move,
// #superstar, #test, #initiator, #page, #incontrol, #User, ...).
// A leading "'" quotes the following symbol as a literal tag (e.g. 'Impact,
// '$Chair) rather than evaluating it as a variable reference.
// "True" and "Nil" are literal booleans, not bound variables.

export class ParseError extends Error {}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ type: c, pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      // string literal, supports simple escaping of \" and \\
      let j = i + 1;
      let buf = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          buf += src[j + 1];
          j += 2;
        } else {
          buf += src[j];
          j++;
        }
      }
      tokens.push({ type: 'string', value: buf, pos: i });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      tokens.push({ type: 'quote', pos: i });
      i++;
      continue;
    }
    // symbol / number: run until whitespace or paren
    let j = i;
    while (j < n && !' \t\r\n()"'.includes(src[j])) {
      j++;
    }
    const raw = src.slice(i, j);
    tokens.push({ type: 'atom', value: raw, pos: i });
    i = j;
  }
  return tokens;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function atomToNode(raw) {
  if (NUMBER_RE.test(raw)) {
    return { kind: 'num', value: Number(raw) };
  }
  if (raw === 'True') return { kind: 'bool', value: true };
  if (raw === 'Nil') return { kind: 'nil' };
  if (raw.startsWith('#')) return { kind: 'ctxvar', name: raw.slice(1) };
  return { kind: 'sym', name: raw };
}

export function parseProgram(src) {
  const tokens = tokenize(src);
  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function parseExpr() {
    const tok = peek();
    if (!tok) throw new ParseError('Unexpected end of input');
    if (tok.type === '(') {
      pos++;
      const items = [];
      while (peek() && peek().type !== ')') {
        items.push(parseExpr());
      }
      if (!peek()) throw new ParseError('Unclosed list starting at ' + tok.pos);
      pos++; // consume ')'
      return { kind: 'list', items };
    }
    if (tok.type === ')') {
      throw new ParseError('Unexpected ) at ' + tok.pos);
    }
    if (tok.type === 'string') {
      pos++;
      return { kind: 'str', value: tok.value };
    }
    if (tok.type === 'quote') {
      pos++;
      const inner = parseExpr();
      return { kind: 'quoted', expr: inner };
    }
    if (tok.type === 'atom') {
      pos++;
      return atomToNode(tok.value);
    }
    throw new ParseError('Unknown token type ' + tok.type);
  }

  // A script file is a sequence of top-level expressions; in practice
  // card scripts are exactly one top-level (if ...) or (block ...) form,
  // but we parse generally and return all top-level forms.
  const forms = [];
  while (pos < tokens.length) {
    forms.push(parseExpr());
  }
  return forms;
}

// Convenience: parse and require exactly one top-level form (typical for
// a single ability script).
export function parseScript(src) {
  const forms = parseProgram(src);
  if (forms.length === 0) return { kind: 'nil' };
  if (forms.length === 1) return forms[0];
  // Multiple top-level forms: treat as implicit block.
  return { kind: 'list', items: [{ kind: 'sym', name: 'block' }, ...forms] };
}
