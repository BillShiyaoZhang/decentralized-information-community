import { DatabaseSync } from 'node:sqlite';
import { applyChange, validateGraph } from '../packages/core/index.js';

/** Every accepted proposal stores an immutable snapshot and its proposal atomically. */
export class SqliteStore {
  constructor(filename, seed) {
    validateGraph(seed);
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS snapshots (revision INTEGER PRIMARY KEY, graph TEXT NOT NULL, change_json TEXT, accepted_at TEXT NOT NULL);
    `);
    if (!this.db.prepare('SELECT revision FROM snapshots LIMIT 1').get()) {
      this.db.prepare('INSERT INTO snapshots VALUES (?, ?, NULL, ?)').run(seed.revision, JSON.stringify(seed), new Date().toISOString());
    }
    const existing = this.load();
    if (existing.id !== seed.id) { this.db.close(); throw new Error('数据库属于另一个社区，请使用独立 DATA_DIR'); }
  }
  load() { return validateGraph(JSON.parse(this.db.prepare('SELECT graph FROM snapshots ORDER BY revision DESC LIMIT 1').get().graph)); }
  commit(change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = applyChange(this.load(), change);
      this.db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?)').run(next.revision, JSON.stringify(next), JSON.stringify(change), new Date().toISOString());
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
