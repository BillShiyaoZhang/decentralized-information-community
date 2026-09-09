import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, bootstrapAccount, localIdentityProvider, totpCode } from '../packages/runtime/auth.mjs';
import { RuntimeError } from '../packages/runtime/errors.mjs';
import { contentModule } from '../packages/runtime/content.mjs';
import { lifecycleModule } from '../packages/runtime/lifecycle.mjs';
import { participantsModule } from '../packages/runtime/participants.mjs';
import { reportsModule } from '../packages/runtime/reports.mjs';
import { createRuntimeApp } from '../packages/runtime/http.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', mfaKey = 'ab'.repeat(32), password = 'participant-http-test-password';
const keyring = { activeVersion: 'v1', keys: { v1: 'cd'.repeat(32) } };
const participantConfig = {
  role: 'participant', invitationTtlMs: 600_000, sessionTtlMs: 3_600_000, idleTtlMs: 600_000,
  selfService: { actions: ['consent', 'create', 'withdraw', 'logout', 'list'], types: ['lead'] },
};
const lifecycleConfig = { workflows: {
  lead: { initialState: 'submitted', states: ['submitted', 'resolved'], transitions: { submitted: ['resolved'], resolved: [] }, terminalStates: ['resolved'], decisionCodes: ['accepted'], publicResults: { accepted: { code: 'accepted', label: 'Accepted.' } }, retentionMs: 86_400_000, requireConsent: true, purpose: 'research', consentVersion: '1', eligibilityFields: ['adult', 'eligible'] },
  privacy_report: { initialState: 'submitted', states: ['submitted', 'resolved'], transitions: { submitted: ['resolved'], resolved: [] }, terminalStates: ['resolved'], decisionCodes: ['corrected'], publicResults: { corrected: { code: 'corrected', label: 'Corrected.' } }, retentionMs: 86_400_000, requireConsent: false, eligibilityFields: [] },
} };
const anonymousConfig = { type: 'privacy_report', fields: { message: { maxLength: 2000, required: true } }, rateLimit: { max: 5, windowMs: 60_000 }, receiptTtlMs: 3_600_000 };
const randomKey = () => randomBytes(32).toString('base64url');

async function harness({ participants = participantConfig, anonymousReports = anonymousConfig, provider, modules = [], privateKeyring = keyring } = {}) {
  let now = Date.parse('2099-01-01T00:00:00.000Z');
  const store = new RuntimeStore(':memory:', { communityId: 'participant-http', modules: [authModule, contentModule, lifecycleModule, participantsModule, reportsModule, ...modules] });
  for (const [id, roles] of [['manager', ['account_admin', 'pilot_operator', 'content_editor', 'content_reviewer']], ['editor', ['content_editor']]]) {
    bootstrapAccount(store, { id, displayName: id, password, totpSecret: secret, roles }, { mfaKey, now });
  }
  const server = createRuntimeApp({ store, auth: { mfaKey, participants, ...(provider ? { provider } : {}) }, lifecycle: { config: lifecycleConfig, keyring: privateKeyring }, anonymousReports, clock: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, token = '', key = randomKey()) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key === null ? {} : { 'Idempotency-Key': key }) }, body: JSON.stringify(value) });
  const get = (path, token = '') => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const signIn = async (accountId = 'manager') => readOk(await post('/api/auth/login', { accountId, password, code: totpCode(secret, now) }));
  const invite = async (token, input = {}) => readOk(await post('/api/participants/invitations', { eligibility: { adult: true, eligible: true }, ...input }, token, null));
  const redeem = async invitation => readOk(await post('/api/participants/redeem', { token: invitation.token }, '', null));
  const consent = async (token, extra = {}) => readOk(await post('/api/private/command', { action: 'consent', type: 'lead', version: '1', accepted: true, ...extra }, token));
  return { store, server, base, post, get, signIn, invite, redeem, consent, advance: ms => { now += ms; }, now: () => now, close: async () => { await new Promise(resolve => server.close(resolve)); store.close(); } };
}
async function readOk(response) { const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; }
async function denied(response) { assert.ok([401, 403].includes(response.status), `${response.status}: ${await response.text()}`); }
function slowPost(h, path, value, token) {
  const encoded = JSON.stringify(value);
  const pending = request(h.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': randomKey() } });
  const completed = new Promise((resolve, reject) => { pending.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); pending.on('error', reject); });
  pending.write(encoded.slice(0, 10));
  return { finish: () => { pending.end(encoded.slice(10)); return completed; } };
}

