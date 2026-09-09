import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import * as auth from '../packages/runtime/auth.mjs';
import { contentModule } from '../packages/runtime/content.mjs';
import { lifecycleModule } from '../packages/runtime/lifecycle.mjs';
import { participantsModule } from '../packages/runtime/participants.mjs';
import { reportsModule } from '../packages/runtime/reports.mjs';
import { createRuntimeApp } from '../packages/runtime/http.mjs';

const password = 'account-maintenance-original-password';
const replacementPassword = 'account-maintenance-replacement-password';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const replacementSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const mfaKey = 'ab'.repeat(32), operatorId = 'offline-operator';
const participants = { role: 'participant', invitationTtlMs: 600_000, sessionTtlMs: 3_600_000, idleTtlMs: 600_000, selfService: { actions: ['list', 'logout'], types: ['report'] } };
const config = { workflows: { report: { initialState: 'submitted', states: ['submitted', 'resolved'], transitions: { submitted: ['resolved'], resolved: [] }, terminalStates: ['resolved'], decisionCodes: ['corrected'], publicResults: { corrected: { code: 'corrected', label: 'Corrected.' } }, retentionMs: 86_400_000, requireConsent: false, eligibilityFields: [] } } };

function contentFixture(now) {
  return { schemaVersion: 1, entities: [{ id: 'answer', type: 'document' }], revisions: [{ id: 'answer-v1', entityId: 'answer', number: 1, parentRevisionId: null, createdAt: new Date(now).toISOString(), data: { title: 'Account maintenance guide', origin: 'human', impact: 'low', sentences: [{ id: 'opinion-1', kind: 'opinion', text: 'Read the guide before contributing.' }] } }], citations: [], links: [] };
}
async function readOk(response) { const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; }
async function harness() {
  let now = Date.parse('2099-01-01T00:00:00.000Z');
  const store = new RuntimeStore(':memory:', { communityId: 'account-http', modules: [auth.authModule, contentModule, lifecycleModule, participantsModule, reportsModule] });
  for (const [id, roles] of [['reviewer', ['content_editor', 'content_reviewer', 'pilot_operator']], ['manager', ['account_admin', 'content_editor', 'pilot_operator']], ['ordinary', ['participant']]]) {
    auth.bootstrapAccount(store, { id, displayName: id, password, totpSecret: secret, roles }, { mfaKey, now });
  }
  const server = createRuntimeApp({ store, auth: { mfaKey, participants }, lifecycle: { config, keyring: { activeVersion: 'v1', keys: { v1: 'cd'.repeat(32) } } }, clock: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, token = '', key = randomUUID()) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: JSON.stringify(value) });
  const get = (path, token = '') => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const login = (accountId, suppliedPassword = password, suppliedSecret = secret) => post('/api/auth/login', { accountId, password: suppliedPassword, code: auth.totpCode(suppliedSecret, now) });
  const signIn = async (...args) => readOk(await login(...args));
  const maintain = input => auth.maintainAccountOffline(store, input, { operatorId, mfaKey, now });
  return { store, server, base, post, get, login, signIn, maintain, now: () => now, advance: (ms = 30_000) => { now += ms; }, close: async () => { await new Promise(resolve => server.close(resolve)); store.close(); } };
}

async function slowPost(h, path, value, token) {
  const encoded = JSON.stringify(value), received = once(h.server, 'request');
  const pending = request(h.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() } });
  const completed = new Promise((resolve, reject) => { pending.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); pending.on('error', reject); });
  pending.write(encoded.slice(0, 10));
  await received;
  return { finish: () => { pending.end(encoded.slice(10)); return completed; } };
}

