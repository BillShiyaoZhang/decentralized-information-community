import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RuntimeStore } from '../packages/runtime/store.mjs';
import { validateGraph, searchGraph, graphStats, neighborhood } from '../packages/core/index.js';
import { contentModule, defaultContentProfile, validateContent, configureContent, importContent, exportContent, readRevision, getEntity, publishContent, hideContent, setSourceDisposition, projectPublic, publicContentExport, readPublicRevision, matchesScope } from '../packages/runtime/content.mjs';
const fixture = {
  profile: JSON.parse(await readFile(new URL('../examples/runtime/content-profile.json', import.meta.url))),
  bundle: JSON.parse(await readFile(new URL('../examples/runtime/content.json', import.meta.url))),
};
const now = '2026-09-09T12:00:00.000Z';
const seed = () => importContent(contentModule.initialState({ profile: fixture.profile }), fixture.bundle);
const publish = (data, revisionId = 'answer-revision-17') => publishContent(data, { entityId: 'guide-answer', revisionId, expectedVersion: getEntity(data, 'guide-answer').version, now });
const code = expected => error => error.code === expected;
const secondRevision = (data, overrides = {}) => {
  const old = readRevision(data, 'answer-revision-17');
  const revision = { ...old, id: 'answer-revision-18', number: 4, parentRevisionId: old.id, data: { ...old.data, title: '新版答案', ...overrides } };
  const citations = data.citations.filter(item => item.revisionId === old.id).map(item => ({ ...item, id: `${item.id}-next`, revisionId: revision.id }));
  return importContent(data, { schemaVersion: 1, revisions: [revision], citations });
};

