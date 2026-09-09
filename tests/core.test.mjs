import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyChange, diffGraphs, GraphError, graphStats, makeChange, neighborhood, searchGraph, validateGraph } from '../packages/core/index.js';
import { StaticAdapter } from '../packages/adapters/index.js';
const seed = JSON.parse(await readFile(new URL('../examples/campus/graph.json', import.meta.url)));
const node = id => ({ ...seed.nodes[0], id, title: `测试 ${id}` });
const proposal = (g, id) => makeChange(g, [{ op: 'putNode', value: node(id) }]);
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };

test('both domain blueprints validate without changing the core', async () => {
  assert.equal(validateGraph(seed).nodes.length, 8);
  const decisions = JSON.parse(await readFile(new URL('../examples/decisions/graph.json', import.meta.url)));
  assert.equal(validateGraph(decisions).ontology.nodeTypes[0].id, 'problem');
  const next = applyChange(decisions, makeChange(decisions, [{ op: 'putNode', value: { ...decisions.nodes[0], id: 'another-problem' } }]));
  assert.equal(next.nodes.length, 4);
});
test('a proposal atomically adds nodes and their typed relation', () => {
  const change = makeChange(seed, [{ op: 'putNode', value: node('new-topic') }, { op: 'putEdge', value: { id: 'new-link', from: 'new-topic', to: 'arrival', type: 'related', reason: '测试关联' } }]);
  const next = applyChange(seed, change);
  assert.equal(next.revision, 1); assert.equal(seed.revision, 0); assert.equal(next.edges.length, seed.edges.length + 1);
});
test('invalid edge or required source rejects the whole transaction', () => {
  const change = makeChange(seed, [{ op: 'putNode', value: node('new-topic') }, { op: 'putEdge', value: { id: 'bad', from: 'new-topic', to: 'missing', type: 'related', reason: '测试' } }]);
  assert.throws(() => applyChange(seed, change), GraphError); assert.equal(seed.nodes.length, 8);
  assert.throws(() => applyChange(seed, makeChange(seed, [{ op: 'putNode', value: { ...node('bad-resource'), type: 'resource', source: '' } }])), GraphError);
});
test('direction, duplicates and unsafe sources are rejected', () => {
  const graph = structuredClone(seed); graph.edges.push({ ...graph.edges[0], id: 'duplicate' }); assert.throws(() => validateGraph(graph), /相同关联/);
  graph.edges.pop(); graph.edges[0].from = 'arrival'; graph.edges[0].to = 'packing'; assert.throws(() => validateGraph(graph), /方向约束/);
  const bad = structuredClone(seed); bad.nodes[0].source = 'javascript:alert(1)'; assert.throws(() => validateGraph(bad), /HTTP/);
});
test('replayed, stale and wrong-community proposals fail', () => {
  const change = proposal(seed, 'new'); const next = applyChange(seed, change);
  assert.throws(() => applyChange(next, change), e => e.code === 'CONFLICT');
  assert.throws(() => applyChange(seed, { ...change, graphId: 'other' }), GraphError);
});
test('malformed ontology and impossible dates have validation errors', () => {
  for (const key of ['nodeTypes', 'relationTypes']) { const graph = structuredClone(seed); graph.ontology[key] = [null]; assert.throws(() => validateGraph(graph), GraphError); }
  for (const updatedAt of ['2026-02-30T00:00:00Z', '2026-09-09T10:00:00', '2026-09-09T10:00:00+08:00']) { const graph = structuredClone(seed); graph.nodes[0].updatedAt = updatedAt; assert.throws(() => validateGraph(graph), GraphError); }
});
test('Chinese search, title weighting, filters and multi-term matching', () => {
  assert.equal(searchGraph(seed, { query: '新生入学' })[0].id, 'arrival');
  assert.equal(searchGraph(seed, { query: '准备 材料' })[0].id, 'packing');
  assert.ok(searchGraph(seed, { type: 'resource' }).every(n => n.type === 'resource'));
  assert.equal(searchGraph(seed, { query: '不存在的词' }).length, 0);
  assert.ok(searchGraph(seed, { tag: '新生' }).every(n => n.tags.includes('新生')));
  const graph = structuredClone(seed); graph.nodes[1].updatedAt = '2026-09-09T08:00:00.001Z';
  assert.equal(searchGraph(graph)[0].id, 'courses');
});
test('graph traversal terminates across cycles and returns accurate statistics', () => {
  assert.equal(neighborhood(seed, 'arrival', 0).nodes.length, 1);
  assert.equal(neighborhood(seed, 'arrival', 1).nodes.length, 7);
  assert.equal(neighborhood(seed, 'arrival', 2).nodes.length, 8);
  assert.equal(graphStats(seed).hubs[0].id, 'arrival');
  assert.throws(() => neighborhood(seed, 'arrival', 6), GraphError);
});
test('draft diff retains stable IDs and collapses repeated edits', () => {
  let draft = applyChange(seed, proposal(seed, 'new'));
  draft = applyChange(draft, makeChange(draft, [{ op: 'putNode', value: { ...node('new'), title: '修改后的标题' } }]));
  const change = diffGraphs(seed, draft);
  assert.equal(change.operations.length, 1); assert.equal(change.baseRevision, 0);
  assert.equal(applyChange(seed, change).nodes.at(-1).title, '修改后的标题');
  draft.title = '偷偷修改社区名'; assert.throws(() => diffGraphs(seed, draft), /元数据/);
});
test('equivalent JSON key ordering does not manufacture changes', () => {
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  assert.equal(diffGraphs(seed, reorder(seed)).operations.length, 0);
});
test('non-JSON extensions and cycles fail validation before serialization', () => {
  for (const extra of [() => 1, 1n, new Date(), NaN, Infinity, undefined]) {
    const graph = structuredClone(seed); graph.nodes[0].extra = extra;
    assert.throws(() => validateGraph(graph), GraphError);
  }
  const graph = structuredClone(seed); graph.nodes[0].extra = graph;
  assert.throws(() => validateGraph(graph), /循环/);
  const change = proposal(seed, 'non-json'); change.operations[0].value.extra = () => 1;
  assert.throws(() => applyChange(seed, change), GraphError);
  const withArray = structuredClone(seed); withArray.nodes[0].tags.extra = 'silently lost in JSON';
  assert.throws(() => validateGraph(withArray), GraphError);
  const withGetter = structuredClone(seed);
  Object.defineProperty(withGetter.nodes[0].tags, '0', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => validateGraph(withGetter), GraphError);
});

