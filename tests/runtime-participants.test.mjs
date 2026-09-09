import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, authenticateIdentity, bootstrapAccount, executeAuthorized, invalidateIdentityCredentials, login, readAuthorized, requirePermission, revokeIdentitySubject, revokeSession, totpCode } from '../packages/runtime/auth.mjs';
import { assertParticipantOperation, cancelParticipantInvitation, issueParticipantInvitation, participantsModule, redeemParticipantInvitation, validateParticipantConfig } from '../packages/runtime/participants.mjs';
import { lifecycleModule } from '../packages/runtime/lifecycle.mjs';

const now = 1_800_000_000_000;
const config = { role: 'participant', invitationTtlMs: 60_000, sessionTtlMs: 120_000, idleTtlMs: 30_000, selfService: { actions: ['consent', 'create', 'withdraw', 'logout', 'list'], types: ['lead'] } };
const setup = (modules = []) => new RuntimeStore(':memory:', { communityId: 'participant-tests', modules: [authModule, participantsModule, lifecycleModule, ...modules] });
const invite = (store, input = {}, options = {}) => store.transact(state => issueParticipantInvitation(state, { eligibility: { adult: true, eligible: true }, ...input }, { config, now, ...options }));
const redeem = (store, invitation, options = {}) => redeemParticipantInvitation(store, { token: invitation.token }, { config, now, ...options });
const authenticate = (store, token, options = {}) => store.transact(state => authenticateIdentity(state, token, { participantsConfig: config, now, ...options }));
const operation = (input, options = {}) => ({ permission: 'lifecycle:self', assurance: 'invitation', participantsConfig: config, action: 'lifecycle.self', input, now, authorize: principal => assertParticipantOperation(principal, input, config), ...options });

test('invitation provisioning is trusted, redemption is token-only, and persisted storage contains no bearer credentials', () => {
  const store = setup();
  try {
    const invitation = invite(store), session = redeem(store, invitation);
    assert.match(invitation.subjectId, /^participant:/);
    assert.equal(session.principal.id, invitation.subjectId);
    assert.equal(session.principal.mfa, false); assert.equal(session.principal.assurance, 'invitation');
    assert.deepEqual(session.principal.roles, ['participant']);
    assert.deepEqual(session.principal.eligibility, { adult: true, eligible: true });
    assert.ok(!JSON.stringify(store.read()).includes(invitation.token));
    assert.ok(!JSON.stringify(store.read()).includes(session.token));
    assert.deepEqual(authenticate(store, session.token), session.principal);
    for (const extra of [{ roles: ['operations_admin'] }, { subjectId: 'participant:other' }, { eligibility: { adult: true } }, { mfa: true }]) {
      const before = store.read();
      assert.throws(() => redeemParticipantInvitation(store, { token: invitation.token, ...extra }, { config, now }), { code: 'INVALID_PARTICIPANT_INPUT' });
      assert.deepEqual(store.read(), before);
    }
    assert.throws(() => invite(store, { subjectId: 'named-administrator' }), { code: 'INVALID_PARTICIPANT_SUBJECT' });
  } finally { store.close(); }
});