test('HTTP invitations are MFA-issued, single-use, expiry-bound and cannot convey client-supplied roles', async () => {
  const h = await harness();
  try {
    const manager = (await h.signIn()).token, editor = (await h.signIn('editor')).token;
    const input = { eligibility: { adult: true, eligible: true } };
    const before = h.store.read();
    await denied(await h.post('/api/participants/invitations', input));
    await denied(await h.post('/api/participants/invitations', input, editor));
    assert.deepEqual(h.store.read(), before);
    const invitation = await h.invite(manager), session = await h.redeem(invitation);
    assert.equal(session.principal.mfa, false);
    assert.equal(session.principal.assurance, 'invitation');
    assert.deepEqual(session.principal.roles, ['participant']);
    assert.equal(session.principal.subjectId ?? session.principal.id, invitation.subjectId);
    assert.match(invitation.token, /^pi_[A-Za-z0-9_-]{43}$/);
    assert.match(session.token, /^ps_[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(h.store.read()).includes(invitation.token));
    assert.ok(!JSON.stringify(h.store.read()).includes(session.token));
    const consumed = h.store.read();
    await denied(await h.post('/api/participants/redeem', { token: invitation.token }));
    assert.deepEqual(h.store.read(), consumed);
    const hostile = await h.post('/api/participants/redeem', { token: 'A'.repeat(43), roles: ['account_admin'], mfa: true, subjectId: 'manager' });
    assert.ok([400, 401, 403].includes(hostile.status));
    const forged = await h.invite(manager), beforeForgery = h.store.read();
    assert.equal((await h.post('/api/participants/redeem', { token: forged.token, roles: ['account_admin'], mfa: true })).status, 400);
    assert.deepEqual(h.store.read(), beforeForgery);
    assert.deepEqual((await h.redeem(forged)).principal.roles, ['participant']);
    await denied(await h.post('/api/participants/invitations', input, session.token));
    const expired = await h.invite(manager);
    h.advance(participantConfig.invitationTtlMs);
    await denied(await h.post('/api/participants/redeem', { token: expired.token }));
    await denied(await h.get('/api/auth/me', session.token));
  } finally { await h.close(); }
});

test('HTTP participant session absolute expiry cannot be extended by continuous activity', async () => {
  const h = await harness({ participants: { ...participantConfig, invitationTtlMs: 1000, sessionTtlMs: 3000, idleTtlMs: 1000 } });
  try {
    const manager = (await h.signIn()).token, session = await h.redeem(await h.invite(manager));
    for (const step of [999, 999, 999]) { h.advance(step); assert.equal((await h.get('/api/auth/me', session.token)).status, 200); }
    h.advance(3);
    await denied(await h.get('/api/auth/me', session.token));
  } finally { await h.close(); }
});

test('HTTP invitation self-service enforces attested eligibility, ownership and operation allowlists', async () => {
  const h = await harness();
  try {
    const manager = (await h.signIn()).token;
    const firstInvitation = await h.invite(manager), first = await h.redeem(firstInvitation);
    const secondInvitation = await h.invite(manager), second = await h.redeem(secondInvitation);
    const grant = await h.consent(first.token);
    await h.consent(second.token);
    const created = await readOk(await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'owned-lead', payload: { message: 'PRIVATE_SUBMISSION' }, consentEpoch: grant.consentEpoch }, first.token));
    assert.equal(created.id, 'owned-lead');
    assert.ok(!JSON.stringify(h.store.read()).includes('PRIVATE_SUBMISSION'));
    const before = h.store.read();
    const attempts = [
      { action: 'create', type: 'lead', id: 'forged-owner', subjectId: secondInvitation.subjectId, payload: {}, consentEpoch: grant.consentEpoch },
      { action: 'create', type: 'privacy_report', id: 'wrong-workflow', payload: {} },
      { action: 'transition', id: 'owned-lead', expectedVersion: 0, status: 'resolved', decisionCode: 'accepted', roles: ['pilot_operator'], mfa: true },
      { action: 'retain' }, { action: 'import', data: before.modules.lifecycle },
      { action: 'withdraw', subjectId: secondInvitation.subjectId },
    ];
    for (const input of attempts) await denied(await h.post('/api/private/command', input, first.token));
    for (const path of ['/api/private/list', '/api/private/owned-lead', '/api/editor/revisions/missing']) await denied(await h.get(path, first.token));
    for (const path of ['/api/content/import', '/api/content/publish', '/api/content/hide', '/api/content/source', '/api/participants/revoke']) await denied(await h.post(path, {}, first.token));
    assert.equal((await h.post('/api/auth/revoke', {}, first.token)).status, 400);
    assert.deepEqual(h.store.read(), before, 'Denied operations do not change authentication, audit or private state');
    assert.equal((await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'missing-key', payload: {}, consentEpoch: grant.consentEpoch }, first.token, null)).status, 400);
    const ineligible = await h.redeem(await h.invite(manager, { eligibility: { adult: false, eligible: false } }));
    const deniedConsent = await h.post('/api/private/command', { action: 'consent', type: 'lead', version: '1', accepted: true, eligibility: { adult: true, eligible: true } }, ineligible.token);
    if (deniedConsent.status === 200) {
      const rejected = await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'eligibility-forgery', payload: {}, consentEpoch: (await deniedConsent.json()).consentEpoch }, ineligible.token);
      await denied(rejected);
    } else assert.ok([400, 403].includes(deniedConsent.status));
    assert.equal(h.store.read().modules.lifecycle.records['eligibility-forgery'], undefined);
    assert.deepEqual(await readOk(await h.get('/api/private/self', second.token)), []);
  } finally { await h.close(); }
});

