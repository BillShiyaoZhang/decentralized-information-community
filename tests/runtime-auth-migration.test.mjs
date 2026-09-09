import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, authenticate, bootstrapAccount, inspectAccountsOffline, login, maintainAccountOffline, totpCode } from '../packages/runtime/auth.mjs';

const now = 1_800_000_000_000, mfaKey = 'ab'.repeat(32), password = 'legacy-migration-password-2026';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', operatorId = 'reviewed-operator';
function legacyFixture() {
  const source = new RuntimeStore(':memory:', { communityId: 'auth-upgrade', modules: [authModule] });
  try {
    for (const id of ['active-account', 'old-disabled']) bootstrapAccount(source, { id, displayName: id, password, totpSecret: secret, roles: ['content_reviewer'] }, { mfaKey, now });
    const session = login(source, { accountId: 'active-account', password, code: totpCode(secret, now) }, { mfaKey, now });
    const backup = source.backup();
    backup.state.moduleVersions.auth = 1;
    delete backup.state.modules.auth.revokedSubjectIds;
    for (const account of backup.state.modules.auth.accounts) {
      delete account.version; delete account.credentialsRequired; delete account.revokedAt;
      if (account.id === 'old-disabled') account.active = false;
    }
    return { backup, session };
  } finally { source.close(); }
}
const legacyModule = {
  name: 'auth', schemaVersion: 1, initialState: () => ({ accounts: [], sessions: [], failures: {} }),
  validate(data) { assert.ok(Array.isArray(data.accounts)); assert.ok(Array.isArray(data.sessions)); },
};

test('auth schema 1 database upgrade preserves active identity and sessions, and treats legacy disabled accounts as permanently revoked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-auth-upgrade-')), filename = join(directory, 'old.sqlite');
  const { backup, session } = legacyFixture();
  try {
    const old = new RuntimeStore(filename, { communityId: 'auth-upgrade', modules: [legacyModule] });
    old.transact(state => { state.modules.auth = structuredClone(backup.state.modules.auth); state.audit = structuredClone(backup.state.audit); }); old.close();
    const upgraded = new RuntimeStore(filename, { communityId: 'auth-upgrade', modules: [authModule] });
    try {
      const state = upgraded.read(); assert.equal(state.moduleVersions.auth, 2);
      assert.deepEqual(state.audit, backup.state.audit);
      assert.equal(state.modules.auth.accounts[0].passwordHash, backup.state.modules.auth.accounts[0].passwordHash);
      assert.equal(upgraded.transact(data => authenticate(data, session.token, { now })).id, 'active-account');
      const accounts = inspectAccountsOffline(upgraded, { operatorId });
      assert.equal(accounts[0].version, 0); assert.equal(accounts[0].credentialsRequired, false);
      assert.equal(accounts[1].revokedAt, 0);
      assert.throws(() => maintainAccountOffline(upgraded, { action: 'status', accountId: 'old-disabled', expectedVersion: 0, active: true }, { operatorId, now }), { code: 'ACCOUNT_REVOKED' });
    } finally { upgraded.close(); }
    assert.throws(() => new RuntimeStore(filename, { communityId: 'auth-upgrade', modules: [legacyModule] }), { code: 'INCOMPATIBLE_MODULE' });
  } finally {
    const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('runtime-auth-upgrade-')); await rm(target, { recursive: true, force: true });
  }
});

test('restoring a schema 1 backup migrates atomically and requires full credential re-enrollment plus current revocation review', () => {
  const { backup, session } = legacyFixture(), target = new RuntimeStore(':memory:', { communityId: 'auth-upgrade', modules: [authModule] });
  try {
    const before = target.read();
    assert.throws(() => target.restore(backup, { now }), { code: 'ACCOUNT_RECONCILIATION_REQUIRED' }); assert.deepEqual(target.read(), before);
    const result = target.restore(backup, { now, revokedSubjectIds: ['not-in-backup'], withdrawnSubjectIds: [] });
    assert.equal(result.accountsRequiringCredentials, 1);
    const restored = target.read(); assert.equal(restored.moduleVersions.auth, 2);
    assert.ok(restored.modules.auth.accounts.every(account => account.credentialsRequired && account.mfa === null && account.passwordHash === null && account.passwordSalt === null));
    assert.throws(() => target.transact(state => authenticate(state, session.token, { now })), { code: 'UNAUTHENTICATED' });
    assert.throws(() => login(target, { accountId: 'active-account', password, code: totpCode(secret, now + 30000) }, { mfaKey, now: now + 30000 }), { code: 'INVALID_CREDENTIALS' });
    assert.throws(() => bootstrapAccount(target, { id: 'not-in-backup', displayName: 'Cannot return', password, totpSecret: secret, roles: ['content_reviewer'] }, { mfaKey, now }), { code: 'ACCOUNT_REVOKED' });
    assert.deepEqual(backup.state.moduleVersions, { auth: 1 });
  } finally { target.close(); }
});

test('backup migration failures and malformed legacy credentials leave the new target empty', () => {
  const { backup } = legacyFixture();
  for (const module of [
    { ...authModule, migrations: {} },
    { ...authModule, migrations: { 2: () => { throw new Error('migration failure'); } } },
    { ...authModule, migrations: { 2: () => Promise.resolve({}) } },
  ]) {
    const target = new RuntimeStore(':memory:', { communityId: 'auth-upgrade', modules: [module] });
    try { const before = target.read(); assert.throws(() => target.restore(backup, { now, revokedSubjectIds: [] })); assert.deepEqual(target.read(), before); }
    finally { target.close(); }
  }
  const target = new RuntimeStore(':memory:', { communityId: 'auth-upgrade', modules: [authModule] });
  try {
    const broken = structuredClone(backup); broken.state.modules.auth.accounts[0].passwordHash = 'malformed';
    const before = target.read(); assert.throws(() => target.restore(broken, { now, revokedSubjectIds: [] })); assert.deepEqual(target.read(), before);
  } finally { target.close(); }
});
