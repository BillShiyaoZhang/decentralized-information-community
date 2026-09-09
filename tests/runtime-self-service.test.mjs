import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, localIdentityProvider } from '../packages/runtime/auth.mjs';
import { participantsModule, issueParticipantInvitation, redeemParticipantInvitation, authenticateParticipant } from '../packages/runtime/participants.mjs';
import { lifecycleModule, lifecycleCommand, lifecycleSelfList } from '../packages/runtime/lifecycle.mjs';
import { reportsModule, submitAnonymousReport, readAnonymousReport, validateAnonymousReportConfig } from '../packages/runtime/reports.mjs';

const now = 1800000000000;
const keyring = { activeVersion: 'v1', keys: { v1: Buffer.alloc(32, 19) } };
const policy = { invited: ['lifecycle:self'], manager: ['lifecycle:manage'] };
const participants = { role: 'invited', selfService: { actions: ['consent', 'create', 'list', 'logout', 'withdraw'], types: ['intake', 'privacy_report'] } };
const baseWorkflow = { initialState: 'pending', states: ['pending', 'resolved'], transitions: { pending: ['resolved'], resolved: [] }, terminalStates: ['resolved'], decisionCodes: ['handled'], publicResults: { handled: { code: 'handled', label: 'Handled.' } }, retentionMs: 3600000, requireConsent: false, eligibilityFields: [] };
const config = { workflows: {
  privacy_report: baseWorkflow,
  other: { ...baseWorkflow },
  intake: { ...baseWorkflow, requireConsent: true, purpose: 'intake', consentVersion: 'v1', eligibilityFields: ['eligible'] },
} };
const anonymous = { type: 'privacy_report', fields: { message: { required: true, maxLength: 2000 }, url: { maxLength: 500 } }, rateLimit: { max: 2, windowMs: 60000 }, receiptTtlMs: 600000 };
const manager = { id: 'manager', mfa: true, roles: ['manager'] };
const error = code => value => value.code === code;

function setup(t) {
  const store = new RuntimeStore(':memory:', { communityId: 'self-service-tests', modules: [authModule, lifecycleModule, participantsModule, reportsModule] });
  t.after(() => store.close());
  return store;
}
function invite(store, eligibility = { eligible: true }, subjectId) {
  const invitation = store.transact(state => issueParticipantInvitation(state, { eligibility, ...(subjectId ? { subjectId } : {}) }, { config: participants, now }));
  return { invitation, ...redeemParticipantInvitation(store, { token: invitation.token }, { config: participants, now }) };
}
function command(store, principal, input, options = {}) {
  return store.transact(state => lifecycleCommand(state, principal, input, { config, keyring, policy, participants, now, ...options }));
}
function create(store, principal, overrides = {}) {
  const grant = command(store, principal, { action: 'consent', type: 'intake', accepted: true, version: 'v1' });
  return command(store, principal, { action: 'create', type: 'intake', consentEpoch: grant.consentEpoch, payload: { message: 'Private submission body' }, ...overrides });
}
function list(store, principal, options = {}) {
  return lifecycleSelfList(store.read(), principal, { config, participants, policy, now, ...options });
}
function report(store, payload = { message: 'Confidential privacy concern' }, options = {}) {
  return submitAnonymousReport(store, payload, { config: anonymous, lifecycle: { config, keyring }, now, ...options });
}
const status = (store, receipt, options = {}) => readAnonymousReport(store.read(), receipt, { config: anonymous, lifecycleConfig: config, now, ...options });