test('HTTP participant summaries omit private data and internal notes and require no decryption key', async () => {
  const h = await harness();
  try {
    const manager = (await h.signIn()).token, participant = await h.redeem(await h.invite(manager));
    const grant = await h.consent(participant.token);
    await readOk(await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'summary-only', payload: { message: 'PRIVATE_BODY' }, consentEpoch: grant.consentEpoch }, participant.token));
    await readOk(await h.post('/api/private/command', { action: 'transition', id: 'summary-only', expectedVersion: 0, status: 'resolved', decisionCode: 'accepted', assignee: 'manager', note: 'INTERNAL_NOTE' }, manager));
    const server = createRuntimeApp({ store: h.store, auth: { participants: participantConfig }, lifecycle: { config: lifecycleConfig }, clock: h.now });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const summary = await readOk(await fetch(`http://127.0.0.1:${server.address().port}/api/private/self`, { headers: { Authorization: `Bearer ${participant.token}` } }));
      assert.equal(summary.length, 1); assert.equal(summary[0].id, 'summary-only'); assert.equal(summary[0].status, 'resolved');
      const fields = ['id', 'type', 'status', 'version', 'createdAt', 'updatedAt', 'expiresAt', 'result'];
      assert.ok(Object.keys(summary[0]).every(key => fields.includes(key)), JSON.stringify(summary));
      assert.deepEqual(summary[0].result, { code: 'accepted', label: 'Accepted.' });
      assert.ok(!JSON.stringify(summary).includes('PRIVATE_BODY')); assert.ok(!JSON.stringify(summary).includes('INTERNAL_NOTE'));
      assert.equal(Object.hasOwn(summary[0], 'subjectId'), false); assert.equal(Object.hasOwn(summary[0], 'assignee'), false);
      await denied(await fetch(`http://127.0.0.1:${server.address().port}/api/private/summary-only`, { headers: { Authorization: `Bearer ${participant.token}` } }));
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await h.close(); }
});

