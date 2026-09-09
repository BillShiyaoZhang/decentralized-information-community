import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteStore } from '../server/store.mjs';
import { createApp } from '../server/http.mjs';
import { makeChange } from '../packages/core/index.js';
const root = resolve(import.meta.dirname, '..');
const seed = JSON.parse(await readFile(`${root}/examples/campus/graph.json`));
const change = () => makeChange(seed, [{ op: 'putNode', value: { ...seed.nodes[0], id: 'server-created', title: '服务器新话题' } }]);

test('SQLite persists accepted proposals, rejects conflicts and retains immutable history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'community-store-')); const file = join(dir, 'test.sqlite');
  let store = new SqliteStore(file, seed);
  try {
    const next = store.commit(change()); assert.equal(next.revision, 1);
    assert.throws(() => store.commit(change()), e => e.code === 'CONFLICT');
    assert.equal(store.db.prepare('SELECT count(*) as n FROM snapshots').get().n, 2);
    store.close(); store = new SqliteStore(file, seed);
    assert.equal(store.load().nodes.at(-1).id, 'server-created');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
test('HTTP API enforces auth, validates writes, survives reopen and exposes computation', async () => {
  const store = new SqliteStore(':memory:', seed); const server = createApp({ root: `${root}/web`, store, writeToken: 'test-only-secret' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (data, token = '') => fetch(base + '/api/changes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: typeof data === 'string' ? data : JSON.stringify(data) });
  try {
    assert.equal((await (await fetch(base + '/runtime-config.json')).json()).mode, 'server');
    assert.equal((await post(change())).status, 401);
    assert.equal((await post('{broken', 'test-only-secret')).status, 400);
    assert.equal((await post({ ...change(), graphId: 'wrong' }, 'test-only-secret')).status, 400);
    const saved = await post(change(), 'test-only-secret'); assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
    assert.equal((await post(change(), 'test-only-secret')).status, 409);
    assert.equal((await (await fetch(base + '/api/search?q=' + encodeURIComponent('服务器新话题'))).json())[0].id, 'server-created');
    assert.equal((await (await fetch(base + '/api/analysis')).json()).nodes, 9);
    assert.equal((await (await fetch(base + '/api/neighborhood?id=arrival&depth=1')).json()).nodes.length, 7);
    assert.equal((await fetch(base + '/api/neighborhood?id=arrival&depth=99')).status, 400);
    const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
    assert.equal((await fetch(base + '/..%5cpackage.json')).status, 403);
    assert.equal((await fetch(base + '/package.json')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
test('server without configured write token stays read-only', async () => {
  const store = new SqliteStore(':memory:', seed); const server = createApp({ root: `${root}/web`, store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/changes`, { method: 'POST', headers: { Authorization: 'Bearer ', 'Content-Type': 'application/json' }, body: JSON.stringify(change()) }); assert.equal(response.status, 401); }
  finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
test('static artifact works beneath a GitHub Pages repository subpath', async () => {
  await import('../scripts/build.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'community-pages-')); await mkdir(`${dir}/my-repository`); await cp(`${root}/dist`, `${dir}/my-repository`, { recursive: true });
  const server = createApp({ root: dir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/my-repository/`;
  try {
    for (const file of ['', 'style.css', 'app.js', 'favicon.svg', 'packages/core/index.js', 'packages/adapters/index.js']) assert.equal((await fetch(base + file)).status, 200, file);
    const config = await (await fetch(base + 'runtime-config.json')).json(); assert.equal(config.mode, 'static');
    const graph = await (await fetch(new URL(config.graphUrl, base))).json(); assert.equal(graph.nodes.length, 8);
    const html = await (await fetch(base)).text(); assert.doesNotMatch(html, /(?:src|href)="\//);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