test('one-time invitation and hard/idle session expiration reject exactly at the boundary without state changes', () => {
  const store = setup();
  try {
    const invitation = invite(store), session = redeem(store, invitation);
    const beforeReplay = store.read();
    assert.throws(() => redeem(store, invitation), { code: 'INVALID_INVITATION' }); assert.deepEqual(store.read(), beforeReplay);
    const expiring = invite(store);
    assert.throws(() => redeem(store, expiring, { now: expiring.expiresAt }), { code: 'INVALID_INVITATION' });
    const beforeExpiry = store.read();
    assert.throws(() => authenticate(store, session.token, { now: now + config.idleTtlMs }), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(store.read(), beforeExpiry);
    assert.equal(authenticate(store, session.token, { now: now + config.idleTtlMs - 1 }).id, session.principal.id);
    assert.throws(() => authenticate(store, session.token, { now: session.expiresAt }), { code: 'UNAUTHENTICATED' });
  } finally { store.close(); }
});

test('invitation assurance never grants manager permissions even when the deployment assigns an administrator role', () => {
  const store = setup();
  try {
    const badPolicy = { ...config, role: 'misconfigured_admin' }, invitation = invite(store, {}, { config: badPolicy }), session = redeem(store, invitation, { config: badPolicy });
    const policy = { misconfigured_admin: ['lifecycle:self', 'lifecycle:manage', 'content:publish', 'accounts:manage', 'operations:manage'] };
    const principal = session.principal;
    requirePermission(principal, 'lifecycle:self', policy, { assurance: 'invitation' });
    for (const permission of ['lifecycle:manage', 'content:publish', 'accounts:manage', 'operations:manage']) {
      assert.throws(() => requirePermission(principal, permission, policy, { assurance: 'invitation' }), { code: 'UNAUTHENTICATED' });
      assert.throws(() => requirePermission({ ...principal, mfa: true }, permission, policy, { assurance: 'invitation' }), { code: 'UNAUTHENTICATED' });
    }
    assert.throws(() => requirePermission(principal, 'lifecycle:self', policy), { code: 'UNAUTHENTICATED' });
    for (const input of [{ action: 'transition', type: 'lead' }, { action: 'create', type: 'report' }, { action: 'detail', type: 'lead' }]) assert.throws(() => assertParticipantOperation(principal, input, badPolicy), { code: 'FORBIDDEN' });
    assert.throws(() => authenticateIdentity(store.read(), session.token, { now }), { code: 'PARTICIPANTS_DISABLED' });
  } finally { store.close(); }
});

test('self-service authorization is reevaluated before idempotency replay and rejects without extending the session', () => {
  const store = setup();
  try {
    const session = redeem(store, invite(store));
    const options = operation({ action: 'create', type: 'lead' }, { key: 'participant-create-0001' });
    let writes = 0;
    executeAuthorized(store, session.token, options, () => { writes++; return { id: 'lead-1' }; });
    const before = store.read(), denied = { ...options, now: now + 1000, authorize: principal => assertParticipantOperation(principal, options.input, { ...config, selfService: { actions: ['list'], types: ['lead'] } }) };
    assert.throws(() => executeAuthorized(store, session.token, denied, () => { writes++; }), { code: 'FORBIDDEN' });
    assert.equal(writes, 1); assert.deepEqual(store.read(), before);
    assert.deepEqual(readAuthorized(store, session.token, operation({ action: 'list' }), (state, principal) => ({ subjectId: principal.id })), { subjectId: session.principal.id });
  } finally { store.close(); }
});

test('reviewed invitations bind multiple devices to one subject; logout and admin session revoke preserve eligibility', () => {
  const store = setup();
  try {
    const first = redeem(store, invite(store)), second = redeem(store, invite(store, { subjectId: first.principal.id }));
    revokeSession(store, first.token, { now, participantsConfig: config });
    assert.throws(() => authenticate(store, first.token), { code: 'UNAUTHENTICATED' });
    assert.equal(authenticate(store, second.token).id, first.principal.id);
    assert.deepEqual(store.read().modules.participants.subjects[0].eligibility, { adult: true, eligible: true });
    assert.equal(store.read().modules.participants.subjects[0].revokedAt, null);
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', password = 'test-administrator-password', mfaKey = 'aa'.repeat(32);
    bootstrapAccount(store, { id: 'admin', displayName: 'Named Administrator', roles: ['account_admin'], password, totpSecret: secret }, { now, mfaKey });
    assert.throws(() => bootstrapAccount(store, { id: first.principal.id, displayName: 'Collision', roles: ['account_admin'], password, totpSecret: secret }, { now, mfaKey }), { code: 'SUBJECT_CONFLICT' });
    const admin = login(store, { accountId: 'admin', password, code: totpCode(secret, now) }, { now, mfaKey });
    revokeSession(store, admin.token, { now, sessionId: second.principal.sessionId });
    assert.throws(() => authenticate(store, second.token), { code: 'UNAUTHENTICATED' });
    const third = redeem(store, invite(store, { subjectId: first.principal.id }));
    assert.equal(authenticate(store, third.token).id, first.principal.id);
    store.transact(state => revokeIdentitySubject(state, 'admin', { now }));
    assert.equal(store.read().modules.auth.accounts[0].active, false);
    assert.throws(() => store.transact(state => { state.modules.auth.accounts[0].active = true; }), { code: 'INVALID_AUTH' });
  } finally { store.close(); }
});

test('cancelling one pending invitation preserves the subject, other invitations and existing devices', () => {
  const store = setup();
  try {
    const accepted = invite(store), session = redeem(store, accepted);
    const mistaken = invite(store, { subjectId: session.principal.id }), legitimate = invite(store, { subjectId: session.principal.id });
    const before = store.read(), oldHash = before.modules.participants.invitations.find(item => item.id === mistaken.invitationId).tokenHash;
    const result = store.transact(state => cancelParticipantInvitation(state, { invitationId: mistaken.invitationId }, { now: now + 1 }));
    assert.deepEqual(result, { invitationId: mistaken.invitationId, subjectId: session.principal.id, cancelled: true, revokedAt: now + 1 });
    const after = store.read(), cancelled = after.modules.participants.invitations.find(item => item.id === mistaken.invitationId);
    assert.notEqual(cancelled.tokenHash, oldHash);
    assert.deepEqual(after.modules.participants.subjects, before.modules.participants.subjects);
    assert.deepEqual(after.modules.participants.sessions, before.modules.participants.sessions);
    assert.deepEqual(after.modules.participants.invitations.filter(item => item.id !== mistaken.invitationId), before.modules.participants.invitations.filter(item => item.id !== mistaken.invitationId));
    assert.equal(after.audit.at(-1).action, 'participant.invitation.cancel');
    assert.equal(after.audit.at(-1).targetId, mistaken.invitationId);
    for (const token of [mistaken.token, legitimate.token, session.token]) assert.ok(!JSON.stringify({ result, audit: after.audit }).includes(token));
    assert.throws(() => redeem(store, mistaken), { code: 'INVALID_INVITATION' });
    assert.deepEqual(store.read(), after);
    assert.deepEqual(store.transact(state => cancelParticipantInvitation(state, { invitationId: mistaken.invitationId }, { now: mistaken.expiresAt })), result);
    assert.deepEqual(store.read(), after);
    assert.equal(authenticate(store, session.token).id, session.principal.id);
    assert.equal(redeem(store, legitimate).principal.id, session.principal.id);
  } finally { store.close(); }
});

test('invitation cancellation rejects malformed, missing, redeemed and unavailable invitations atomically', () => {
  const store = setup();
  try {
    const pending = invite(store), accepted = invite(store);
    redeem(store, accepted);
    for (const [input, at, error] of [
      [{}, now, 'INVALID_PARTICIPANT_INPUT'],
      [{ invitationId: 'invalid invitation' }, now, 'INVALID_PARTICIPANT_INPUT'],
      [{ invitationId: pending.invitationId, subjectId: pending.subjectId }, now, 'INVALID_PARTICIPANT_INPUT'],
      [{ invitationId: 'missing-invitation' }, now, 'NOT_FOUND'],
      [{ invitationId: accepted.invitationId }, now, 'INVITATION_REDEEMED'],
      [{ invitationId: pending.invitationId }, now - 1, 'INVITATION_UNAVAILABLE'],
      [{ invitationId: pending.invitationId }, pending.expiresAt, 'INVITATION_UNAVAILABLE'],
      [{ invitationId: pending.invitationId }, pending.expiresAt + 1, 'INVITATION_UNAVAILABLE'],
      [{ invitationId: pending.invitationId }, -1, 'INVALID_PARTICIPANT_TIME'],
    ]) {
      const before = store.read();
      assert.throws(() => store.transact(state => cancelParticipantInvitation(state, input, { now: at })), { code: error });
      assert.deepEqual(store.read(), before);
    }
    assert.equal(redeem(store, pending).principal.id, pending.subjectId);
  } finally { store.close(); }
});

test('invitation cancellation and its audit roll back together when persistence rejects the change', () => {
  let rejectCancellation = false;
  const guard = { name: 'guard', schemaVersion: 1, initialState: () => ({}), validate: () => {}, validateState: state => {
    if (rejectCancellation && state.modules.participants.invitations.some(item => item.revokedAt !== null)) throw new Error('cancellation persistence denied');
  } };
  const store = setup([guard]);
  try {
    const invitation = invite(store), before = store.read();
    rejectCancellation = true;
    assert.throws(() => store.transact(state => cancelParticipantInvitation(state, { invitationId: invitation.invitationId }, { now })), /cancellation persistence denied/);
    assert.deepEqual(store.read(), before);
    rejectCancellation = false;
    assert.equal(redeem(store, invitation).principal.id, invitation.subjectId);
  } finally { store.close(); }
});

test('subject revocation invalidates every device and invitation and cannot be reversed by later provisioning', () => {
  const store = setup();
  try {
    const first = redeem(store, invite(store)), second = redeem(store, invite(store, { subjectId: first.principal.id })), pending = invite(store, { subjectId: first.principal.id });
    store.transact(state => revokeIdentitySubject(state, first.principal.id, { now }));
    for (const session of [first, second]) assert.throws(() => authenticate(store, session.token), { code: 'UNAUTHENTICATED' });
    assert.throws(() => redeem(store, pending), { code: 'INVALID_INVITATION' });
    assert.throws(() => invite(store, { subjectId: first.principal.id }), { code: 'SUBJECT_REVOKED' });
    assert.throws(() => store.transact(state => { state.modules.participants.subjects[0].revokedAt = null; }), { code: 'PARTICIPANT_REVOCATION_IMMUTABLE' });
    assert.deepEqual(store.read().modules.participants.subjects[0].eligibility, {});
  } finally { store.close(); }
});

test('old backup restore requires current revocations, invalidates credentials and retains unknown withdrawal tombstones', () => {
  const source = setup(), restored = setup();
  try {
    const pending = invite(source), session = redeem(source, invite(source, { subjectId: pending.subjectId })), backup = source.backup(), empty = restored.read();
    assert.throws(() => restored.restore(backup, { now }), { code: 'PARTICIPANT_RECONCILIATION_REQUIRED' });
    assert.deepEqual(restored.read(), empty);
    restored.restore(backup, { now, revokedSubjectIds: [pending.subjectId, 'participant:revoked-after-backup'], withdrawnSubjectIds: ['participant:withdrawn-after-backup'] });
    assert.equal(restored.read().modules.participants.sessions.length, 0); assert.equal(restored.read().modules.participants.invitations.length, 0);
    assert.throws(() => authenticate(restored, session.token), { code: 'UNAUTHENTICATED' });
    assert.throws(() => redeem(restored, pending), { code: 'INVALID_INVITATION' });
    for (const id of [pending.subjectId, 'participant:revoked-after-backup', 'participant:withdrawn-after-backup']) assert.throws(() => invite(restored, { subjectId: id }), { code: 'SUBJECT_REVOKED' });
  } finally { source.close(); restored.close(); }
});

test('custom provider logout and invalidation use its synchronous hooks and missing or asynchronous mutations roll back', () => {
  const store = setup();
  try {
    const session = redeem(store, invite(store)), principal = { id: 'external-subject', sessionId: 'external-session', roles: ['participant'], mfa: true };
    const provider = { authenticate: () => principal }, before = store.read();
    assert.throws(() => revokeSession(store, 'external-token', { provider, now }), { code: 'IDENTITY_PROVIDER_HOOK_REQUIRED' });
    assert.deepEqual(store.read(), before);
    assert.throws(() => revokeSession(store, 'external-token', { provider: { ...provider, revokeSession: state => { state.modules.participants.sessions = []; return Promise.resolve({ revoked: true }); } }, now }), { code: 'ASYNC_PROVIDER' });
    assert.deepEqual(store.read(), before);
    const result = revokeSession(store, 'external-token', { provider: { ...provider, revokeSession: (state, actor, options) => { assert.equal(actor.id, principal.id); assert.equal(options.sessionId, principal.sessionId); return { custom: true }; } }, now });
    assert.deepEqual(result, { custom: true });
    assert.equal(authenticate(store, session.token).id, session.principal.id);
    const afterLogout = store.read();
    assert.throws(() => store.transact(state => invalidateIdentityCredentials(state, { provider, now })), { code: 'IDENTITY_PROVIDER_HOOK_REQUIRED' });
    assert.deepEqual(store.read(), afterLogout);
    store.transact(state => invalidateIdentityCredentials(state, { now }));
    assert.throws(() => authenticate(store, session.token), { code: 'UNAUTHENTICATED' });
  } finally { store.close(); }
});

test('custom providers cannot reactivate withdrawn identities or hide asynchronous authentication', () => {
  const store = setup();
  try {
    store.transact(state => { state.modules.lifecycle.subjects.external = { id: 'external', epoch: 1, consents: {}, eligibility: {}, withdrawnAt: now }; });
    const before = store.read();
    const principal = { id: 'external', sessionId: 'session', roles: ['participant'], mfa: true };
    assert.throws(() => executeAuthorized(store, 'custom-token', operation({ action: 'list' }, { provider: { authenticate: () => principal } }), () => ({ leaked: true })), { code: 'UNAUTHENTICATED' });
    assert.throws(() => executeAuthorized(store, 'custom-token', operation({ action: 'list' }, { provider: { authenticate: () => Promise.resolve(principal) } }), () => ({})), { code: 'ASYNC_PROVIDER' });
    assert.throws(() => executeAuthorized(store, 'custom-token', operation({ action: 'list' }, { provider: { authenticate: () => ({ id: 'participant:external', roles: ['participant'], assurance: 'invitation', mfa: false }) } }), () => ({})), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(store.read(), before);
  } finally { store.close(); }
});

test('custom provider restore hooks are mandatory and synchronous, with all failures preserving the empty target', () => {
  const externalIdentity = { name: 'external-identity', schemaVersion: 1, initialState: () => ({ sessions: [], revokedSubjectIds: [] }), validate: data => { assert.ok(Array.isArray(data.sessions)); assert.ok(Array.isArray(data.revokedSubjectIds)); } };
  const source = setup([externalIdentity]), target = setup([externalIdentity]);
  try {
    const invitation = invite(source);
    source.transact(state => { state.modules['external-identity'].sessions.push({ id: 'external-session', subjectId: invitation.subjectId }); });
    const backup = source.backup(), before = target.read(), provider = { authenticate: () => null };
    const options = { now, revokedSubjectIds: [invitation.subjectId], withdrawnSubjectIds: [] };
    assert.throws(() => target.restore(backup, { ...options, provider }), { code: 'IDENTITY_PROVIDER_HOOK_REQUIRED' });
    assert.deepEqual(target.read(), before);
    assert.throws(() => target.restore(backup, { ...options, provider: { ...provider, prepareRestore: state => { state.modules.participants.invitations = []; return Promise.resolve(); } } }), { code: 'ASYNC_PROVIDER' });
    assert.deepEqual(target.read(), before);
    assert.throws(() => target.restore(backup, { ...options, provider: { ...provider, prepareRestore: state => { state.modules['external-identity'].sessions = []; throw new Error('provider restore failed'); } } }), /provider restore failed/);
    assert.deepEqual(target.read(), before);
    let reconciled = false;
    target.restore(backup, { ...options, provider: { ...provider, prepareRestore: (state, supplied) => {
      assert.deepEqual(supplied.revokedSubjectIds, [invitation.subjectId]);
      state.modules['external-identity'].sessions = [];
      state.modules['external-identity'].revokedSubjectIds = [...supplied.revokedSubjectIds];
      reconciled = true; return { reconciled: true };
    } } });
    assert.equal(reconciled, true);
    assert.deepEqual(target.read().modules.participants.invitations, []);
    assert.deepEqual(target.read().modules['external-identity'], { sessions: [], revokedSubjectIds: [invitation.subjectId] });
    assert.throws(() => invite(target, { subjectId: invitation.subjectId }), { code: 'SUBJECT_REVOKED' });
  } finally { source.close(); target.close(); }
});

test('redemption persistence failure rolls back consumption and no prototype or unbounded configuration can enter state', () => {
  let rejectCommit = false;
  const guard = { name: 'guard', schemaVersion: 1, initialState: () => ({}), validate: () => {}, validateState: state => { if (rejectCommit && state.modules.participants.sessions.length) throw new Error('persistence denied'); } };
  const store = setup([guard]);
  try {
    const invitation = invite(store), before = store.read(); rejectCommit = true;
    assert.throws(() => redeem(store, invitation), /persistence denied/); assert.deepEqual(store.read(), before);
    rejectCommit = false; assert.equal(redeem(store, invitation).principal.id, invitation.subjectId);
    for (const invalid of [{ ...config, invitationTtlMs: Number.MAX_SAFE_INTEGER }, { ...config, idleTtlMs: config.sessionTtlMs + 1 }, { ...config, selfService: { actions: ['detail'], types: ['lead'] } }, { ...config, mfa: true }]) assert.throws(() => validateParticipantConfig(invalid), { code: 'INVALID_PARTICIPANT_CONFIG' });
    assert.throws(() => invite(store, JSON.parse('{"eligibility":{"adult":true,"__proto__":{"admin":true}}}')), { code: 'INVALID_JSON' });
    assert.throws(() => invite(store, { eligibility: Object.create({ adult: true }) }), { code: 'INVALID_JSON' });
    assert.throws(() => validateParticipantConfig(undefined), { code: 'PARTICIPANTS_DISABLED' });
  } finally { store.close(); }
});