test('HTTP device logout preserves the other participant session; withdrawal aborts an uploading write and revokes every device', async () => {
  const h = await harness();
  try {
    const manager = (await h.signIn()).token, invitation = await h.invite(manager);
    const first = await h.redeem(invitation), second = await h.redeem(await h.invite(manager, { subjectId: invitation.subjectId }));
    const grant = await h.consent(first.token);
    await readOk(await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'withdrawn-lead', payload: { message: 'ERASE_THIS' }, consentEpoch: grant.consentEpoch }, first.token));
    await readOk(await h.post('/api/auth/logout', {}, first.token));
    await denied(await h.get('/api/auth/me', first.token));
    assert.equal((await h.get('/api/auth/me', second.token)).status, 200);
    assert.equal(h.store.read().modules.lifecycle.subjects[invitation.subjectId].withdrawnAt, null);
    const third = await h.redeem(await h.invite(manager, { subjectId: invitation.subjectId }));
    const upload = slowPost(h, '/api/private/command', { action: 'create', type: 'lead', id: 'late-upload', payload: { message: 'MUST_NOT_COMMIT' }, consentEpoch: grant.consentEpoch }, third.token);
    await readOk(await h.post('/api/private/command', { action: 'withdraw' }, second.token));
    assert.equal(await upload.finish(), 401);
    for (const token of [first.token, second.token, third.token]) await denied(await h.get('/api/auth/me', token));
    const state = h.store.read();
    assert.equal(state.modules.lifecycle.records['late-upload'], undefined);
    assert.equal(state.modules.lifecycle.records['withdrawn-lead'].payload, null);
    assert.equal(state.modules.lifecycle.records['withdrawn-lead'].subjectId, null);
    assert.ok(state.modules.lifecycle.subjects[invitation.subjectId].withdrawnAt !== null);
    assert.equal(Object.values(state.idempotency).some(value => value.subjectId === invitation.subjectId), false);
    const replacement = await h.post('/api/participants/invitations', { subjectId: invitation.subjectId, eligibility: { adult: true, eligible: true } }, manager);
    assert.ok([400, 403, 409].includes(replacement.status));
  } finally { await h.close(); }
});

test('HTTP administrator participant revocation prevents the body-upload race without withdrawing consent', async () => {
  const h = await harness();
  try {
    const manager = (await h.signIn()).token, invitation = await h.invite(manager), participant = await h.redeem(invitation);
    const grant = await h.consent(participant.token);
    const upload = slowPost(h, '/api/private/command', { action: 'create', type: 'lead', id: 'revoked-upload', payload: { message: 'MUST_NOT_COMMIT' }, consentEpoch: grant.consentEpoch }, participant.token);
    await readOk(await h.post('/api/participants/revoke', { subjectId: invitation.subjectId }, manager));
    assert.equal(await upload.finish(), 401);
    assert.equal(h.store.read().modules.lifecycle.records['revoked-upload'], undefined);
    assert.equal(h.store.read().modules.lifecycle.subjects[invitation.subjectId].withdrawnAt, null);
  } finally { await h.close(); }
});

