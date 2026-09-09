import { DatabaseSync } from 'node:sqlite';
import { RuntimeError, jsonClone, canonicalJson } from './errors.mjs';

export const RUNTIME_CONTRACT_VERSION = 1;

/** Synchronous transaction interface. Modules are trusted deployment code, never request data. */
export class RuntimeStore {
  constructor(filename, { communityId, modules = [] } = {}) {
    if (typeof communityId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(communityId)) throw new RuntimeError('INVALID_CONFIG', 'A stable communityId is required');
    this.communityId = communityId;
    this.modules = new Map();
    for (const module of modules) {
      if (!module || !/^[a-z][a-z0-9-]*$/.test(module.name) || !Number.isSafeInteger(module.schemaVersion) || module.schemaVersion < 1 || typeof module.initialState !== 'function' || typeof module.validate !== 'function' || this.modules.has(module.name)) throw new RuntimeError('INVALID_MODULE', 'Module needs a unique name, schemaVersion, initialState and validate');
      if (module.contractVersion !== undefined && module.contractVersion !== RUNTIME_CONTRACT_VERSION) throw new RuntimeError('INCOMPATIBLE_MODULE', `Unsupported runtime contract for ${module.name}`);
      this.modules.set(module.name, module);
    }
    this.db = new DatabaseSync(filename);
    this.inTransaction = false;
    try {
      // No immutable database snapshots of private state; expired payloads must leave current storage.
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const existing = this.db.prepare('SELECT value FROM runtime_state WHERE id=1').get();
        const state = existing ? JSON.parse(existing.value) : this.emptyState();
        const previous = existing ? jsonClone(state) : undefined;
        this.migrateModules(state, { initializeMissing: true });
        this.validate(state, previous);
        this.db.prepare('INSERT INTO runtime_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(state));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  emptyState() { return { formatVersion: 1, communityId: this.communityId, revision: 0, modules: {}, moduleVersions: {}, audit: [], idempotency: {} }; }
  assertSync(result) {
    if (result && typeof result.then === 'function') throw new RuntimeError('ASYNC_TRANSACTION', 'Transaction and migration callbacks must be synchronous');
  }
  /** Open and restore use the same synchronous, rollback-protected upgrade path. */
  migrateModules(state, { initializeMissing = false } = {}) {
    if (!state || state.formatVersion !== 1 || state.communityId !== this.communityId) throw new RuntimeError('INCOMPATIBLE_DATABASE', 'Database format or community identity does not match');
    if (!state.modules || Array.isArray(state.modules) || typeof state.modules !== 'object' || !state.moduleVersions || Array.isArray(state.moduleVersions) || typeof state.moduleVersions !== 'object') throw new RuntimeError('INVALID_STATE', 'Invalid module envelope');
    for (const name of Object.keys(state.modules)) if (!this.modules.has(name)) throw new RuntimeError('MISSING_MODULE', `Stored module ${name} must be installed before opening this database`);
    for (const [name, module] of this.modules) {
      if (!Object.hasOwn(state.modules, name)) {
        if (!initializeMissing) throw new RuntimeError('INCOMPATIBLE_MODULE', `Backup is missing module ${name}`);
        state.modules[name] = jsonClone(module.initialState()); state.moduleVersions[name] = module.schemaVersion;
      }
      let version = state.moduleVersions[name];
      if (!Number.isSafeInteger(version) || version < 1 || version > module.schemaVersion) throw new RuntimeError('INCOMPATIBLE_MODULE', `Cannot downgrade ${name}`);
      while (version < module.schemaVersion) {
        const migrate = module.migrations?.[version + 1];
        if (typeof migrate !== 'function') throw new RuntimeError('MISSING_MIGRATION', `${name} needs a migration to version ${version + 1}`);
        const next = migrate(jsonClone(state.modules[name]), { fromVersion: version, toVersion: version + 1, communityId: this.communityId });
        this.assertSync(next); state.modules[name] = jsonClone(next); state.moduleVersions[name] = ++version;
      }
    }
  }
  validate(state, previous) {
    jsonClone(state);
    if (state.formatVersion !== 1 || state.communityId !== this.communityId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.audit) || !state.idempotency || Array.isArray(state.idempotency) || typeof state.idempotency !== 'object') throw new RuntimeError('INVALID_STATE', 'Invalid runtime envelope');
    if (Object.keys(state.modules).length !== this.modules.size || Object.keys(state.moduleVersions).length !== this.modules.size) throw new RuntimeError('INVALID_STATE', 'Module registration cannot change inside a transaction');
    for (const [name, module] of this.modules) {
      if (!(name in state.modules) || state.moduleVersions[name] !== module.schemaVersion) throw new RuntimeError('INCOMPATIBLE_MODULE', `Invalid module schema: ${name}`);
      this.assertSync(module.validate(state.modules[name], previous?.modules[name]));
    }
    for (const module of this.modules.values()) if (module.validateState) this.assertSync(module.validateState(state, previous));
  }
  /** Offline, explicit policy configuration change. Immutable data still compares to the prior state. */
  configureContentProfile(profile, { expectedRevision } = {}) {
    if (!this.modules.has('content')) throw new RuntimeError('MODULE_DISABLED', 'Content module is not installed');
    if (this.inTransaction) throw new RuntimeError('NESTED_TRANSACTION', 'Configuration cannot run inside a transaction');
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const previous = this.read(), state = jsonClone(previous);
      if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new RuntimeError('CONFLICT', 'Runtime revision has changed', 409);
      state.modules.content.profile = jsonClone(profile);
      // Allow exactly this policy replacement, keeping every revision/reference comparison intact.
      const comparison = jsonClone(previous); comparison.modules.content.profile = jsonClone(profile);
      this.validate(state, comparison);
      if (canonicalJson(state) !== canonicalJson(previous)) {
        state.revision++;
        state.audit.push({ action: 'content.configure', actorId: 'offline-administrator', at: Date.now() });
        this.db.prepare('UPDATE runtime_state SET value=? WHERE id=1').run(JSON.stringify(state));
      }
      this.db.exec('COMMIT'); return { configured: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  read() { return JSON.parse(this.db.prepare('SELECT value FROM runtime_state WHERE id=1').get().value); }
  transact(callback, { expectedRevision } = {}) {
    if (this.inTransaction) throw new RuntimeError('NESTED_TRANSACTION', 'Nested transactions are not supported');
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const previous = this.read(), state = jsonClone(previous);
      if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new RuntimeError('CONFLICT', 'Runtime revision has changed', 409);
      const result = callback(state); this.assertSync(result);
      const returned = result === undefined ? undefined : jsonClone(result);
      if (state.revision !== previous.revision) throw new RuntimeError('INVALID_STATE', 'Runtime revision is managed by the store');
      this.validate(state, previous);
      if (canonicalJson(state) !== canonicalJson(previous)) {
        state.revision++;
        this.db.prepare('UPDATE runtime_state SET value=? WHERE id=1').run(JSON.stringify(state));
      }
      this.db.exec('COMMIT');
      return returned;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  backup() { return { kind: 'private-runtime-backup', formatVersion: 1, createdAt: new Date().toISOString(), state: this.read() }; }
  /** Offline administrative restore into a fresh database. Sessions are never resurrected. */
  restore(backup, options = {}) {
    if (backup?.kind !== 'private-runtime-backup' || backup.formatVersion !== 1) throw new RuntimeError('INVALID_BACKUP', 'Expected a private runtime backup');
    if (this.inTransaction) throw new RuntimeError('NESTED_TRANSACTION', 'Restore cannot run inside a transaction');
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const state = this.read();
      if (state.revision !== 0 || state.audit.length || Object.keys(state.idempotency).length) throw new RuntimeError('RESTORE_NOT_EMPTY', 'Restore requires a new empty database', 409);
      for (const [name, module] of this.modules) if (canonicalJson(state.modules[name]) !== canonicalJson(module.initialState())) throw new RuntimeError('RESTORE_NOT_EMPTY', 'Restore requires a new empty database', 409);
      const restored = jsonClone(backup.state);
      this.migrateModules(restored);
      this.validate(restored);
      for (const module of this.modules.values()) if (module.prepareRestore) this.assertSync(module.prepareRestore(restored, options));
      restored.revision++;
      if (restored.modules.auth) restored.modules.auth.sessions = [];
      restored.idempotency = {};
      restored.audit.push({ action: 'runtime.restore', actor: 'offline-administrator', at: new Date().toISOString(), target: this.communityId });
      this.validate(restored);
      this.db.prepare('UPDATE runtime_state SET value=? WHERE id=1').run(JSON.stringify(restored));
      this.db.exec('COMMIT');
      return { restored: true, sessionsInvalidated: true, accountsRequiringCredentials: restored.modules.auth?.accounts.filter(account => account.credentialsRequired && account.revokedAt === null).length ?? 0 };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  close() { this.db.close(); }
}
