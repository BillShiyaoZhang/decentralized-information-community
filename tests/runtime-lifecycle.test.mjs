import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, bootstrapAccount, login, totpCode, executeAuthorized, readAuthorized } from '../packages/runtime/auth.mjs';
import { contentModule, importContent, publishContent, hideContent, setSourceDisposition } from '../packages/runtime/content.mjs';
import { lifecycleModule, lifecycleCommand, lifecycleDetail, lifecycleList, lifecyclePublicResults, decryptPrivatePayload, encryptPrivatePayload, legacyIntakeKey, importLegacyIntakeEnvelope, migratePrivateRecord } from '../packages/runtime/lifecycle.mjs';

const config = JSON.parse(readFileSync(new URL('../examples/runtime/lifecycle.json', import.meta.url)));
const keyring = { activeVersion: 'key-1', keys: { 'key-1': Buffer.alloc(32, 7) } };
const now = 1800000000000;
const participant = { id: 'person-1', displayName: 'Participant', roles: ['participant'], mfa: true };
const manager = { id: 'reviewer-1', displayName: 'Reviewer', roles: ['pilot_operator'], mfa: true };
const ops = { id: 'operations-1', displayName: 'Operator', roles: ['operations_admin'], mfa: true };
const errorCode = code => error => error.code === code;
const contentFixture = {
  profile: JSON.parse(readFileSync(new URL('../examples/runtime/content-profile.json', import.meta.url))),
  bundle: JSON.parse(readFileSync(new URL('../examples/runtime/content.json', import.meta.url))),
};
function publishedContent() {
  const seed = importContent(contentModule.initialState({ profile: contentFixture.profile }), contentFixture.bundle);
  return publishContent(seed, { entityId: 'guide-answer', revisionId: 'answer-revision-17', expectedVersion: 0, now: new Date(now).toISOString() });
}
const publishedContentModule = { ...contentModule, initialState: publishedContent };

function fixture(t, modules = [lifecycleModule]) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-lifecycle-'));
  const store = new RuntimeStore(join(directory, 'private.sqlite'), { communityId: 'test-community', modules });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function run(store, input, principal = participant, overrides = {}) {
  return store.transact(state => lifecycleCommand(state, principal, input, { config, keyring, now, ...overrides }));
}
function consent(store, principal = participant) {
  return run(store, { action: 'consent', type: 'private_intake', version: '2026-09', accepted: true, eligibility: { eligible: true, adult: true } }, principal);
}
function create(store, input = {}, principal = participant) {
  const grant = consent(store, principal);
  return run(store, { action: 'create', id: 'intake-1', type: 'private_intake', consentEpoch: grant.consentEpoch, entityId: 'answer-1', revisionId: 'answer-1:r1', payload: { body: 'secret interview text', contact: 'private@example.invalid' }, ...input }, principal);
}

test('private payload and internal notes are encrypted; list and public result use explicit fields', t => {
  const store = fixture(t);
  const result = create(store);
  assert.equal(result.version, 0);
  const raw = JSON.stringify(store.read());
  assert.equal(raw.includes('secret interview text'), false);
  assert.equal(raw.includes('private@example.invalid'), false);
  assert.equal(raw.includes(keyring.keys['key-1'].toString('hex')), false);
  const list = lifecycleList(store.read());
  assert.equal('payload' in list[0], false);
  assert.equal('subjectId' in list[0], false);
  assert.deepEqual(lifecyclePublicResults(store.read()), []);
  run(store, { action: 'transition', id: result.id, expectedVersion: 0, status: 'reviewing', assignee: manager.id, note: 'Confidential reviewer observation' }, manager);
  assert.equal(JSON.stringify(store.read()).includes('Confidential reviewer observation'), false);
  const before = store.read().audit.length;
  const detail = store.transact(state => lifecycleDetail(state, manager, result.id, { keyring, now }));
  assert.equal(detail.payload.data.body, 'secret interview text');
  assert.equal(detail.payload.internalNotes[0].text, 'Confidential reviewer observation');
  assert.equal(store.read().audit.length, before + 1);
  assert.equal(store.read().audit.at(-1).action, 'lifecycle.detail.read');
  const ownerDetail = store.transact(state => lifecycleDetail(state, participant, result.id, { keyring, now }));
  assert.equal('internalNotes' in ownerDetail.payload, false);
  assert.equal(JSON.stringify(ownerDetail).includes('Confidential reviewer observation'), false);
});