test('HTTP anonymous reports accept only configured fields and expose status only through an opaque expiring receipt', async () => {
  const h = await harness();
  try {
    const before = h.store.read();
    for (const payload of [{ message: 'x', roles: ['pilot_operator'] }, { message: 'x', subjectId: 'manager' }, { message: 'x', type: 'lead' }, { message: 'x', status: 'resolved' }, { message: 'x', payload: {} }, { message: 'x'.repeat(2001) }, {}]) {
      assert.equal((await h.post('/api/reports', payload)).status, 400);
      assert.deepEqual(h.store.read(), before, 'Invalid anonymous payloads leave no record, receipt, rate or audit side effects');
    }
    const receipt = await readOk(await h.post('/api/reports', { message: 'ANONYMOUS_PRIVATE_BODY' }, '', null));
    assert.deepEqual(Object.keys(receipt).sort(), ['expiresAt', 'receipt']);
    assert.match(receipt.receipt, /^[A-Za-z0-9_-]{43}$/);
    const state = h.store.read();
    assert.ok(!JSON.stringify(state).includes('ANONYMOUS_PRIVATE_BODY')); assert.ok(!JSON.stringify(state).includes(receipt.receipt));
    const status = await readOk(await h.get('/api/reports/status', receipt.receipt));
    assert.equal(status.status, 'submitted');
    assert.ok(Object.keys(status).every(key => ['status', 'result', 'createdAt', 'updatedAt', 'expiresAt'].includes(key)), JSON.stringify(status));
    const manager = (await h.signIn()).token, recordId = Object.keys(state.modules.lifecycle.records)[0];
    await readOk(await h.post('/api/private/command', { action: 'transition', id: recordId, expectedVersion: 0, status: 'resolved', decisionCode: 'corrected', note: 'ANONYMOUS_INTERNAL_NOTE' }, manager));
    const resolved = await readOk(await h.get('/api/reports/status', receipt.receipt));
    assert.equal(resolved.status, 'resolved'); assert.deepEqual(resolved.result, { code: 'corrected', label: 'Corrected.' });
    assert.ok(!JSON.stringify(resolved).includes('ANONYMOUS_PRIVATE_BODY')); assert.ok(!JSON.stringify(resolved).includes('ANONYMOUS_INTERNAL_NOTE'));
    assert.equal((await h.get('/api/reports/status')).status, 404);
    assert.equal((await h.get('/api/reports/status', randomKey())).status, 404);
    assert.equal((await h.get(`/api/reports/status?receipt=${receipt.receipt}`)).status, 404);
    for (const path of ['/api/private/list', '/api/private/self', '/api/private/anything']) await denied(await h.get(path, receipt.receipt));
    await denied(await h.post('/api/private/command', { action: 'create', type: 'lead', payload: {} }, receipt.receipt));
    h.advance(anonymousConfig.receiptTtlMs);
    const expired = await h.get('/api/reports/status', receipt.receipt);
    assert.ok([401, 404, 410].includes(expired.status));
  } finally { await h.close(); }
});

test('HTTP anonymous idempotency preserves one report and rate limits cannot be bypassed with fresh request keys', async () => {
  const h = await harness({ anonymousReports: { ...anonymousConfig, rateLimit: { max: 2, windowMs: 60_000 } } });
  try {
    const key = randomKey(), payload = { message: 'Report once' };
    const first = await readOk(await h.post('/api/reports', payload, '', key));
    assert.deepEqual(await readOk(await h.post('/api/reports', payload, '', key)), first);
    assert.equal(Object.keys(h.store.read().modules.lifecycle.records).length, 1);
    assert.equal((await h.post('/api/reports', { message: 'Changed request' }, '', key)).status, 409);
    await readOk(await h.post('/api/reports', { message: 'Second report' }));
    const before = h.store.read();
    assert.equal((await h.post('/api/reports', { message: 'Third report' })).status, 429);
    assert.deepEqual(h.store.read(), before);
    h.advance(60_000);
    await readOk(await h.post('/api/reports', { message: 'New window' }));
    assert.equal(Object.keys(h.store.read().modules.lifecycle.records).length, 3);
  } finally { await h.close(); }
});