test('HTTP named-account credential replacement preserves ownership and invalidates only target credentials, sessions and replay', async () => {
  const h = await harness();
  try {
    const first = await h.signIn('reviewer'), manager = await h.signIn('manager');
    h.advance(); const second = await h.signIn('reviewer');
    await readOk(await h.post('/api/content/import', contentFixture(h.now()), first.token, 'reviewer-import-once'));
    for (const [id, session] of [['reviewer-record', first], ['manager-record', manager]]) await readOk(await h.post('/api/private/command', { action: 'create', type: 'report', id, payload: { note: `Private ${id}` }, consentEpoch: 0 }, session.token, `create-${id}`));
    const before = h.store.read();
    assert.ok(Object.values(before.idempotency).some(value => value.subjectId === 'reviewer'));
    assert.ok(Object.values(before.idempotency).some(value => value.subjectId === 'manager'));
    const result = h.maintain({ action: 'credentials', accountId: 'reviewer', expectedVersion: 0, password: replacementPassword, totpSecret: replacementSecret });
    assert.equal(result.version, 1);
    const maintained = h.store.read();
    assert.deepEqual(maintained.modules.content, before.modules.content);
    assert.deepEqual(maintained.modules.lifecycle, before.modules.lifecycle);
    assert.equal(maintained.modules.lifecycle.records['reviewer-record'].subjectId, 'reviewer');
    assert.equal(maintained.modules.auth.accounts.find(value => value.id === 'reviewer').version, 1);
    assert.equal(Object.values(maintained.idempotency).some(value => value.subjectId === 'reviewer'), false);
    assert.deepEqual(Object.values(maintained.idempotency).filter(value => value.subjectId === 'manager'), Object.values(before.idempotency).filter(value => value.subjectId === 'manager'));
    for (const plaintext of [password, replacementPassword, secret, replacementSecret]) assert.ok(!JSON.stringify(maintained).includes(plaintext));
    for (const session of [first, second]) assert.equal((await h.get('/api/auth/me', session.token)).status, 401);
    assert.equal((await h.get('/api/auth/me', manager.token)).status, 200);
    assert.equal((await h.login('reviewer')).status, 401);
    assert.equal((await h.login('reviewer', replacementPassword, secret)).status, 401);
    assert.equal((await h.login('reviewer', password, replacementSecret)).status, 401);
    const recovered = await h.signIn('reviewer', replacementPassword, replacementSecret);
    assert.equal(recovered.principal.id, 'reviewer');
    assert.equal((await h.get('/api/private/reviewer-record', recovered.token)).status, 200);
  } finally { await h.close(); }
});

test('HTTP role changes and reversible suspension invalidate old sessions while permanent revocation cannot be enabled', async () => {
  const h = await harness();
  try {
    const reviewer = await h.signIn('reviewer'), manager = await h.signIn('manager');
    await readOk(await h.post('/api/content/import', contentFixture(h.now()), reviewer.token));
    assert.equal(h.maintain({ action: 'roles', accountId: 'reviewer', expectedVersion: 0, roles: ['content_editor'] }).version, 1);
    assert.equal((await h.get('/api/auth/me', reviewer.token)).status, 401);
    assert.equal((await h.get('/api/auth/me', manager.token)).status, 200);
    h.advance(); const editor = await h.signIn('reviewer');
    assert.deepEqual(editor.principal.roles, ['content_editor']);
    const beforePublication = h.store.read();
    assert.equal((await h.post('/api/content/publish', { entityId: 'answer', revisionId: 'answer-v1', expectedVersion: 0 }, editor.token)).status, 403);
    assert.deepEqual(h.store.read(), beforePublication);
    assert.equal(h.maintain({ action: 'status', accountId: 'reviewer', expectedVersion: 1, active: false }).version, 2);
    assert.equal((await h.get('/api/auth/me', editor.token)).status, 401);
    h.advance(); assert.equal((await h.login('reviewer')).status, 401);
    assert.equal(h.maintain({ action: 'status', accountId: 'reviewer', expectedVersion: 2, active: true }).version, 3);
    const enabled = await h.signIn('reviewer');
    assert.equal(enabled.principal.id, 'reviewer');
    assert.equal(h.store.read().modules.auth.accounts.find(value => value.id === 'reviewer').revokedAt, null);
    h.store.transact(state => auth.revokeIdentitySubject(state, 'reviewer', { now: h.now() }));
    const revoked = h.store.read(), account = revoked.modules.auth.accounts.find(value => value.id === 'reviewer');
    assert.notEqual(account.revokedAt, null);
    assert.throws(() => h.maintain({ action: 'status', accountId: 'reviewer', expectedVersion: account.version, active: true }), error => error.code === 'ACCOUNT_REVOKED');
    assert.deepEqual(h.store.read(), revoked);
    assert.equal((await h.get('/api/auth/me', enabled.token)).status, 401);
    h.advance(); assert.equal((await h.login('reviewer')).status, 401);
    assert.equal((await h.get('/api/auth/me', manager.token)).status, 200);
  } finally { await h.close(); }
});