test('fixture round-trips external IDs, numbers, parent chains, extensions, and citation order', () => {
  const initial = seed(), next = secondRevision(initial);
  const bundle = exportContent(next);
  const roundtrip = importContent(contentModule.initialState({ profile: fixture.profile }), JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(exportContent(roundtrip), bundle);
  assert.deepEqual(importContent(next, bundle), next);
  assert.equal(readRevision(roundtrip, 'answer-revision-18').parentRevisionId, 'answer-revision-17');
  assert.equal(readRevision(roundtrip, 'artifact-revision-31').number, 7);
  assert.equal(roundtrip.citations[0].extensions.legacySpanId, 'span-17');
});

test('new content and source revisions preserve old content and exact evidence', () => {
  const initial = publish(seed()), old = readPublicRevision(initial, 'answer-revision-17', { now });
  const oldSource = readRevision(initial, 'artifact-revision-31');
  const newerSource = { ...oldSource, id: 'artifact-revision-33', number: 8, parentRevisionId: oldSource.id, data: { ...oldSource.data, text: '新版证据具有完全不同的内容。' } };
  const changed = importContent(secondRevision(initial), { schemaVersion: 1, revisions: [newerSource] });
  const next = publish(changed, 'answer-revision-18');
  assert.deepEqual(readPublicRevision(next, 'answer-revision-17', { now }), old);
  assert.equal(projectPublic(next, { now }).nodes[0].revisionId, 'answer-revision-18');
  assert.equal(old.citations[0].sourceRevisionId, 'artifact-revision-31');
  assert.equal(old.citations[0].excerpt, oldSource.data.text.slice(5, 19));
  const copied = readRevision(next, oldSource.id); copied.data.text = 'changed';
  assert.equal(readRevision(next, oldSource.id).data.text, oldSource.data.text);
});

test('immutable records cannot be rewritten, deleted, or gain evidence after creation', () => {
  const initial = seed(), before = structuredClone(initial);
  const record = readRevision(initial, 'answer-revision-17'); record.data.title = 'Overwrite';
  assert.throws(() => importContent(initial, { schemaVersion: 1, revisions: [record] }), code('IMMUTABLE'));
  for (const collection of ['revisions', 'citations']) { const changed = structuredClone(initial); changed[collection].pop(); assert.throws(() => validateContent(changed, initial)); }
  const late = { ...initial.citations[0], id: 'late-citation', order: 9 };
  assert.throws(() => importContent(initial, { schemaVersion: 1, citations: [late] }), code('IMMUTABLE'));
  assert.deepEqual(initial, before);
});

test('transaction store rejects direct immutable mutation and completely rolls back invalid import', () => {
  const module = { ...contentModule, initialState: () => contentModule.initialState({ profile: fixture.profile }) };
  const store = new RuntimeStore(':memory:', { communityId: 'test', modules: [module] });
  try {
    store.transact(state => { state.modules.content = seed(); });
    const before = store.read();
    assert.throws(() => store.transact(state => { state.modules.content.revisions[0].data.title = 'rewritten'; state.audit.push({ fake: true }); }), code('IMMUTABLE'));
    assert.deepEqual(store.read(), before);
    const bad = structuredClone(fixture.bundle); bad.entities.push({ id: 'new-entity', type: 'answer' }); bad.citations[0].sourceRevisionId = 'absent';
    assert.throws(() => store.transact(state => { state.modules.content = importContent(state.modules.content, bad); state.audit.push({ fake: true }); }));
    assert.deepEqual(store.read(), before);
    assert.throws(() => store.transact(state => { state.modules.content.revisions.splice(0, 1); }));
    assert.deepEqual(store.read(), before);
  } finally { store.close(); }
});

test('missing, wrong-entity, and invalid-position references return stable errors', () => {
  for (const [edit, expected] of [
    [bundle => { bundle.citations[0].sourceRevisionId = 'missing'; }, 'REFERENCE_MISSING'],
    [bundle => { bundle.citations[0].sourceEntityId = 'guide-link'; }, 'REFERENCE_ENTITY'],
    [bundle => { bundle.citations[0].position.end = 100000; }, 'REFERENCE_POSITION'],
    [bundle => { bundle.citations[0].sentenceId = 'absent'; }, 'REFERENCE_POSITION'],
    [bundle => { bundle.citations[1].order = 0; }, 'REFERENCE_POSITION'],
    [bundle => { bundle.revisions[2].parentRevisionId = 'artifact-revision-31'; }, 'REFERENCE_ENTITY'],
  ]) {
    const bundle = structuredClone(fixture.bundle); edit(bundle);
    assert.throws(() => importContent(contentModule.initialState({ profile: fixture.profile }), bundle), code(expected));
  }
});

test('configured domain schema and citation-on-write policy enforce real constraints', () => {
  for (const [edit, expected] of [
    [bundle => { delete bundle.revisions[2].data.impact; }, 'DOMAIN_SCHEMA'],
    [bundle => { bundle.revisions[2].data.origin = 'unknown'; }, 'DOMAIN_SCHEMA'],
    [bundle => { bundle.citations = []; }, 'EVIDENCE_REQUIRED'],
  ]) { const bundle = structuredClone(fixture.bundle); edit(bundle); assert.throws(() => importContent(contentModule.initialState({ profile: fixture.profile }), bundle), code(expected)); }
  const profile = structuredClone(fixture.profile); profile.entityTypes[0].schema = { type: 'object', magicValidation: true };
  assert.throws(() => contentModule.initialState({ profile }), code('INVALID_PROFILE'));
  const changed = seed(); changed.profile.publication.blockedValues = {};
  assert.throws(() => validateContent(changed, seed()), code('IMMUTABLE'));
});

test('link-only content rejects hidden bodies, screenshots, hashes, untyped extensions, and excerpt positions', () => {
  for (const edit of [
    bundle => { bundle.revisions[1].data.body = 'Hidden text'; },
    bundle => { bundle.revisions[1].data.screenshot = 'data:image/png'; },
    bundle => { bundle.revisions[1].data.contentHash = 'sha256-value'; },
    bundle => { bundle.revisions[1].extensions.payload = { body: 'Hidden text' }; },
    bundle => { bundle.revisions[1].body = 'Hidden text'; },
    bundle => { bundle.entities[2].extensions = { body: 'Hidden text' }; },
    bundle => { bundle.citations[1].extensions = { quote: 'Hidden text' }; },
  ]) { const bundle = structuredClone(fixture.bundle); edit(bundle); assert.throws(() => importContent(contentModule.initialState({ profile: fixture.profile }), bundle), code('EVIDENCE_MODE')); }
  const bundle = structuredClone(fixture.bundle); bundle.citations[1].position = { kind: 'text', start: 0, end: 1 };
  assert.throws(() => importContent(contentModule.initialState({ profile: fixture.profile }), bundle), code('REFERENCE_POSITION'));
});

test('excerpt retention requires rights and expired rights suppress all public reads', () => {
  for (const rights of [undefined, {}, { basis: 'invented', reference: 'x' }]) {
    const bundle = structuredClone(fixture.bundle); if (rights === undefined) delete bundle.revisions[0].data.rights; else bundle.revisions[0].data.rights = rights;
    assert.throws(() => importContent(contentModule.initialState({ profile: fixture.profile }), bundle), code('RIGHTS_REQUIRED'));
  }
  const data = publish(seed()), future = '2100-01-01T00:00:00.000Z';
  assert.equal(projectPublic(data, { now: future }).nodes.length, 0);
  assert.equal(readPublicRevision(data, 'answer-revision-17', { now: future }), null);
  assert.throws(() => publishContent(data, { entityId: 'guide-answer', revisionId: 'answer-revision-17', expectedVersion: 1, now: future }), code('SOURCE_UNAVAILABLE'));
});

test('publish rejects stale versions, cross-entity pointers, high impact, and AI drafts without side effects', () => {
  const data = seed(), before = structuredClone(data);
  assert.throws(() => publishContent(data, { entityId: 'guide-answer', revisionId: 'answer-revision-17', expectedVersion: 9, now }), code('CONFLICT'));
  assert.throws(() => publishContent(data, { entityId: 'guide-answer', revisionId: 'artifact-revision-31', expectedVersion: 0, now }), code('REFERENCE_ENTITY'));
  for (const overrides of [{ impact: 'high' }, { origin: 'ai_draft' }]) {
    const changed = secondRevision(data, overrides);
    assert.throws(() => publish(changed, 'answer-revision-18'), code('POLICY_REJECTED'));
    assert.equal(getEntity(changed, 'guide-answer').publicRevisionId, null);
  }
  assert.deepEqual(data, before);
  const bundle = structuredClone(fixture.bundle); bundle.entities[0].publicRevisionId = 'answer-revision-17';
  assert.throws(() => importContent(contentModule.initialState({ profile: fixture.profile }), bundle), code('INVALID_CONTENT'));
});

test('human publication cannot bypass AI policy; a separate human revision can be published', () => {
  const initial = seed(), ai = secondRevision(initial, { origin: 'ai_draft' });
  assert.throws(() => publish(ai, 'answer-revision-18'), code('POLICY_REJECTED'));
  const revision = { ...readRevision(ai, 'answer-revision-18'), id: 'answer-revision-19', number: 5, parentRevisionId: 'answer-revision-18', data: { ...readRevision(ai, 'answer-revision-18').data, origin: 'human' } };
  const citations = ai.citations.filter(item => item.revisionId === 'answer-revision-18').map(item => ({ ...item, id: `${item.id}-human`, revisionId: revision.id }));
  const human = publish(importContent(ai, { schemaVersion: 1, revisions: [revision], citations }), revision.id);
  assert.equal(readRevision(human, 'answer-revision-18').data.origin, 'ai_draft');
  assert.equal(projectPublic(human, { now }).nodes[0].revisionId, revision.id);
  assert.equal(readPublicRevision(human, 'answer-revision-18', { now }), null);
});

test('public lists, details, history, search, graph calculations, and exports share visibility', () => {
  const published = publish(seed()), data = secondRevision(published);
  assert.equal(readPublicRevision(data, 'answer-revision-18', { now }), null);
  const graph = projectPublic(data, { now }); validateGraph(graph);
  assert.equal(searchGraph(graph, { query: '课程' }).length, 1); assert.equal(graphStats(graph).nodes, 1); assert.equal(neighborhood(graph, 'guide-answer').nodes.length, 1);
  assert.equal(publicContentExport(data, { now }).revisions.length, 1);
  assert.ok(!JSON.stringify(graph).includes('privateEditorialNote'));
  assert.ok(!JSON.stringify(publicContentExport(data, { now })).includes('legacySlug'));
  for (const hidden of [
    hideContent(data, { entityId: 'guide-answer', expectedVersion: 1 }),
    hideContent(data, { entityId: 'guide-source', expectedVersion: 0 }),
    setSourceDisposition(data, { entityId: 'guide-source', expectedVersion: 0, disposition: 'withdrawn' }),
    setSourceDisposition(data, { entityId: 'guide-link', expectedVersion: 0, disposition: 'rights-expired' }),
  ]) {
    const projection = projectPublic(hidden, { now }); assert.equal(projection.nodes.length, 0); assert.equal(projection.edges.length, 0);
    assert.equal(searchGraph(projection).length, 0); assert.equal(graphStats(projection).nodes, 0);
    assert.equal(readPublicRevision(hidden, 'answer-revision-17', { now }), null);
    assert.equal(publicContentExport(hidden, { now }).revisions.length, 0);
    assert.equal(readRevision(hidden, 'answer-revision-17').id, 'answer-revision-17');
  }
});

test('review-overdue warnings survive publication and alias-aware search', () => {
  const data = publish(seed());
  assert.equal(projectPublic(data, { now, query: 'xjtlu' }).nodes.length, 1);
  assert.equal(projectPublic(data, { now, query: '西浦 课程' }).nodes.length, 1);
  assert.equal(projectPublic(data, { now, query: 'unmatched' }).nodes.length, 0);
  assert.deepEqual(projectPublic(data, { now }).nodes[0].warnings, [fixture.profile.warnings.reviewOverdue]);
});

test('direct historical URLs cannot bypass suppression of the current entity', () => {
  const initial = publish(seed()), nextRevision = readRevision(initial, 'answer-revision-17');
  nextRevision.id = 'answer-revision-current'; nextRevision.number++; nextRevision.parentRevisionId = 'answer-revision-17';
  const source = readRevision(initial, 'artifact-revision-31'); source.id = 'new-source-v1'; source.entityId = 'new-source'; source.number = 1; source.parentRevisionId = null;
  const citation = { ...initial.citations[0], id: 'new-source-citation', revisionId: nextRevision.id, sourceRevisionId: source.id, sourceEntityId: source.entityId };
  const data = publish(importContent(initial, { schemaVersion: 1, entities: [{ id: source.entityId, type: 'artifact' }], revisions: [source, nextRevision], citations: [citation] }), nextRevision.id);
  const suppressed = setSourceDisposition(data, { entityId: source.entityId, disposition: 'withdrawn', expectedVersion: 0 });
  assert.equal(projectPublic(suppressed, { now }).nodes.length, 0);
  assert.equal(readPublicRevision(suppressed, 'answer-revision-17', { now }), null);
  assert.equal(publicContentExport(suppressed, { now }).revisions.length, 0);
});

test('scope uses OR within dimensions, AND across dimensions, universal and unknown rules', () => {
  const profile = fixture.profile;
  const scope = { campus: ['suzhou', 'taicang'], stage: ['undergraduate'] };
  assert.equal(matchesScope(scope, { campus: ['other', 'taicang'], stage: ['undergraduate'] }, profile), true);
  assert.equal(matchesScope(scope, { campus: ['suzhou'], stage: ['postgraduate'] }, profile), false);
  assert.equal(matchesScope({ campus: ['universal'] }, { campus: ['anything'] }, profile), true);
  assert.equal(matchesScope({ campus: ['unknown'] }, { campus: ['unknown'] }, profile), false);
  assert.equal(matchesScope({}, { campus: ['suzhou'] }, profile), false);
  assert.equal(matchesScope({ campus: ['unknown'] }, {}, profile), true);
  const data = publish(seed());
  assert.equal(projectPublic(data, { now, scope: { campus: ['any'], stage: ['undergraduate'] } }).nodes.length, 1);
  assert.equal(projectPublic(data, { now, scope: { stage: ['postgraduate'] } }).nodes.length, 0);
  assert.throws(() => projectPublic(data, { scope: { invented: ['x'] } }), code('DOMAIN_SCHEMA'));
});

test('generic graph and alternate profile remain independent of campus names', () => {
  const profile = structuredClone(defaultContentProfile);
  profile.entityTypes = [{ id: 'decision', role: 'content' }, { id: 'record', role: 'source' }];
  profile.evidence.factualSentenceKinds = ['assertion']; profile.scope.dimensions = ['team'];
  const bundle = { schemaVersion: 1, entities: [{ id: 'decision', type: 'decision' }], revisions: [{ id: 'decision-v1', entityId: 'decision', number: 1, parentRevisionId: null, createdAt: now, data: { title: 'Decision', sentences: [{ id: 's1', kind: 'opinion', text: 'An option to discuss.' }], scope: { team: ['alpha'] } } }] };
  const data = publishContent(importContent(contentModule.initialState({ profile }), bundle), { entityId: 'decision', revisionId: 'decision-v1', expectedVersion: 0, now });
  assert.equal(projectPublic(data, { scope: { team: ['alpha'] } }).nodes[0].type, 'decision');
  validateGraph(projectPublic(data));
});

test('explicit configuration validates history and immediately narrows public rules', () => {
  const data = publish(seed()), profile = structuredClone(data.profile);
  profile.publication.blockedValues.impact.push('routine');
  const changed = configureContent(data, profile);
  assert.equal(projectPublic(changed, { now }).nodes.length, 0);
  assert.deepEqual(changed.revisions, data.revisions);
  assert.throws(() => validateContent(changed, data), code('IMMUTABLE'));
  profile.entityTypes[0].schema.required.push('new-required-field');
  assert.throws(() => configureContent(data, profile), code('DOMAIN_SCHEMA'));
});
