import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, bootstrapAccount, login, totpCode, authenticate } from '../packages/runtime/auth.mjs';
import { contentModule, importContent, publishContent, readRevision, readPublicRevision, projectPublic } from '../packages/runtime/content.mjs';
import { lifecycleModule, lifecycleCommand, lifecycleDetail, lifecyclePublicResults, decryptPrivatePayload, legacyIntakeKey, importLegacyIntakeEnvelope } from '../packages/runtime/lifecycle.mjs';
import { createCipheriv, randomBytes } from 'node:crypto';

const profile = JSON.parse(readFileSync(new URL('../examples/runtime/content-profile.json', import.meta.url)));
const bundle = JSON.parse(readFileSync(new URL('../examples/runtime/content.json', import.meta.url)));
const config = JSON.parse(readFileSync(new URL('../examples/runtime/lifecycle.json', import.meta.url)));
const keyring = { activeVersion: 'key-1', keys: { 'key-1': Buffer.alloc(32, 6) } };
const now = Date.parse('2026-09-09T12:00:00Z'), time = new Date(now).toISOString();
const principal = { id: 'participant-1', displayName: 'Participant', roles: ['participant'], mfa: true };
const manager = { id: 'reviewer', displayName: 'Reviewer', roles: ['pilot_operator'], mfa: true };
const code = value => error => error.code === value;
function empty(t) {
  const store = new RuntimeStore(':memory:', { communityId: 'restore-community', modules: [authModule, { ...contentModule, initialState: () => contentModule.initialState({ profile }) }, lifecycleModule] });
  t.after(() => store.close()); return store;
}
function command(store, input, actor = principal, at = now) { return store.transact(state => lifecycleCommand(state, actor, input, { config, keyring, now: at })); }
function source(t) {
  const store = empty(t);
  store.transact(state => { state.modules.content = importContent(state.modules.content, bundle); });
  store.transact(state => { state.modules.content = publishContent(state.modules.content, { entityId: 'guide-answer', revisionId: 'answer-revision-17', expectedVersion: 0, now: time }); });
  store.transact(state => {
    let content = state.modules.content;
    const old = readRevision(content, 'answer-revision-17');
    const revision = { ...old, id: 'answer-revision-18', number: 4, parentRevisionId: old.id, data: { ...old.data, title: 'Updated public answer' } };
    const citations = content.citations.filter(item => item.revisionId === old.id).map(item => ({ ...item, id: `${item.id}-new`, revisionId: revision.id }));
    content = importContent(content, { schemaVersion: 1, revisions: [revision], citations });
    state.modules.content = content;
  });
  store.transact(state => { state.modules.content = publishContent(state.modules.content, { entityId: 'guide-answer', revisionId: 'answer-revision-18', expectedVersion: 1, now: time }); });
  const mfaKey = Buffer.alloc(32, 4), secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  bootstrapAccount(store, { ...principal, password: 'long-password-for-restore-test', totpSecret: secret }, { mfaKey, now });
  const session = login(store, { accountId: principal.id, password: 'long-password-for-restore-test', code: totpCode(secret, now) }, { mfaKey, now });
  command(store, { action: 'create', id: 'report-1', type: 'report', entityId: 'guide-answer', revisionId: 'answer-revision-17', payload: { report: 'confidential recovered payload' } });
  command(store, { action: 'transition', id: 'report-1', expectedVersion: 0, status: 'triage' }, manager);
  command(store, { action: 'transition', id: 'report-1', expectedVersion: 1, status: 'resolved', decisionCode: 'corrected' }, manager);
  store.transact(state => { state.idempotency.old = { subjectId: principal.id, action: 'private.create', result: { id: 'report-1' } }; });
  return { store, session };
}

test('private restore preserves publication pointers, immutable history, encrypted context and external IDs while invalidating all sessions and replay records', t => {
  const { store, session } = source(t), backup = store.backup(), target = empty(t);
  const before = backup.state.modules.lifecycle.records['report-1'].payload;
  target.restore(backup, { now, withdrawnSubjectIds: [] });
  const restored = target.read(), content = restored.modules.content;
  assert.equal(content.entities.find(item => item.id === 'guide-answer').publicRevisionId, 'answer-revision-18');
  assert.deepEqual(readPublicRevision(content, 'answer-revision-17', { now: time }), readPublicRevision(backup.state.modules.content, 'answer-revision-17', { now: time }));
  assert.equal(readRevision(content, 'answer-revision-18').parentRevisionId, 'answer-revision-17');
  assert.equal(readRevision(content, 'artifact-revision-31').number, 7);
  assert.equal(content.entities.find(item => item.id === 'guide-answer').externalId, 'd1-answer-17');
  assert.deepEqual(restored.modules.lifecycle.records['report-1'].payload, before);
  assert.equal(decryptPrivatePayload('report-1', before, keyring).data.report, 'confidential recovered payload');
  assert.deepEqual(restored.modules.auth.sessions, []);
  assert.deepEqual(restored.idempotency, {});
  assert.throws(() => target.transact(state => authenticate(state, session.token, { now })), code('UNAUTHENTICATED'));
  assert.equal(lifecyclePublicResults(restored, { now }).length, 1);
  assert.equal(JSON.stringify(projectPublic(content, { now: time })).includes('confidential recovered payload'), false);
});

