import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authenticate, authModule, bootstrapAccount, executeAuthorized, login, revokeSession, totpCode } from '../packages/runtime/auth.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', mfaKey = 'ab'.repeat(32), password = 'local-test-password-2026';
const now = 1_800_000_000_000;
function setup(roles = ['content_reviewer']) {
  const store = new RuntimeStore(':memory:', { communityId: 'auth-tests', modules: [authModule] });
  bootstrapAccount(store, { id: 'editor-one', displayName: 'Named Editor', password, totpSecret: secret, roles }, { mfaKey, now });
  return store;
}
const signIn = (store, time = now) => login(store, { accountId: 'editor-one', password, code: totpCode(secret, time) }, { mfaKey, now: time });

test('named provider requires password + real RFC TOTP, prevents replay and stores no bearer or plaintext MFA secret', () => {
  assert.equal(totpCode(secret, 59_000), '287082');
  const store = setup();
  try {
    assert.throws(() => login(store, { accountId: 'editor-one', password: 'incorrect', code: totpCode(secret, now) }, { mfaKey, now }), { code: 'INVALID_CREDENTIALS' });
    assert.throws(() => login(store, { accountId: 'editor-one', password, code: '000000' }, { mfaKey, now }), { code: 'INVALID_CREDENTIALS' });
    const session = signIn(store);
    assert.equal(session.principal.id, 'editor-one'); assert.equal(session.principal.mfa, true);
    assert.throws(() => signIn(store), { code: 'INVALID_CREDENTIALS' });
    const serialized = JSON.stringify(store.read());
    assert.ok(!serialized.includes(session.token)); assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(password));
    assert.equal(store.read().audit.filter(event => event.action === 'session.login').length, 1);
  } finally { store.close(); }
});

test('publication execution verifies server principal, rolls back rejected operations, and scopes immutable idempotency results', () => {
  const store = setup();
  try {
    const { token } = signIn(store);
    const options = { permission: 'content:publish', action: 'content.publish', key: 'publish-key-0001', input: { author: 'forged-admin', expectedVersion: 0 }, now };
    const before = store.read();
    assert.throws(() => executeAuthorized(store, '', options, () => ({})), { code: 'UNAUTHENTICATED' });
    assert.throws(() => executeAuthorized(store, token, options, state => { state.modules.auth.accounts[0].displayName = 'bad'; throw new Error('missing evidence'); }), /missing evidence/);
    assert.deepEqual(store.read(), before);
    let executions = 0;
    const handler = (state, principal) => { executions++; assert.equal(principal.id, 'editor-one'); return { entityId: 'answer-1', version: 1 }; };
    assert.deepEqual(executeAuthorized(store, token, options, handler), { entityId: 'answer-1', version: 1 });
    assert.deepEqual(executeAuthorized(store, token, options, handler), { entityId: 'answer-1', version: 1 });
    assert.equal(executions, 1);
    assert.equal(store.read().audit.at(-1).actorId, 'editor-one');
    assert.ok(!JSON.stringify(store.read().audit).includes('forged-admin'));
    assert.throws(() => executeAuthorized(store, token, { ...options, input: { expectedVersion: 2 } }, handler), { code: 'IDEMPOTENCY_CONFLICT' });
    revokeSession(store, token, { now });
    assert.throws(() => executeAuthorized(store, token, options, handler), { code: 'UNAUTHENTICATED' });
  } finally { store.close(); }
});

test('roles are configured server-side, session revocation and account disable are checked on every transaction', () => {
  const store = setup(['custom_writer']);
  try {
    const session = signIn(store);
    const options = { permission: 'content:publish', action: 'content.publish', input: {}, policy: { custom_writer: ['content:edit'] }, now };
    assert.throws(() => executeAuthorized(store, session.token, options, () => ({})), { code: 'FORBIDDEN' });
    assert.deepEqual(executeAuthorized(store, session.token, { ...options, policy: { custom_writer: ['content:publish'] } }, () => ({ ok: true })), { ok: true });
    assert.throws(() => store.transact(state => authenticate(state, session.token, { now: now + 31 * 60_000 })), { code: 'UNAUTHENTICATED' });
    store.transact(state => { state.modules.auth.accounts[0].active = false; });
    assert.throws(() => executeAuthorized(store, session.token, options, () => ({})), { code: 'UNAUTHENTICATED' });
  } finally { store.close(); }
});

test('MFA login failures persist rate limits across attempts', () => {
  const store = setup();
  try {
    for (let attempt = 0; attempt < 8; attempt++) assert.throws(() => login(store, { accountId: 'editor-one', password: 'wrong', code: '000000' }, { mfaKey, now }), { code: 'INVALID_CREDENTIALS' });
    assert.throws(() => signIn(store), { code: 'RATE_LIMITED' });
    assert.equal(signIn(store, now + 16 * 60_000).principal.id, 'editor-one');
  } finally { store.close(); }
});
