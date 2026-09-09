import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { authModule, bootstrapAccount, totpCode } from '../packages/runtime/auth.mjs';
import { contentModule, defaultContentProfile } from '../packages/runtime/content.mjs';
import { lifecycleModule } from '../packages/runtime/lifecycle.mjs';
import { createRuntimeApp } from '../packages/runtime/http.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', mfaKey = 'ab'.repeat(32), password = 'local-test-password-2026';
const now = Date.now();
const createdAt = new Date(now - 60_000).toISOString();
function fixture() {
  return { schemaVersion: 1,
    entities: [{ id: 'answer', type: 'document' }, { id: 'source', type: 'source' }],
    revisions: [
      { id: 'source-v1', entityId: 'source', number: 1, parentRevisionId: null, createdAt, data: { title: 'Official source', mode: 'link-only', url: 'https://example.org/official' } },
      { id: 'answer-v1', entityId: 'answer', number: 1, parentRevisionId: null, createdAt, data: { title: 'Portal guide', origin: 'human', impact: 'low', reviewDueAt: new Date(now - 1).toISOString(), scope: { campus: ['universal'] }, sentences: [{ id: 'sentence-1', kind: 'fact', text: 'Portal is the official entry point.' }] } },
      { id: 'answer-draft', entityId: 'answer', number: 2, parentRevisionId: 'answer-v1', createdAt, data: { title: 'Hidden draft title', origin: 'ai_draft', impact: 'low', sentences: [{ id: 'draft-sentence', kind: 'opinion', text: 'Never public draft' }] } },
      { id: 'answer-no-evidence', entityId: 'answer', number: 3, parentRevisionId: 'answer-v1', createdAt, data: { title: 'No evidence', origin: 'human', impact: 'low', sentences: [{ id: 'fact-missing', kind: 'fact', text: 'Unsupported assertion' }] } },
      { id: 'answer-high', entityId: 'answer', number: 4, parentRevisionId: 'answer-v1', createdAt, data: { title: 'High impact', origin: 'human', impact: 'high', sentences: [{ id: 'high-sentence', kind: 'opinion', text: 'High impact statement' }] } },
    ], citations: [{ id: 'citation-1', revisionId: 'answer-v1', sentenceId: 'sentence-1', sourceEntityId: 'source', sourceRevisionId: 'source-v1', position: { kind: 'link' }, order: 0 }], links: [] };
}
async function harness() {
  const profile = structuredClone(defaultContentProfile); profile.scope.dimensions = ['campus', 'stage']; profile.search.aliases = { portal: ['ebridge'] };
  const store = new RuntimeStore(':memory:', { communityId: 'http-community', modules: [authModule, { ...contentModule, initialState: () => contentModule.initialState({ profile }) }, lifecycleModule] });
  for (const [id, roles] of [['reviewer', ['content_editor', 'content_reviewer', 'pilot_operator']], ['editor', ['content_editor']], ['participant', ['participant']]]) bootstrapAccount(store, { id, displayName: id, password, totpSecret: secret, roles }, { mfaKey, now });
  const config = { workflows: { report: { initialState: 'submitted', states: ['submitted', 'resolved'], transitions: { submitted: ['resolved'], resolved: [] }, terminalStates: ['resolved'], decisionCodes: ['corrected'], publicResults: { corrected: { code: 'corrected', label: 'Corrected.' } }, retentionMs: 86_400_000, requireConsent: false, eligibilityFields: [] } } };
  const server = createRuntimeApp({ store, auth: { mfaKey }, lifecycle: { config, keyring: { activeVersion: 'v1', keys: { v1: 'cd'.repeat(32) } } }, clock: () => now, assets: { '/': { body: 'Governed UI', type: 'text/html' }, '/data/private.json': { body: 'must not serve' } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, token = '', key = 'idempotent-default') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: JSON.stringify(value) });
  const get = (path, token = '') => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const signIn = async accountId => { const response = await post('/api/auth/login', { accountId, password, code: totpCode(secret, now) }); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return (await response.json()).token; };
  return { store, server, base, post, get, signIn, close: async () => { await new Promise(resolve => server.close(resolve)); store.close(); } };
}

test('governed HTTP performs real MFA login and atomic reviewed publication, including conflict/policy/forged author rejection', async () => {
  const h = await harness();
  try {
    const reviewer = await h.signIn('reviewer'), editor = await h.signIn('editor');
    assert.equal((await h.post('/api/content/import', fixture(), reviewer)).status, 200);
    const publication = { entityId: 'answer', revisionId: 'answer-v1', expectedVersion: 0, author: 'account_admin' };
    const before = h.store.read();
    assert.equal((await h.post('/api/content/publish', publication)).status, 401);
    assert.equal((await h.post('/api/content/publish', publication, editor)).status, 403);
    for (const revisionId of ['answer-draft', 'answer-no-evidence', 'answer-high']) assert.equal((await h.post('/api/content/publish', { ...publication, revisionId }, reviewer, `reject-${revisionId}`)).status, 422);
    assert.deepEqual(h.store.read(), before);
    const accepted = await h.post('/api/content/publish', publication, reviewer, 'first-publication'); assert.equal(accepted.status, 200); const result = await accepted.json(); assert.equal(result.version, 1);
    assert.deepEqual(await (await h.post('/api/content/publish', publication, reviewer, 'first-publication')).json(), result);
    const after = h.store.read();
    assert.equal((await h.post('/api/content/publish', publication, reviewer, 'conflict-publication')).status, 409);
    assert.deepEqual(h.store.read(), after);
    assert.equal(h.store.read().audit.filter(value => value.action === 'content.publish').length, 1);
    assert.equal(h.store.read().audit.at(-1).actorId, 'reviewer');
    const graph = await (await h.get('/api/graph')).json(); assert.equal(graph.id, 'http-community'); assert.ok(graph.revision > 0); assert.equal(graph.nodes.length, 1);
    assert.equal((await (await h.get('/api/search?q=ebridge')).json()).length, 1);
    assert.equal((await h.get('/api/revisions/answer-draft')).status, 404);
    assert.equal((await (await h.get('/api/entities/answer/history')).json()).length, 1);
    assert.equal((await h.get('/api/editor/revisions/answer-draft')).status, 401);
    assert.equal((await h.get('/api/editor/revisions/answer-draft', editor)).status, 200);
    for (const path of ['/api/changes', '/runtime.sqlite', '/backup.json', '/data/private.json', '/content/graph.json']) assert.equal((await h.get(path)).status, 404, path);
    assert.equal((await h.post('/api/changes', { author: 'admin' }, reviewer)).status, 404);
    const concurrent = await Promise.all(['first-reviewer', 'second-reviewer'].map(key => h.post('/api/content/hide', { entityId: 'answer', expectedVersion: 1 }, reviewer, key)));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
    assert.equal(h.store.read().audit.filter(value => value.action === 'content.hide').length, 1);
  } finally { await h.close(); }
});