test('optional graph description agrees with the public string type', () => {
  for (const description of [{ unexpected: true }, 42, null, 'x'.repeat(20001)]) {
    assert.throws(() => validateGraph({ ...seed, description }), GraphError);
  }
  assert.equal(validateGraph({ ...seed, description: '' }).description, '');
});
test('static adapter persists reloadable proposals, detects other tabs and protects reset', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => structuredClone(seed) }));
  const storage = memory(), a = new StaticAdapter('http://local/data/graph.json', storage), b = new StaticAdapter('http://local/data/graph.json', storage);
  await a.load(); await b.load(); await a.commit(proposal(a.graph, 'tab-a'));
  await assert.rejects(b.commit(proposal(b.graph, 'tab-b')), /另一标签页/);
  await assert.rejects(b.reset(), /另一标签页/);
  const reloaded = new StaticAdapter('http://local/data/graph.json', storage);
  assert.equal((await reloaded.load()).nodes.at(-1).id, 'tab-a');
});
test('stale published revision preserves raw draft and blocks accidental overwrite', async t => {
  let snapshot = seed;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => structuredClone(snapshot) }));
  const storage = memory(), a = new StaticAdapter('http://local/data/graph.json', storage);
  await a.load(); await a.commit(proposal(a.graph, 'local-change')); const backup = a.rawDraft();
  snapshot = applyChange(seed, proposal(seed, 'published-change'));
  const b = new StaticAdapter('http://local/data/graph.json', storage); await b.load();
  assert.equal(b.blocked, true); assert.equal(b.rawDraft(), backup);
  await assert.rejects(b.commit(proposal(b.graph, 'replacement')), /旧草稿/);
});
test('unavailable browser storage preserves read-only access and failed saves do not mutate memory', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => structuredClone(seed) }));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try { const a = new StaticAdapter('http://local/data/graph.json'); assert.equal((await a.load()).nodes.length, 8); await assert.rejects(a.commit(proposal(a.graph, 'cannot-save')), /本地存储/); assert.equal(a.graph.nodes.length, 8); }
  finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
  const a = new StaticAdapter('http://local/data/graph.json', { getItem: () => null, setItem() { throw new Error('quota'); } });
  await a.load(); await assert.rejects(a.commit(proposal(a.graph, 'quota-fail')), /quota/); assert.equal(a.graph.revision, 0);
});
