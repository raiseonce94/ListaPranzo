'use strict';
/**
 * Zero-dependency persistent store.
 * Each collection is backed by a JSON file in data/.
 * All operations run synchronously (Node single-thread is safe).
 */
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class Store {
  constructor(name) {
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.rows = [];
    this.seq  = 1;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const { rows, seq } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.rows = rows || [];
        this.seq  = seq  || this.rows.length + 1;
      }
    } catch (_) { /* start fresh */ }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify({ rows: this.rows, seq: this.seq }, null, 2));
  }

  /** Insert a new document; returns it with auto-increment numeric id. */
  insert(doc) {
    const row = { id: this.seq++, ...doc };
    this.rows.push(row);
    this._save();
    return row;
  }

  /** Return all rows where every key in query strictly equals the row's value. */
  find(query = {}) {
    const keys = Object.keys(query);
    if (!keys.length) return [...this.rows];
    return this.rows.filter(r => keys.every(k => r[k] === query[k]));
  }

  findOne(query = {}) {
    return this.find(query)[0] ?? null;
  }

  /** Shallow-patch all rows matching query with patch fields. Returns changed count. */
  update(query, patch) {
    let changed = 0;
    const keys = Object.keys(query);
    this.rows = this.rows.map(r => {
      if (keys.every(k => r[k] === query[k])) { changed++; return { ...r, ...patch }; }
      return r;
    });
    if (changed) this._save();
    return changed;
  }

  /** Update first match if exists, insert if not. Returns the final row. */
  upsert(query, data) {
    if (this.findOne(query)) {
      this.update(query, data);
      return this.findOne(query);
    }
    return this.insert({ ...query, ...data });
  }

  /** Remove all rows matching query. Returns removed count. */
  remove(query) {
    const before = this.rows.length;
    const keys   = Object.keys(query);
    this.rows = this.rows.filter(r => !keys.every(k => r[k] === query[k]));
    const changed = before - this.rows.length;
    if (changed) this._save();
    return changed;
  }
}

module.exports = {
  places:         new Store('places'),
  menus:          new Store('menus'),
  session:        new Store('session'),
  votes:          new Store('votes'),
  orders:         new Store('orders'),
  users:          new Store('users'),
  preorders:      new Store('preorders'),
  asporto:        new Store('asporto'),
  audit:          new Store('audit'),
  groups:         new Store('groups'),
  group_requests: new Store('group_requests'),
  join_requests:  new Store('join_requests'),
};