test('unauthorized details and mutations fail without audit or state; invalid transitions and versions roll back', t => {
  const store = fixture(t); create(store);
  const before = store.read();
  assert.throws(() => run(store, { action: 'transition', id: 'intake-1', expectedVersion: 0, status: 'reviewing' }), errorCode('FORBIDDEN'));
  assert.throws(() => store.transact(state => lifecycleDetail(state, { ...participant, id: 'stranger' }, 'intake-1', { keyring, now })), errorCode('FORBIDDEN'));
  assert.throws(() => run(store, { action: 'transition', id: 'intake-1', expectedVersion: 1, status: 'reviewing' }, manager), errorCode('VERSION_CONFLICT'));
  assert.throws(() => run(store, { action: 'transition', id: 'intake-1', expectedVersion: 0, status: 'accepted', decisionCode: 'used' }, manager), errorCode('INVALID_TRANSITION'));
  assert.deepEqual(store.read(), before);
});

test('configured decisions alone can create a public result; request fields cannot publish private details', t => {
  const store = fixture(t, [publishedContentModule, lifecycleModule]);
  run(store, { action: 'create', id: 'report-1', type: 'report', entityId: 'guide-answer', revisionId: 'answer-revision-17', payload: { report: 'private report' }, publicResult: { code: 'leak', label: 'private report' } });
  run(store, { action: 'transition', id: 'report-1', expectedVersion: 0, status: 'triage', note: 'sensitive handling note' }, manager);
  run(store, { action: 'transition', id: 'report-1', expectedVersion: 1, status: 'resolved', decisionCode: 'corrected', publicResult: { label: 'private report' } }, manager);
  assert.deepEqual(lifecyclePublicResults(store.read(), { now }), [{ entityId: 'guide-answer', revisionId: 'answer-revision-17', result: config.workflows.report.publicResults.corrected, updatedAt: now }]);
  assert.equal(JSON.stringify(lifecyclePublicResults(store.read(), { now })).includes('sensitive'), false);
  const snapshot = store.read();
  snapshot.modules.content = hideContent(snapshot.modules.content, { entityId: 'guide-answer', expectedVersion: 1, hidden: true });
  assert.deepEqual(lifecyclePublicResults(snapshot, { now }), []);
  const retracted = store.read();
  retracted.modules.content = setSourceDisposition(retracted.modules.content, { entityId: 'guide-source', disposition: 'withdrawn', expectedVersion: 0 });
  assert.deepEqual(lifecyclePublicResults(retracted, { now }), []);
});

test('private links must reference existing entities and matching immutable revisions', t => {
  const store = fixture(t, [publishedContentModule, lifecycleModule]);
  const before = store.read();
  assert.throws(() => run(store, { action: 'create', type: 'report', entityId: 'missing', payload: {} }), errorCode('REFERENCE_MISSING'));
  assert.throws(() => run(store, { action: 'create', type: 'report', entityId: 'guide-answer', revisionId: 'artifact-revision-31', payload: {} }), errorCode('REFERENCE_ENTITY'));
  assert.throws(() => run(store, { action: 'create', type: 'report', revisionId: 'answer-revision-17', payload: {} }), errorCode('REFERENCE_ENTITY'));
  assert.deepEqual(store.read(), before);
});