test('every offline account maintenance action prevents a publication whose HTTP body is already uploading', async () => {
  for (const mutation of [{ action: 'credentials', password: replacementPassword }, { action: 'roles', roles: ['content_editor'] }, { action: 'status', active: false }, { action: 'revoke-sessions' }]) {
    const h = await harness();
    try {
      const reviewer = await h.signIn('reviewer'), manager = await h.signIn('manager');
      await readOk(await h.post('/api/content/import', contentFixture(h.now()), manager.token));
      const upload = await slowPost(h, '/api/content/publish', { entityId: 'answer', revisionId: 'answer-v1', expectedVersion: 0 }, reviewer.token);
      h.maintain({ ...mutation, accountId: 'reviewer', expectedVersion: 0 });
      const beforeFinish = h.store.read();
      assert.equal(await upload.finish(), 401, mutation.action);
      assert.deepEqual(h.store.read(), beforeFinish, `${mutation.action}: rejected upload changes no content, session, audit or replay state`);
      assert.equal(h.store.read().modules.content.entities[0].publicRevisionId, null);
      assert.equal((await h.get('/api/auth/me', manager.token)).status, 200);
    } finally { await h.close(); }
  }
});

test('credential recovery remains offline for anonymous, participant and named HTTP clients and bootstrap remains create-only', async () => {
  const h = await harness();
  try {
    const manager = await h.signIn('manager'), ordinary = await h.signIn('ordinary');
    const invitation = await readOk(await h.post('/api/participants/invitations', { eligibility: {} }, manager.token));
    const participant = await readOk(await h.post('/api/participants/redeem', { token: invitation.token }));
    const before = h.store.read();
    for (const token of ['', participant.token, ordinary.token, manager.token]) {
      for (const path of ['/api/auth/password', '/api/auth/totp', '/api/accounts/command', '/api/auth/bootstrap']) {
        assert.equal((await h.post(path, { action: 'credentials', accountId: 'reviewer', expectedVersion: 0, password: replacementPassword, totpSecret: replacementSecret }, token)).status, 404, path);
      }
    }
    assert.deepEqual(h.store.read(), before);
    assert.throws(() => auth.bootstrapAccount(h.store, { id: 'reviewer', displayName: 'Overwrite attempt', password: replacementPassword, totpSecret: replacementSecret, roles: ['account_admin'] }, { mfaKey, now: h.now() }), error => error.code === 'ACCOUNT_EXISTS');
    assert.deepEqual(h.store.read(), before);
    assert.equal((await h.signIn('reviewer')).principal.id, 'reviewer');
  } finally { await h.close(); }
});

test('HTTP invitation cancellation requires account-management MFA and leaves other invitations and sessions usable', async () => {
  const h = await harness();
  try {
    const manager = await h.signIn('manager'), ordinary = await h.signIn('ordinary');
    const first = await readOk(await h.post('/api/participants/invitations', { eligibility: {} }, manager.token));
    const participant = await readOk(await h.post('/api/participants/redeem', { token: first.token }));
    const cancel = await readOk(await h.post('/api/participants/invitations', { subjectId: first.subjectId, eligibility: {} }, manager.token));
    const spare = await readOk(await h.post('/api/participants/invitations', { subjectId: first.subjectId, eligibility: {} }, manager.token));
    const before = h.store.read();
    for (const token of ['', participant.token, ordinary.token]) {
      const response = await h.post('/api/participants/cancel-invitation', { invitationId: cancel.invitationId }, token);
      assert.ok([401, 403].includes(response.status), `${response.status}: ${await response.text()}`);
    }
    assert.deepEqual(h.store.read(), before);
    await readOk(await h.post('/api/participants/cancel-invitation', { invitationId: cancel.invitationId }, manager.token));
    const after = h.store.read();
    assert.equal((await h.post('/api/participants/redeem', { token: cancel.token })).status, 401);
    assert.deepEqual(h.store.read(), after, 'A cancelled invitation cannot be consumed or create another session');
    assert.equal((await h.get('/api/auth/me', participant.token)).status, 200);
    assert.equal((await h.get('/api/auth/me', manager.token)).status, 200);
    const extraDevice = await readOk(await h.post('/api/participants/redeem', { token: spare.token }));
    assert.equal(extraDevice.principal.id, first.subjectId);
    assert.equal((await h.get('/api/auth/me', participant.token)).status, 200);
  } finally { await h.close(); }
});