test('invitation self service uses reviewed eligibility and explicit action/type allowlists', t => {
  const store = setup(t), denied = invite(store, { eligible: false });
  const before = store.read();
  assert.throws(() => command(store, denied.principal, { action: 'consent', type: 'intake', accepted: true, version: 'v1', eligibility: { eligible: true }, roles: ['manager'], mfa: true }), error('INELIGIBLE'));
  assert.deepEqual(store.read(), before);
  const accepted = invite(store);
  const record = create(store, accepted.principal);
  assert.equal(record.status, 'pending');
  assert.deepEqual(store.read().modules.lifecycle.subjects[accepted.principal.id].eligibility, { eligible: true });
  assert.throws(() => command(store, accepted.principal, { action: 'create', type: 'other', payload: {} }), error('FORBIDDEN'));
  assert.throws(() => command(store, accepted.principal, { action: 'transition', id: record.id, status: 'resolved', expectedVersion: 0, decisionCode: 'handled' }), error('FORBIDDEN'));
  assert.throws(() => list(store, accepted.principal, { participants: { ...participants, selfService: { ...participants.selfService, actions: ['create'] } } }), error('FORBIDDEN'));
  assert.throws(() => list(store, { ...accepted.principal, assurance: undefined }), error('UNAUTHENTICATED'));
  store.transact(state => issueParticipantInvitation(state, { subjectId: accepted.principal.id, eligibility: { eligible: false } }, { config: participants, now }));
  const changedPrincipal = store.transact(state => authenticateParticipant(state, accepted.token, { config: participants, now }));
  assert.deepEqual(list(store, changedPrincipal), []);
  assert.throws(() => command(store, changedPrincipal, { action: 'create', type: 'intake', consentEpoch: 1, payload: {} }), error('INELIGIBLE'), 'An earlier consent cannot override a changed server eligibility review');
});

test('owner summaries include pending unlinked records, exclude other people and internal metadata, and need no decryption key', t => {
  const store = setup(t), first = invite(store), second = invite(store);
  const mine = create(store, first.principal), theirs = create(store, second.principal);
  const pending = list(store, first.principal);
  assert.deepEqual(pending, [{ id: mine.id, type: 'intake', status: 'pending', version: 0, createdAt: now, updatedAt: now, expiresAt: mine.expiresAt, result: null }]);
  assert.equal(JSON.stringify(pending).includes(theirs.id), false);
  command(store, manager, { action: 'transition', id: mine.id, expectedVersion: 0, status: 'resolved', decisionCode: 'handled', assignee: 'private-assignee', note: 'Secret reviewer note' });
  const resolved = list(store, first.principal);
  assert.deepEqual(resolved[0].result, { code: 'handled', label: 'Handled.' });
  assert.doesNotMatch(JSON.stringify(resolved), /Private submission body|Secret reviewer note|private-assignee|subjectId|entityId|revisionId|decisionCode|payload/);
  assert.deepEqual(list(store, first.principal, { now: mine.expiresAt }), []);
  const changedConfig = structuredClone(config); changedConfig.workflows.intake.consentVersion = 'v2';
  assert.deepEqual(list(store, first.principal, { config: changedConfig }), []);
  const changedState = store.read(); changedState.modules.lifecycle.subjects[first.principal.id].epoch += 1;
  assert.deepEqual(lifecycleSelfList(changedState, first.principal, { config, participants, policy, now }), []);
  const withdrawnState = store.read(); withdrawnState.modules.lifecycle.subjects[first.principal.id].withdrawnAt = now;
  assert.deepEqual(lifecycleSelfList(withdrawnState, first.principal, { config, participants, policy, now }), []);
  assert.deepEqual(list(store, first.principal, { participants: { ...participants, selfService: { ...participants.selfService, types: ['privacy_report'] } } }), []);
});

test('withdrawal revokes invitations and every participant device atomically, while provider hook failure rolls back', t => {
  const store = setup(t), first = invite(store), second = invite(store, { eligible: true }, first.principal.id);
  const pending = store.transact(state => issueParticipantInvitation(state, { subjectId: first.principal.id, eligibility: { eligible: true } }, { config: participants, now }));
  create(store, first.principal);
  const before = store.read();
  assert.throws(() => command(store, first.principal, { action: 'withdraw' }, { provider: { revokeSubject(state) { state.audit.push({ action: 'must-roll-back' }); throw new Error('provider revoke failed'); } } }), /provider revoke failed/);
  assert.deepEqual(store.read(), before);
  assert.throws(() => command(store, first.principal, { action: 'withdraw' }, { provider: { authenticate() {} } }), error('IDENTITY_PROVIDER_HOOK_REQUIRED'));
  assert.deepEqual(store.read(), before);
  command(store, first.principal, { action: 'withdraw' });
  for (const token of [first.token, second.token]) assert.throws(() => store.transact(state => authenticateParticipant(state, token, { config: participants, now })), error('UNAUTHENTICATED'));
  assert.throws(() => redeemParticipantInvitation(store, { token: pending.token }, { config: participants, now }), error('INVALID_INVITATION'));
  assert.deepEqual(list(store, first.principal), []);
  assert.throws(() => command(store, first.principal, { action: 'consent', type: 'intake', accepted: true, version: 'v1' }), error('CONSENT_WITHDRAWN'));
  assert.throws(() => store.transact(state => issueParticipantInvitation(state, { subjectId: first.principal.id, eligibility: { eligible: true } }, { config: participants, now })), error('SUBJECT_REVOKED'));
});