test('consent version, eligibility, subject ownership and epoch are checked inside the write transaction', t => {
  const store = fixture(t);
  assert.throws(() => run(store, { action: 'consent', type: 'private_intake', version: 'old', accepted: true, eligibility: { eligible: true, adult: true } }), errorCode('CONSENT_REQUIRED'));
  assert.throws(() => run(store, { action: 'consent', type: 'private_intake', version: '2026-09', accepted: true, eligibility: { eligible: true, adult: false } }), errorCode('INELIGIBLE'));
  assert.throws(() => run(store, { action: 'consent', type: 'private_intake', subjectId: 'other' }), errorCode('FORBIDDEN'));
  const old = consent(store);
  consent(store);
  const before = store.read();
  assert.throws(() => run(store, { action: 'create', type: 'private_intake', consentEpoch: old.consentEpoch, payload: { body: 'in flight' } }), errorCode('CONSENT_CONFLICT'));
  assert.deepEqual(store.read(), before);
});

test('withdrawal clears ciphertext, associations, linked replay results and blocks in-flight and later writes', t => {
  const store = fixture(t);
  const record = create(store), ciphertext = store.read().modules.lifecycle.records[record.id].payload.ciphertext;
  store.transact(state => {
    state.idempotency.owner = { subjectId: participant.id, result: { id: record.id, private: 'must erase' } };
    state.idempotency.reviewer = { subjectId: manager.id, result: { id: record.id } };
    state.idempotency.unrelated = { subjectId: 'unrelated', result: { id: 'unrelated-record' } };
  });
  run(store, { action: 'withdraw' });
  const current = store.read(), purged = current.modules.lifecycle.records[record.id];
  assert.equal(purged.payload, null);
  assert.equal(purged.subjectId, null);
  assert.equal(purged.entityId, null);
  assert.equal(purged.revisionId, null);
  assert.equal(purged.assignee, null);
  assert.equal(JSON.stringify(current).includes(ciphertext), false);
  assert.deepEqual(Object.keys(current.idempotency), ['unrelated']);
  assert.deepEqual(current.modules.lifecycle.subjects[participant.id].eligibility, {});
  assert.deepEqual(current.modules.lifecycle.subjects[participant.id].consents, {});
  assert.throws(() => run(store, { action: 'create', id: 'inflight', type: 'private_intake', consentEpoch: 1, payload: { body: 'in flight' } }), errorCode('CONSENT_WITHDRAWN'));
  assert.throws(() => run(store, { action: 'create', id: 'bypass', type: 'report', payload: {} }), errorCode('CONSENT_WITHDRAWN'));
  assert.throws(() => run(store, { action: 'transition', id: record.id, expectedVersion: 0, status: 'reviewing' }, manager), errorCode('RECORD_EXPIRED'));
  assert.throws(() => consent(store), errorCode('CONSENT_WITHDRAWN'));
  assert.throws(() => store.transact(state => { state.modules.lifecycle.subjects[participant.id].withdrawnAt = null; }), errorCode('WITHDRAWAL_IMMUTABLE'));
  assert.throws(() => store.transact(state => { delete state.modules.lifecycle.records[record.id]; }), errorCode('PURGE_IMMUTABLE'));
  assert.equal(run(store, { action: 'withdraw' }).withdrawn, true);
});

test('retention is repeatable, physically clears payload, and refuses expired detail before cleanup', t => {
  const store = fixture(t); create(store);
  const expiry = now + config.workflows.private_intake.retentionMs;
  assert.throws(() => store.transact(state => lifecycleDetail(state, manager, 'intake-1', { keyring, now: expiry })), errorCode('RECORD_EXPIRED'));
  const first = run(store, { action: 'retain' }, ops, { now: expiry });
  assert.equal(first.evidence.purged, 1);
  const second = run(store, { action: 'retain' }, ops, { now: expiry });
  assert.equal(second.evidence.purged, 0);
  assert.equal(store.read().modules.lifecycle.records['intake-1'].payload, null);
  assert.equal(store.read().modules.lifecycle.runs.length, 2);
});