function externalProvider({ missing, throwing, asynchronous } = {}) {
  const tokens = [randomKey(), randomKey(), randomKey()];
  const sessions = tokens.map((token, index) => ({ token, id: `external-device-${index}`, subjectId: index === 2 ? 'external-other' : 'external-subject', revoked: false }));
  const module = { name: 'external-identity', schemaVersion: 1, initialState: () => ({ sessions: structuredClone(sessions) }), validate: value => { assert.ok(Array.isArray(value.sessions)); } };
  const provider = {
    authenticate(state, token, options) {
      const session = state.modules['external-identity'].sessions.find(value => value.token === token);
      if (!session) return localIdentityProvider.authenticate(state, token, options);
      if (session.revoked) throw new RuntimeError('UNAUTHENTICATED', 'External session revoked', 401);
      return { id: session.subjectId, subjectId: session.subjectId, sessionId: session.id, roles: ['participant'], assurance: 'invitation', mfa: false, eligibility: { adult: true, eligible: true } };
    },
    revokeSession(state, principal, { sessionId }) {
      const session = state.modules['external-identity'].sessions.find(value => value.id === sessionId);
      if (!session) throw new RuntimeError('NOT_FOUND', 'Unknown external session', 404);
      if (session.subjectId !== principal.id) throw new RuntimeError('FORBIDDEN', 'Not your external session', 403);
      session.revoked = true;
      if (throwing === 'revokeSession') throw new Error('External revocation transaction failed');
      if (asynchronous === 'revokeSession') return Promise.resolve({ revoked: true });
      return { revoked: true };
    },
    revokeSubject(state, subjectId) {
      for (const session of state.modules['external-identity'].sessions) if (session.subjectId === subjectId) session.revoked = true;
      if (throwing === 'revokeSubject') throw new Error('External subject revocation transaction failed');
      if (asynchronous === 'revokeSubject') return Promise.resolve({ revoked: true });
      return { revoked: true };
    },
    prepareRestore(state) { state.modules['external-identity'].sessions = []; },
  };
  if (missing) delete provider[missing];
  return { provider, module, tokens, sessions };
}

test('HTTP custom invitation providers support logout and subject withdrawal without local auth sessions', async () => {
  const external = externalProvider(), h = await harness({ provider: external.provider, modules: [external.module] });
  try {
    const [first, second, other] = external.tokens, grant = await h.consent(first);
    await readOk(await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'external-record', payload: { message: 'EXTERNAL_PRIVATE' }, consentEpoch: grant.consentEpoch }, first));
    assert.equal(h.store.read().modules.auth.sessions.length, 0);
    await denied(await h.post('/api/auth/revoke', { sessionId: external.sessions[2].id }, first));
    await readOk(await h.post('/api/auth/logout', {}, first));
    await denied(await h.get('/api/auth/me', first));
    assert.equal((await h.get('/api/auth/me', second)).status, 200);
    const upload = slowPost(h, '/api/private/command', { action: 'create', type: 'lead', id: 'external-late', payload: {}, consentEpoch: grant.consentEpoch }, second);
    await readOk(await h.post('/api/private/command', { action: 'withdraw' }, second));
    assert.equal(await upload.finish(), 401);
    await denied(await h.get('/api/auth/me', second));
    assert.equal((await h.get('/api/auth/me', other)).status, 200);
    assert.equal(h.store.read().modules.lifecycle.records['external-late'], undefined);
    assert.equal(h.store.read().modules.lifecycle.records['external-record'].payload, null);
    await readOk(await h.post('/api/private/command', { action: 'logout' }, other));
    await denied(await h.get('/api/auth/me', other));
  } finally { await h.close(); }
});

test('HTTP missing or failing external provider revocation hooks fail closed and roll back private withdrawal', async () => {
  for (const failure of ['missing-session', 'throwing-session', 'async-session', 'missing-subject', 'throwing-subject', 'async-subject']) {
    const hook = failure.endsWith('session') ? 'revokeSession' : 'revokeSubject';
    const external = externalProvider(failure.startsWith('missing') ? { missing: hook } : failure.startsWith('async') ? { asynchronous: hook } : { throwing: hook });
    const h = await harness({ provider: external.provider, modules: [external.module] });
    try {
      const token = external.tokens[0], grant = await h.consent(token);
      await readOk(await h.post('/api/private/command', { action: 'create', type: 'lead', id: 'rollback-record', payload: { message: 'PRESERVE_UNTIL_VALID_WITHDRAWAL' }, consentEpoch: grant.consentEpoch }, token));
      const before = h.store.read();
      const response = hook === 'revokeSession' ? await h.post('/api/auth/logout', {}, token) : await h.post('/api/private/command', { action: 'withdraw' }, token);
      assert.equal(response.status, failure.startsWith('missing') ? 503 : 500, `${failure}: ${await response.text()}`);
      assert.deepEqual(h.store.read(), before, failure);
      assert.equal((await h.get('/api/auth/me', token)).status, 200);
    } finally { await h.close(); }
  }
});