test('anonymous reporting is a bounded DTO with no enrollment, generic private permissions or plaintext receipt storage', t => {
  const store = setup(t);
  for (const disabled of [undefined, null, false]) {
    assert.throws(() => report(store, undefined, { config: disabled }), value => value.code === 'MODULE_DISABLED' && value.status === 404);
    assert.throws(() => status(store, '', { config: disabled }), value => value.code === 'MODULE_DISABLED' && value.status === 404);
  }
  assert.throws(() => validateAnonymousReportConfig({ ...anonymous, type: 'intake' }, config), error('INVALID_ANONYMOUS_CONFIG'));
  const before = store.read();
  for (const payload of [{ message: 'a', roles: 'manager' }, { message: 'a', action: 'transition' }, { message: 'a', payload: {} }, { message: 'x'.repeat(2001) }, { message: '' }, {}]) assert.throws(() => report(store, payload), error('INVALID_ANONYMOUS_DTO'));
  assert.throws(() => report(store, undefined, { key: 'predictable-retry' }), error('INVALID_IDEMPOTENCY_KEY'));
  assert.deepEqual(store.read(), before);
  const key = randomBytes(32).toString('base64url'), receipt = report(store, undefined, { key });
  assert.match(receipt.receipt, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(receipt).sort(), ['expiresAt', 'receipt']);
  assert.deepEqual(status(store, receipt.receipt), { status: 'pending', createdAt: now, updatedAt: now, expiresAt: now + anonymous.receiptTtlMs, result: null });
  const state = store.read(), subject = Object.values(state.modules.lifecycle.subjects)[0];
  assert.deepEqual(subject.consents, {}); assert.deepEqual(subject.eligibility, {});
  assert.deepEqual(state.modules.auth.accounts, []); assert.deepEqual(state.modules.participants.subjects, []);
  assert.equal(state.modules.reports.rate.count, 1);
  assert.doesNotMatch(JSON.stringify(state), /Confidential privacy concern/);
  assert.equal(JSON.stringify(state).includes(receipt.receipt), false); assert.equal(JSON.stringify(state).includes(key), false);
  assert.throws(() => status(store, randomBytes(32).toString('base64url')), error('NOT_FOUND'));
});

test('anonymous retries are secret-bound, encrypted and atomic; global rate limits persist independently of client headers', t => {
  const store = setup(t), key = randomBytes(32).toString('base64url');
  const first = report(store, undefined, { key });
  const beforeReplay = store.read();
  assert.deepEqual(report(store, undefined, { key }), first);
  assert.deepEqual(store.read(), beforeReplay);
  assert.throws(() => report(store, { message: 'different data' }, { key }), error('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(store.read(), beforeReplay);
  const keyless = report(store, { message: 'Second report' });
  assert.notEqual(keyless.receipt, first.receipt);
  const limited = store.read();
  assert.throws(() => report(store, { message: 'Third report' }), error('RATE_LIMITED'));
  assert.deepEqual(store.read(), limited);
  assert.deepEqual(report(store, undefined, { key }), first, 'Legitimate retry remains usable when global capacity is exhausted');
  assert.ok(report(store, { message: 'Next window' }, { now: now + anonymous.rateLimit.windowMs }).receipt);
  const beforeFailure = store.read();
  assert.throws(() => report(store, { message: 'Fails encryption atomically' }, { now: now + 2 * anonymous.rateLimit.windowMs, lifecycle: { config, keyring: { activeVersion: 'missing', keys: {} } } }), error('KEY_UNAVAILABLE'));
  assert.deepEqual(store.read(), beforeFailure);
});

test('anonymous receipts reveal only their own configured status and expire at the exact boundary', t => {
  const store = setup(t), first = report(store), second = report(store, { message: 'Other report' });
  const records = Object.values(store.read().modules.lifecycle.records);
  command(store, manager, { action: 'transition', id: records[0].id, status: 'resolved', expectedVersion: 0, decisionCode: 'handled', note: 'Private operator explanation', assignee: 'queue-reviewer' });
  const result = status(store, first.receipt);
  assert.deepEqual(result.result, { code: 'handled', label: 'Handled.' });
  assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'expiresAt', 'result', 'status', 'updatedAt']);
  assert.equal(status(store, second.receipt).status, 'pending');
  assert.doesNotMatch(JSON.stringify(result), /Private operator explanation|queue-reviewer|subjectId|id|decisionCode|payload/);
  assert.equal(status(store, first.receipt, { now: first.expiresAt - 1 }).status, 'resolved');
  assert.throws(() => status(store, first.receipt, { now: first.expiresAt }), error('NOT_FOUND'));
  assert.throws(() => status(store, first.receipt, { now: first.expiresAt + 1 }), error('NOT_FOUND'));
  const changed = structuredClone(config); changed.workflows.privacy_report.publicResults.handled.label = 'Different configured label';
  assert.throws(() => status(store, first.receipt, { lifecycleConfig: changed }), error('NOT_FOUND'));
});