test('external maintenance failure is observable without storing sensitive exception details or async work', t => {
  const store = fixture(t); create(store);
  const before = store.read().modules.lifecycle.records;
  const failed = run(store, { action: 'task', task: 'backup-health' }, ops, { taskProvider() { throw new Error('secret provider token'); } });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.evidence, { errorCode: 'TASK_FAILED' });
  assert.equal(JSON.stringify(store.read()).includes('secret provider token'), false);
  assert.deepEqual(store.read().modules.lifecycle.records, before);
  const async = run(store, { action: 'task', task: 'backup-health' }, ops, { taskProvider: () => Promise.resolve({ healthy: true }) });
  assert.equal(async.status, 'failed');
  const success = run(store, { action: 'task', task: 'backup-health' }, ops, { taskProvider: () => ({ provider: 'operator', backupVerified: true, checkedAt: now }) });
  assert.equal(success.status, 'succeeded');
  assert.equal(store.read().modules.lifecycle.runs.length, 3);
});

test('private migration preserves real guide ciphertext AAD and external ID or explicitly decrypts and re-encrypts', t => {
  const source = fixture(t); create(source);
  const id = 'legacy-intake-7', secret = 'legacy-key-material-never-written-to-a-repository';
  const legacyKey = legacyIntakeKey(secret), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
  cipher.setAAD(Buffer.from(`research-intake:v1:${id}`));
  const value = { contextScope: 'community', body: 'original encrypted intake', sourceUrl: null, provenanceRole: null };
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  const encrypted = `v1.${iv.toString('base64url')}.${body.toString('base64url')}`;
  const legacyKeyring = { activeVersion: 'legacy-1', keys: { 'legacy-1': legacyKey } };
  const record = { ...source.read().modules.lifecycle.records['intake-1'], id, externalId: id, payload: importLegacyIntakeEnvelope(id, encrypted, 'legacy-1') };
  assert.deepEqual(decryptPrivatePayload(id, record.payload, legacyKeyring), value);
  const preserved = migratePrivateRecord(record, { keyring: legacyKeyring });
  assert.deepEqual(preserved, record);
  assert.throws(() => migratePrivateRecord(record, { id: 'new-id', keyring: legacyKeyring }), errorCode('ENCRYPTION_CONTEXT_CHANGE'));
  const converted = migratePrivateRecord(record, { id: 'new-id', keyring: legacyKeyring, targetKeyring: keyring, reencrypt: true });
  assert.equal(converted.externalId, id);
  assert.equal(converted.payload.contextId, 'new-id');
  assert.equal(converted.payload.keyVersion, 'key-1');
  assert.deepEqual(decryptPrivatePayload('new-id', converted.payload, keyring), value);
  const imported = source.read().modules.lifecycle;
  imported.records = { [id]: record };
  const target = fixture(t);
  run(target, { action: 'import', data: imported }, manager, { keyring: legacyKeyring });
  assert.deepEqual(target.read().modules.lifecycle.records[id].payload, record.payload);
  assert.equal(lifecycleList(target.read())[0].id, id);
  assert.equal(JSON.stringify(lifecyclePublicResults(target.read())).includes(value.body), false);
  const corrupt = structuredClone(imported);
  corrupt.records[id].payload.tag = Buffer.alloc(16, 0).toString('base64url');
  const rollback = fixture(t), before = rollback.read();
  assert.throws(() => run(rollback, { action: 'import', data: corrupt }, manager, { keyring: legacyKeyring }), errorCode('DECRYPTION_FAILED'));
  assert.deepEqual(rollback.read(), before);
});

