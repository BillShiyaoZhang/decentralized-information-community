import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, authenticate, authenticateIdentity, bootstrapAccount, executeAuthorized, inspectAccountsOffline, localIdentityProvider, login, maintainAccountOffline, revokeIdentitySubject, totpCode } from '../packages/runtime/auth.mjs';
import { contentModule } from '../packages/runtime/content.mjs';
import { lifecycleModule, lifecycleCommand } from '../packages/runtime/lifecycle.mjs';
import { participantsModule } from '../packages/runtime/participants.mjs';
import { reportsModule } from '../packages/runtime/reports.mjs';

const now = 1_800_000_000_000, mfaKey = 'ab'.repeat(32), operatorId = 'named-offline-operator';
const password = 'old-account-password-2026', newPassword = 'new-account-password-2026';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', newSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const profile = JSON.parse(readFileSync(new URL('../examples/runtime/content-profile.json', import.meta.url)));
const config = JSON.parse(readFileSync(new URL('../examples/runtime/lifecycle.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const dtoKeys = ['active', 'credentialsRequired', 'displayName', 'id', 'revokedAt', 'roles', 'version'];
function empty(t, full = false) {
  const modules = [authModule];
  if (full) modules.push({ ...contentModule, initialState: () => contentModule.initialState({ profile }) }, lifecycleModule, participantsModule, reportsModule);
  const store = new RuntimeStore(':memory:', { communityId: 'account-tests', modules });
  t.after(() => store.close()); return store;
}
function setup(t, full = false) {
  const store = empty(t, full);
  for (const id of ['editor', 'other']) bootstrapAccount(store, { id, displayName: `Named ${id}`, password, totpSecret: secret, roles: ['content_reviewer'] }, { mfaKey, now });
  return store;
}
const signIn = (store, id = 'editor', time = now, pass = password, totp = secret) => login(store, { accountId: id, password: pass, code: totpCode(totp, time) }, { mfaKey, now: time });
const account = store => store.read().modules.auth.accounts.find(value => value.id === 'editor');
const maintain = (store, input, options = {}) => maintainAccountOffline(store, { accountId: 'editor', expectedVersion: account(store).version, ...input }, { operatorId, mfaKey, now, ...options });
const authenticateToken = (store, token, time = now) => store.transact(state => authenticate(state, token, { now: time }));

test('offline account inspection requires a named operator and returns only whitelist DTOs', t => {
  const store = setup(t), before = store.read();
  for (const options of [{}, { operatorId: '' }, { operatorId: 'operator with spaces' }, { principal: { id: operatorId, mfa: true } }]) assert.throws(() => inspectAccountsOffline(store, options), { code: 'OFFLINE_OPERATOR_REQUIRED' });
  const result = inspectAccountsOffline(store, { operatorId });
  assert.equal(result.length, 2);
  for (const value of result) { assert.deepEqual(Object.keys(value).sort(), dtoKeys); assert.equal(value.version, 0); assert.equal(value.credentialsRequired, false); }
  result[0].roles.push('operations_admin');
  assert.deepEqual(store.read(), before);
});

test('password replacement preserves stable identity and used TOTP counter while invalidating only target sessions and retries', t => {
  const store = setup(t), oldSession = signIn(store), otherSession = signIn(store, 'other');
  const laterSession = signIn(store, 'editor', now + 30_000);
  store.transact(state => {
    state.idempotency.editor = { subjectId: 'editor', action: 'private.export', result: { id: 'private-record' } };
    state.idempotency.other = { subjectId: 'other', action: 'private.export', result: { id: 'other-record' } };
    state.modules.auth.failures[hash('editor')] = { count: 7, until: now + 900_000 };
    state.modules.auth.failures[hash('other')] = { count: 2, until: now + 900_000 };
  });
  const before = store.read(), original = account(store), result = maintain(store, { action: 'credentials', password: newPassword }, { now: now + 30_000, mfaKey: undefined });
  assert.deepEqual(result, { id: 'editor', displayName: 'Named editor', roles: ['content_reviewer'], active: true, version: 1, credentialsRequired: false, revokedAt: null });
  assert.equal(account(store).lastTotpCounter, original.lastTotpCounter);
  assert.deepEqual(account(store).mfa, original.mfa);
  for (const token of [oldSession.token, laterSession.token]) assert.throws(() => authenticateToken(store, token, now + 30_000), { code: 'UNAUTHENTICATED' });
  assert.equal(authenticateToken(store, otherSession.token, now + 30_000).id, 'other');
  assert.deepEqual(store.read().idempotency, { other: before.idempotency.other });
  assert.equal(store.read().modules.auth.failures[hash('editor')], undefined);
  assert.deepEqual(store.read().modules.auth.failures[hash('other')], before.modules.auth.failures[hash('other')]);
  assert.throws(() => signIn(store, 'editor', now + 30_000, newPassword), { code: 'INVALID_CREDENTIALS' });
  assert.throws(() => signIn(store, 'editor', now + 60_000), { code: 'INVALID_CREDENTIALS' });
  assert.equal(signIn(store, 'editor', now + 60_000, newPassword).principal.id, 'editor');
  const event = store.read().audit.find(value => value.action === 'account.credentials');
  assert.equal(event.actorId, operatorId); assert.equal(event.targetId, 'editor');
  assert.ok(!JSON.stringify(store.read()).includes(newPassword));
  assert.ok(!JSON.stringify(store.read().audit).includes('password'));
});

test('TOTP replacement works after device loss and duplicate secret cannot reopen a used counter', t => {
  const store = setup(t), old = signIn(store), counter = account(store).lastTotpCounter;
  maintain(store, { action: 'credentials', totpSecret: secret });
  assert.equal(account(store).lastTotpCounter, counter);
  assert.throws(() => signIn(store), { code: 'INVALID_CREDENTIALS' });
  const previousPassword = account(store).passwordHash;
  maintain(store, { action: 'credentials', totpSecret: newSecret });
  assert.equal(account(store).passwordHash, previousPassword);
  assert.equal(account(store).lastTotpCounter, -1);
  assert.throws(() => authenticateToken(store, old.token), { code: 'UNAUTHENTICATED' });
  assert.throws(() => signIn(store), { code: 'INVALID_CREDENTIALS' });
  assert.equal(signIn(store, 'editor', now, password, newSecret).principal.id, 'editor');
  assert.ok(!JSON.stringify(store.read()).includes(newSecret));
});

test('equivalent Base32 representations of the same TOTP key cannot reset replay protection', t => {
  const store = setup(t), used = signIn(store), counter = account(store).lastTotpCounter;
  // One extra character adds unused partial bits; two and eight add zero bytes,
  // which HMAC also treats as the same key through its block padding.
  for (const suffix of ['A', 'AA', 'AAAAAAAA']) {
    const alias = `${secret}${suffix}`;
    assert.equal(totpCode(alias, now), totpCode(secret, now));
    maintain(store, { action: 'credentials', totpSecret: alias });
    assert.equal(account(store).lastTotpCounter, counter);
    assert.throws(() => authenticateToken(store, used.token), { code: 'UNAUTHENTICATED' });
    assert.throws(() => signIn(store, 'editor', now, password, alias), { code: 'INVALID_CREDENTIALS' });
  }
  assert.equal(signIn(store, 'editor', now + 30_000, password, `${secret}AAAAAAAA`).principal.id, 'editor');
});

test('invalid maintenance, forged principal fields, conflicts and repeated requests leave the entire state unchanged', t => {
  const store = setup(t), session = signIn(store);
  const base = { action: 'credentials', accountId: 'editor', expectedVersion: 0, password: newPassword };
  const attempts = [
    [{ ...base }, {}], [{ ...base }, { operatorId: 'invalid operator' }],
    [{ ...base, principal: { id: 'root', mfa: true } }], [{ ...base, mfa: true }], [{ ...base, roles: ['operations_admin'] }],
    [{ ...base, expectedVersion: -1 }], [{ ...base, expectedVersion: 1.5 }], [{ ...base, expectedVersion: undefined }],
    [{ ...base, expectedVersion: 1 }], [{ ...base, action: 'recover' }], [{ ...base, password: 'too-short' }],
    [{ ...base, accountId: 'missing-account' }], [{ action: 'credentials', accountId: 'editor', expectedVersion: 0 }],
    [{ action: 'credentials', accountId: 'editor', expectedVersion: 0, totpSecret: 'invalid' }],
    [{ action: 'roles', accountId: 'editor', expectedVersion: 0, roles: [] }],
    [{ action: 'status', accountId: 'editor', expectedVersion: 0, active: 'true' }],
    [{ ...base, totpSecret: newSecret }, { operatorId, mfaKey: 'invalid-key' }],
  ];
  for (const [input, options = { operatorId, mfaKey }] of attempts) {
    const before = store.read();
    assert.throws(() => maintainAccountOffline(store, input, { now, ...options }));
    assert.deepEqual(store.read(), before);
  }
  maintainAccountOffline(store, base, { operatorId, mfaKey, now });
  const after = store.read();
  assert.throws(() => maintainAccountOffline(store, base, { operatorId, mfaKey, now }), { code: 'ACCOUNT_VERSION_CONFLICT', status: 409 });
  assert.deepEqual(store.read(), after);
  assert.throws(() => authenticateToken(store, session.token), { code: 'UNAUTHENTICATED' });
});

test('a failed module validation rolls back changed credentials, session revocation, retry deletion and audit together', t => {
  let deny = false;
  const extra = { name: 'policy', schemaVersion: 1, initialState: () => ({}), validate: () => { if (deny) throw new Error('policy denies commit'); } };
  const store = new RuntimeStore(':memory:', { communityId: 'account-rollback', modules: [authModule, extra] }); t.after(() => store.close());
  bootstrapAccount(store, { id: 'editor', displayName: 'Editor', roles: ['content_reviewer'], password, totpSecret: secret }, { mfaKey, now });
  signIn(store);
  store.transact(state => { state.idempotency.old = { subjectId: 'editor', result: { ok: true } }; });
  const before = store.read(); deny = true;
  assert.throws(() => maintain(store, { action: 'credentials', password: newPassword, totpSecret: newSecret }), /policy denies commit/);
  assert.deepEqual(store.read(), before);
});

test('role changes take effect on new MFA sessions, suspension is reversible, and explicit revoke preserves credentials', t => {
  const store = setup(t), old = signIn(store), other = signIn(store, 'other');
  const originalHash = account(store).passwordHash;
  maintain(store, { action: 'roles', roles: ['content_editor'] });
  assert.throws(() => authenticateToken(store, old.token), { code: 'UNAUTHENTICATED' });
  const editor = signIn(store, 'editor', now + 30_000);
  assert.deepEqual(editor.principal.roles, ['content_editor']);
  assert.throws(() => executeAuthorized(store, editor.token, { action: 'content.publish', permission: 'content:publish', now: now + 30_000 }, () => ({})), { code: 'FORBIDDEN' });
  maintain(store, { action: 'status', active: false });
  assert.equal(account(store).revokedAt, null);
  assert.throws(() => signIn(store, 'editor', now + 60_000), { code: 'INVALID_CREDENTIALS' });
  maintain(store, { action: 'status', active: true });
  const reactivated = signIn(store, 'editor', now + 60_000);
  maintain(store, { action: 'revoke-sessions' });
  assert.throws(() => authenticateToken(store, reactivated.token, now + 60_000), { code: 'UNAUTHENTICATED' });
  assert.equal(account(store).passwordHash, originalHash);
  assert.equal(account(store).version, 4);
  assert.equal(authenticateToken(store, other.token, now + 60_000).id, 'other');
  assert.equal(signIn(store, 'editor', now + 90_000).principal.id, 'editor');
});

test('permanent revocation in auth-only deployments has an immutable tombstone including unknown IDs', t => {
  const store = setup(t), session = signIn(store);
  store.transact(state => revokeIdentitySubject(state, 'editor', { now }));
  assert.equal(account(store).revokedAt, now); assert.equal(account(store).active, false); assert.equal(account(store).version, 1);
  assert.throws(() => authenticateToken(store, session.token), { code: 'UNAUTHENTICATED' });
  for (const input of [{ action: 'status', active: true }, { action: 'roles', roles: ['account_admin'] }, { action: 'credentials', password: newPassword, totpSecret: newSecret }]) {
    const before = store.read(); assert.throws(() => maintain(store, input), { code: 'ACCOUNT_REVOKED' }); assert.deepEqual(store.read(), before);
  }
  for (const mutate of [state => { state.modules.auth.accounts[0].active = true; }, state => { state.modules.auth.accounts[0].revokedAt = null; state.modules.auth.revokedSubjectIds = []; }, state => { state.modules.auth.accounts.shift(); }]) {
    const before = store.read(); assert.throws(() => store.transact(mutate)); assert.deepEqual(store.read(), before);
  }
  store.transact(state => revokeIdentitySubject(state, 'future-withdrawn', { now }));
  assert.throws(() => bootstrapAccount(store, { id: 'future-withdrawn', displayName: 'No revival', roles: ['participant'], password, totpSecret: secret }, { mfaKey, now }), { code: 'ACCOUNT_REVOKED' });
});

test('privacy withdrawal with all five runtime modules cannot be undone by account reactivation or recovery', t => {
  const store = setup(t, true), session = signIn(store);
  store.transact(state => lifecycleCommand(state, session.principal, { action: 'consent', type: 'private_intake', version: '2026-09', accepted: true, eligibility: { adult: true, eligible: true } }, { config, now }));
  store.transact(state => lifecycleCommand(state, session.principal, { action: 'withdraw' }, { config, now }));
  assert.equal(account(store).revokedAt, now);
  assert.equal(store.read().modules.lifecycle.subjects.editor.withdrawnAt, now);
  assert.equal(store.read().modules.participants.subjects.find(value => value.id === 'editor').revokedAt, now);
  assert.throws(() => maintain(store, { action: 'status', active: true }), { code: 'ACCOUNT_REVOKED' });
  assert.throws(() => maintain(store, { action: 'credentials', password: newPassword, totpSecret: newSecret }), { code: 'ACCOUNT_REVOKED' });
});

test('restore locks all named credentials until full offline recovery and never revives old password, TOTP or sessions', t => {
  const source = setup(t), old = signIn(source), backup = source.backup(), target = empty(t), initial = target.read();
  assert.throws(() => target.restore(backup, { now }), { code: 'ACCOUNT_RECONCILIATION_REQUIRED' }); assert.deepEqual(target.read(), initial);
  assert.throws(() => target.restore(backup, { now, revokedSubjectIds: ['bad subject'] }), { code: 'INVALID_REVOCATION_REGISTER' }); assert.deepEqual(target.read(), initial);
  target.restore(backup, { now, revokedSubjectIds: [] });
  assert.equal(account(target).version, 1); assert.equal(account(target).credentialsRequired, true);
  assert.equal(account(target).passwordHash, null); assert.equal(account(target).passwordSalt, null); assert.equal(account(target).mfa, null);
  assert.throws(() => signIn(target), { code: 'INVALID_CREDENTIALS' });
  assert.throws(() => authenticateToken(target, old.token), { code: 'UNAUTHENTICATED' });
  maintain(target, { action: 'status', active: true }); maintain(target, { action: 'roles', roles: ['content_reviewer'] });
  assert.throws(() => signIn(target, 'editor', now + 30_000), { code: 'INVALID_CREDENTIALS' });
  for (const credentials of [{ password: newPassword }, { totpSecret: newSecret }]) {
    const before = target.read(); assert.throws(() => maintain(target, { action: 'credentials', ...credentials }), { code: 'ACCOUNT_CREDENTIALS_REQUIRED' }); assert.deepEqual(target.read(), before);
  }
  maintain(target, { action: 'credentials', password: newPassword, totpSecret: newSecret });
  assert.equal(account(target).credentialsRequired, false);
  assert.throws(() => signIn(target, 'editor', now + 60_000, password, newSecret), { code: 'INVALID_CREDENTIALS' });
  assert.throws(() => signIn(target, 'editor', now + 60_000, newPassword, secret), { code: 'INVALID_CREDENTIALS' });
  assert.equal(signIn(target, 'editor', now + 60_000, newPassword, newSecret).principal.id, 'editor');
  assert.equal(target.read().modules.auth.accounts.find(value => value.id === 'other').credentialsRequired, true);
});

test('old backups reconcile permanent revocations and preserve unknown tombstones after account recovery', t => {
  const source = setup(t), backup = source.backup(), target = empty(t);
  source.transact(state => revokeIdentitySubject(state, 'editor', { now }));
  target.restore(backup, { now, revokedSubjectIds: ['editor', 'future-withdrawn'] });
  assert.equal(account(target).revokedAt, now);
  assert.throws(() => maintain(target, { action: 'credentials', password: newPassword, totpSecret: newSecret }), { code: 'ACCOUNT_REVOKED' });
  assert.throws(() => bootstrapAccount(target, { id: 'future-withdrawn', displayName: 'Revoked', roles: ['participant'], password, totpSecret: secret }, { mfaKey, now }), { code: 'ACCOUNT_REVOKED' });
});

test('custom provider restore hook cannot skip built-in credential locking and failure rolls back the whole restore', t => {
  const source = setup(t), backup = source.backup(), target = empty(t);
  let called = 0;
  const provider = { ...localIdentityProvider, prepareRestore(state) { called++; state.modules.auth.revokedSubjectIds = []; return { custom: true }; } };
  target.restore(backup, { provider, now, revokedSubjectIds: ['future-withdrawn'] });
  assert.equal(called, 1); assert.equal(account(target).credentialsRequired, true);
  assert.ok(target.read().modules.auth.revokedSubjectIds.includes('future-withdrawn'));
  assert.throws(() => signIn(target), { code: 'INVALID_CREDENTIALS' });
  assert.throws(() => target.transact(state => authenticateIdentity(state, 'external-token', { provider: { authenticate: () => ({ id: 'future-withdrawn', mfa: true, roles: ['account_admin'] }) }, now })), { code: 'UNAUTHENTICATED' });
  const failed = empty(t), initial = failed.read();
  assert.throws(() => failed.restore(backup, { provider: { prepareRestore(state) { state.modules.auth.accounts[0].roles = ['account_admin']; throw new Error('provider unavailable'); } }, now, revokedSubjectIds: [] }), /provider unavailable/);
  assert.deepEqual(failed.read(), initial);
});
