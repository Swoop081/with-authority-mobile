import { parseScript } from './parser.js';

// Browser-compatible sibling of the Node card-database.js. Same
// CardDefinition/CardDatabase shape and same edition-inheritance logic
// (confirmed 2024-08: stat fields like Hit_Points are safe to inherit
// across editions of the same character; ability scripts never are),
// just loaded from a pre-fetched JSON bundle instead of the filesystem.

const EDITION_SUFFIX = /(2E|EX[1-4]|LE|Tourn|W)$/;
const INHERITABLE_STAT_FIELDS = [
  'Hit_Points', 'Strike_Maximum', 'Strength_Maximum', 'Technical_Maximum',
  'Agility_Maximum', 'Knowledge_Maximum',
];

export class CardDefinition {
  constructor(raw, filename) {
    this.filename = filename;
    this.name = raw.name;
    this.template = raw.template;
    this.text = raw.text;
    this.fields = { ...(raw.fields || {}) };
    this.assets = raw.assets || [];
    this._astCache = new Map();
    this.unid = null;
  }

  hasScript(fieldName) {
    const v = this.fields[fieldName];
    return typeof v === 'string' && v.trim().startsWith('(');
  }

  getScriptAST(fieldName) {
    if (this._astCache.has(fieldName)) return this._astCache.get(fieldName);
    const src = this.fields[fieldName];
    const ast = src ? parseScript(src) : null;
    this._astCache.set(fieldName, ast);
    return ast;
  }

  getNumericField(fieldName, fallback = 0) {
    const v = this.fields[fieldName];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isNaN(n) ? fallback : n;
  }
}

export class CardDatabase {
  constructor() {
    this.byFilename = new Map();
    this.byUNID = new Map();
  }

  static fromBundle(bundle) {
    const db = new CardDatabase();
    for (const [filename, raw] of Object.entries(bundle.cards)) {
      db.byFilename.set(filename, new CardDefinition(raw, filename));
    }
    for (const [unid, filename] of Object.entries(bundle.unidMap || {})) {
      const def = db.byFilename.get(filename);
      if (def) {
        db.byUNID.set(Number(unid), def);
        def.unid = Number(unid);
      }
    }
    db.resolveEditionInheritance();
    return db;
  }

  static async loadFromUrl(url) {
    const res = await fetch(url);
    const bundle = await res.json();
    return CardDatabase.fromBundle(bundle);
  }

  resolveEditionInheritance() {
    const groups = new Map();
    for (const def of this.byFilename.values()) {
      if (!(def.template || '').includes('Superstar_Template')) continue;
      const base = def.filename.replace(/\.gac$/, '').replace(EDITION_SUFFIX, '');
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(def);
    }
    let inherited = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const field of INHERITABLE_STAT_FIELDS) {
        const source = members.find((m) => m.fields[field] !== undefined);
        if (!source) continue;
        for (const m of members) {
          if (m.fields[field] === undefined) {
            m.fields[field] = source.fields[field];
            m._inheritedFields = m._inheritedFields || new Set();
            m._inheritedFields.add(field);
            inherited++;
          }
        }
      }
    }
    this._editionInheritanceCount = inherited;
  }

  get(filename) {
    return this.byFilename.get(filename);
  }

  getByUNID(unid) {
    return this.byUNID.get(unid);
  }
}