test('module validation prevents unencrypted or improperly purged fields from entering private backup', t => {
  const store = fixture(t); create(store);
  const before = store.read();
  assert.throws(() => store.transact(state => { state.modules.lifecycle.records['intake-1'].privateBody = 'plaintext'; }), errorCode('INVALID_LIFECYCLE'));
  assert.throws(() => store.transact(state => { state.modules.lifecycle.records['intake-1'].purgedAt = now; }), errorCode('INVALID_LIFECYCLE'));
  assert.deepEqual(store.read(), before);
  const wrongKeyring = { activeVersion: 'key-1', keys: { 'key-1': randomBytes(32) } };
  assert.throws(() => decryptPrivatePayload('intake-1', before.modules.lifecycle.records['intake-1'].payload, wrongKeyring), errorCode('DECRYPTION_FAILED'));
  assert.throws(() => encryptPrivatePayload('record', { secret: 'text' }, { activeVersion: 'short', keys: { short: Buffer.alloc(16) } }), errorCode('INVALID_KEY'));
});

test('an audit persistence failure prevents sensitive detail from being disclosed', t => {
  const guarded = { ...lifecycleModule, validateState(state) {
    if (state.audit.some(entry => entry.action === 'lifecycle.detail.read')) throw new Error('simulated audit persistence failure');
  } };
  const store = fixture(t, [guarded]); create(store);
  const before = store.read();
  assert.throws(() => store.transact(state => lifecycleDetail(state, manager, 'intake-1', { keyring, now })), /audit persistence failure/);
  assert.deepEqual(store.read(), before);
});

test('real MFA sessions and centralized replay remain atomic; withdrawal revokes every device while logout preserves consent', t => {
  const store = fixture(t, [authModule, lifecycleModule]);
  const mfaKey = Buffer.alloc(32, 9), totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  bootstrapAccount(store, { id: participant.id, displayName: participant.displayName, roles: participant.roles, password: 'correct-long-password', totpSecret }, { mfaKey, now });
  const session1 = login(store, { accountId: participant.id, password: 'correct-long-password', code: totpCode(totpSecret, now) }, { mfaKey, now });
  const now2 = now + 30000;
  const session2 = login(store, { accountId: participant.id, password: 'correct-long-password', code: totpCode(totpSecret, now2) }, { mfaKey, now: now2 });
  const protectedRun = (token, input, key = 'request-key-1') => executeAuthorized(store, token, { permission: 'lifecycle:self', action: `lifecycle.${input.action}`, key, input, now: now2, audit: false }, (state, principal) => lifecycleCommand(state, principal, input, { config, keyring, now: now2 }));
  const grant = protectedRun(session1.token, { action: 'consent', type: 'private_intake', accepted: true, version: '2026-09', eligibility: { eligible: true, adult: true } }, 'consent-request-1');
  const input = { action: 'create', id: 'protected-record', type: 'private_intake', consentEpoch: grant.consentEpoch, payload: { body: 'atomic private text' } };
  const first = protectedRun(session1.token, input), before = store.read();
  assert.deepEqual(protectedRun(session1.token, input), first);
  assert.equal(store.read().modules.lifecycle.records['protected-record'].version, 0);
  assert.equal(store.read().audit.length, before.audit.length);
  assert.throws(() => protectedRun(session1.token, { ...input, payload: { body: 'different' } }), errorCode('IDEMPOTENCY_CONFLICT'));
  protectedRun(session1.token, { action: 'logout' }, 'logout-request-1');
  assert.equal(store.read().modules.lifecycle.subjects[participant.id].withdrawnAt, null);
  assert.throws(() => protectedRun(session1.token, input), errorCode('UNAUTHENTICATED'));
  protectedRun(session2.token, { action: 'withdraw' }, 'withdraw-request-1');
  assert.equal(store.read().modules.lifecycle.records['protected-record'].payload, null);
  assert.ok(store.read().modules.auth.sessions.every(value => value.revokedAt !== null));
  assert.deepEqual(store.read().idempotency, {});
  assert.throws(() => protectedRun(session2.token, input), errorCode('UNAUTHENTICATED'));
  assert.throws(() => readAuthorized(store, session2.token, { permission: 'lifecycle:self', now: now2 }, state => lifecycleList(state)), errorCode('UNAUTHENTICATED'));
});
