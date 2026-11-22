// Имитация Cloudflare D1 поверх встроенной SQLite в Node — для локальных тестов
import { DatabaseSync } from 'node:sqlite';
const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const fix = (row) => { if (!row) return row; for (const k in row) if (typeof row[k] === 'bigint') row[k] = Number(row[k]); return row; };
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { const s = new Stmt(this.db, this.sql); s.args = norm(a); const n = this.db.prepare(this.sql).paramsCount ?? (this.sql.match(/\?/g) || []).length; if (n !== s.args.length) throw new Error('D1_ERROR: Wrong number of parameter bindings for SQL query. ' + n + ' vs ' + s.args.length + ' :: ' + this.sql.slice(0, 120)); return s; }
  async first() { return fix(this.db.prepare(this.sql).get(...this.args)) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map(fix) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; }
  runSync() { return this.db.prepare(this.sql).run(...this.args); }
}
export class D1Shim {
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec('PRAGMA foreign_keys = ON'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = stmts.map((s) => s.runSync()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  exec(sql) { this.db.exec(sql); }
}