test('an old backup requires explicit current withdrawal reconciliation and cannot reactivate withdrawn subjects', t => {
  const { store } = source(t), old = store.backup(), target = empty(t), initial = target.read();
  command(store, { action: 'withdraw' });
  assert.throws(() => target.restore(old, { now }), code('LIFECYCLE_RECONCILIATION_REQUIRED'));
  assert.deepEqual(target.read(), initial);
  assert.throws(() => target.restore(old, { now, withdrawnSubjectIds: ['invalid subject id'] }), code('INVALID_WITHDRAWAL_REGISTER'));
  assert.deepEqual(target.read(), initial);
  target.restore(old, { now, withdrawnSubjectIds: [principal.id, 'not-in-this-backup'] });
  const restored = target.read(), record = restored.modules.lifecycle.records['report-1'];
  assert.equal(record.payload, null);
  assert.equal(record.subjectId, null);
  assert.equal(record.entityId, null);
  assert.equal(record.publicResult, null);
  assert.equal(restored.modules.lifecycle.subjects[principal.id].withdrawnAt, now);
  assert.deepEqual(lifecyclePublicResults(restored, { now }), []);
  assert.deepEqual(restored.idempotency, {});
  assert.equal(restored.audit.some(entry => entry.subjectId === principal.id || entry.actorId === principal.id), false);
  assert.throws(() => command(target, { action: 'create', id: 'resurrected', type: 'report', payload: {} }), code('CONSENT_WITHDRAWN'));
  assert.equal(restored.audit.find(entry => entry.action === 'lifecycle.restore.reconcile').metadata.unknownSubjects, 1);
});

test('restore purges expired ciphertext and linkage atomically before any read or public result can be served', t => {
  const { store } = source(t), backup = store.backup(), target = empty(t), expiry = now + config.workflows.report.retentionMs;
  target.restore(backup, { now: expiry, withdrawnSubjectIds: [] });
  const restored = target.read(), record = restored.modules.lifecycle.records['report-1'];
  assert.equal(record.payload, null);
  assert.equal(record.purgedAt, expiry);
  assert.equal(record.revisionId, null);
  assert.deepEqual(lifecyclePublicResults(restored, { now: expiry }), []);
  const detail = target.transact(state => lifecycleDetail(state, manager, 'report-1', { keyring, now: expiry }));
  assert.equal(detail.payload, null);
  assert.equal(restored.modules.lifecycle.runs.at(-1).evidence.purged, 1);
});

test('wrong backup envelope, broken citation and mismatched private reference leave the target completely empty', t => {
  const { store } = source(t), backup = store.backup();
  for (const corrupt of [
    value => { value.kind = 'public-content-projection'; },
    value => { value.state.modules.content.citations[0].sourceRevisionId = 'missing'; },
    value => { value.state.modules.lifecycle.records['report-1'].revisionId = 'artifact-revision-31'; },
    value => { value.state.modules.lifecycle.records['report-1'].payload.contextId = 'changed-id'; },
  ]) {
    const target = empty(t), initial = target.read(), broken = structuredClone(backup);
    corrupt(broken);
    assert.throws(() => target.restore(broken, { now, withdrawnSubjectIds: [] }));
    assert.deepEqual(target.read(), initial);
  }
});

test('backup restore retains legacy guide AES-GCM AAD and key version without silently renaming encrypted IDs', t => {
  const { store } = source(t), secret = 'a-real-fixture-legacy-secret-with-at-least-32-characters', key = legacyIntakeKey(secret), iv = randomBytes(12);
  const id = 'legacy-record', value = { contextScope: 'old guide scope', body: 'legacy sensitive ciphertext', sourceUrl: null, provenanceRole: null };
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(`research-intake:v1:${id}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  const envelope = importLegacyIntakeEnvelope(id, `v1.${iv.toString('base64url')}.${encrypted.toString('base64url')}`, 'old-key-version');
  store.transact(state => { const record = state.modules.lifecycle.records['report-1']; delete state.modules.lifecycle.records['report-1']; state.modules.lifecycle.records[id] = { ...record, id, externalId: 'legacy-record', payload: envelope }; });
  const target = empty(t); target.restore(store.backup(), { now, withdrawnSubjectIds: [] });
  const restored = target.read().modules.lifecycle.records[id];
  assert.deepEqual(restored.payload, envelope);
  assert.equal(restored.externalId, 'legacy-record');
  assert.deepEqual(decryptPrivatePayload(id, restored.payload, { keys: { 'old-key-version': key } }), value);
});