test('source withdrawal and entity hiding apply across detail, historical, search, graph, statistics and public export', async () => {
  const h = await harness();
  try {
    const token = await h.signIn('reviewer');
    await h.post('/api/content/import', fixture(), token);
    await h.post('/api/content/publish', { entityId: 'answer', revisionId: 'answer-v1', expectedVersion: 0 }, token);
    for (const path of ['/api/graph', '/data/graph.json', '/api/list', '/api/search?q=portal', '/api/revisions/answer-v1', '/api/entities/answer/history', '/api/neighborhood?id=answer', '/api/analysis', '/api/export']) {
      const response = await h.get(path); assert.equal(response.status, 200, path); assert.match(response.headers.get('cache-control'), /no-store/);
    }
    await h.post('/api/content/hide', { entityId: 'answer', expectedVersion: 1 }, token);
    assert.equal((await h.get('/api/entities/answer')).status, 404);
    assert.equal((await h.get('/api/revisions/answer-v1')).status, 404);
    await h.post('/api/content/hide', { entityId: 'answer', expectedVersion: 2, hidden: false }, token, 'restore-answer');
    assert.equal((await h.get('/api/revisions/answer-v1')).status, 200);
    assert.equal((await h.post('/api/content/source', { entityId: 'source', expectedVersion: 0, disposition: 'withdrawn' }, token)).status, 200);
    for (const path of ['/api/graph', '/data/graph.json', '/api/list', '/api/search?q=portal', '/api/export', '/api/public-results']) { const response = await h.get(path); assert.equal(response.status, 200, path); assert.ok(!(await response.text()).includes('Portal'), path); }
    assert.equal((await (await h.get('/api/analysis')).json()).nodes, 0);
    assert.equal((await h.get('/api/entities/answer/history')).status, 404);
    assert.equal((await h.get('/api/revisions/answer-v1')).status, 404);
    assert.equal((await h.get('/api/neighborhood?id=answer')).status, 400);
  } finally { await h.close(); }
});

test('session revocation while a request body is uploading prevents the eventual write', async () => {
  const h = await harness();
  try {
    const token = await h.signIn('reviewer');
    const encoded = JSON.stringify(fixture());
    const pending = request(h.base + '/api/content/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'slow-upload-0001' } });
    pending.write(encoded.slice(0, 10));
    const completed = new Promise((resolve, reject) => { pending.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); pending.on('error', reject); });
    assert.equal((await h.post('/api/auth/logout', {}, token)).status, 200);
    pending.end(encoded.slice(10));
    assert.equal(await completed, 401);
    assert.equal(h.store.read().modules.content.entities.length, 0);
    assert.equal((await h.get('/api/auth/me', token)).status, 401);
  } finally { await h.close(); }
});

test('private routes encrypt payloads, restrict ownership and erase wrapper associations on consent withdrawal', async () => {
  const h = await harness();
  try {
    const participant = await h.signIn('participant'), reviewer = await h.signIn('reviewer');
    const consent = await h.post('/api/private/command', { action: 'consent', type: 'report', version: '1', accepted: true, eligibility: {} }, participant, 'grant-consent-0001');
    assert.equal(consent.status, 200); const grant = await consent.json();
    const create = await h.post('/api/private/command', { action: 'create', type: 'report', id: 'private-1', payload: { note: 'private payload marker' }, consentEpoch: grant.consentEpoch ?? grant.epoch }, participant, 'create-private-0001');
    assert.equal(create.status, 200, JSON.stringify(await create.clone().json()));
    assert.ok(!JSON.stringify(h.store.read()).includes('private payload marker'));
    assert.equal((await h.get('/api/private/private-1', participant)).status, 200);
    assert.equal((await h.get('/api/private/private-1', reviewer)).status, 200);
    assert.equal((await h.get('/api/private/list', participant)).status, 403);
    assert.equal((await h.post('/api/private/command', { action: 'withdraw' }, participant)).status, 200);
    const state = h.store.read();
    assert.equal(state.modules.lifecycle.records['private-1'].payload, null);
    assert.equal(state.audit.some(event => event.subjectId === 'participant'), false);
    assert.equal(Object.values(state.idempotency).some(entry => entry.subjectId === 'participant'), false);
    assert.equal((await h.get('/api/private/private-1', participant)).status, 401);
  } finally { await h.close(); }
});