test('restore invalidates anonymous status and retry capabilities while preserving retained encrypted reports', t => {
  const store = setup(t), key = randomBytes(32).toString('base64url'), receipt = report(store, undefined, { key });
  const backup = store.backup(), target = setup(t);
  target.restore(backup, { now, withdrawnSubjectIds: [] });
  assert.deepEqual(target.read().modules.lifecycle.records, store.read().modules.lifecycle.records);
  assert.deepEqual(target.read().modules.reports, reportsModule.initialState());
  assert.throws(() => status(target, receipt.receipt), error('NOT_FOUND'));
  const next = report(target, undefined, { key });
  assert.notEqual(next.receipt, receipt.receipt);
});

test('retention and withdrawal immediately erase anonymous capability linkage and encrypted retries', t => {
  const store = setup(t), key = randomBytes(32).toString('base64url');
  const first = report(store, undefined, { key });
  const state = store.read(), record = Object.values(state.modules.lifecycle.records)[0];
  assert.equal(Object.keys(state.modules.reports.receipts).length, 1);
  assert.equal(Object.keys(state.modules.reports.replays).length, 1);
  command(store, manager, { action: 'retain' }, { now: record.expiresAt });
  const purged = store.read();
  assert.deepEqual(purged.modules.reports.receipts, {});
  assert.deepEqual(purged.modules.reports.replays, {});
  assert.equal(purged.modules.lifecycle.records[record.id].payload, null);
  assert.throws(() => status(store, first.receipt), error('NOT_FOUND'));
  const second = report(store, { message: 'Another report' }, { key: randomBytes(32).toString('base64url') });
  const active = Object.values(store.read().modules.lifecycle.records).find(value => value.purgedAt === null);
  command(store, { id: active.subjectId }, { action: 'withdraw' });
  assert.deepEqual(store.read().modules.reports.receipts, {});
  assert.deepEqual(store.read().modules.reports.replays, {});
  assert.throws(() => status(store, second.receipt), error('NOT_FOUND'));
});

test('restore forwards reviewed withdrawals to custom identity hooks and rolls back failed revocations', t => {
  const source = setup(t), enrollment = invite(source);
  const record = create(source, enrollment.principal), backup = source.backup();
  const target = setup(t), empty = target.read();
  const provider = {
    prepareRestore(state, options) { return localIdentityProvider.prepareRestore(state, options); },
    revokeSubject(state, subjectId, options) {
      localIdentityProvider.revokeSubject(state, subjectId, options);
      throw new Error('reviewed provider revocation failed');
    },
  };
  const review = { now, withdrawnSubjectIds: [enrollment.principal.id], revokedSubjectIds: [] };
  assert.throws(() => target.restore(backup, { ...review, provider }), /reviewed provider revocation failed/);
  assert.deepEqual(target.read(), empty);
  const calls = [];
  provider.revokeSubject = (state, subjectId, options) => { calls.push({ subjectId, now: options.now }); return localIdentityProvider.revokeSubject(state, subjectId, options); };
  target.restore(backup, { ...review, provider });
  assert.deepEqual(calls, [{ subjectId: enrollment.principal.id, now }]);
  assert.equal(target.read().modules.lifecycle.records[record.id].purgedAt, now);
  assert.equal(target.read().modules.participants.subjects.find(value => value.id === enrollment.principal.id).revokedAt, now);
});
