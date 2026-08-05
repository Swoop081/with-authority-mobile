import { parseScript } from './parser.js';

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
    this.fields = raw.fields || {};
    this.assets = raw.assets || [];
    this._astCache = new Map();
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

  // Browser-side loader: fetches the pre-bundled JSON instead of
  // reading a directory off disk.
  static async loadFromUrl(cardsJsonUrl) {
    const db = new CardDatabase();
    const bundle = await fetch(cardsJsonUrl).then((r) => r.json());
    for (const [filename, raw] of Object.entries(bundle.cards)) {
      const def = new CardDefinition(raw, filename);
      db.byFilename.set(filename, def);
    }
    if (bundle.unidMap) {
      for (const [unid, filename] of Object.entries(bundle.unidMap)) {
        const def = db.byFilename.get(filename);
        if (def) {
          db.byUNID.set(Number(unid), def);
          def.unid = Number(unid);
        }
      }
    }
    db.resolveEditionInheritance();
    return db;
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
