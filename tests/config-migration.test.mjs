import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadCommunity } from '../scripts/community-config.mjs';
import { buildSite } from '../scripts/build.mjs';
import { SqliteStore } from '../server/store.mjs';
import { createApp } from '../server/http.mjs';
import { makeChange } from '../packages/core/index.js';
const run = promisify(execFile), root = resolve(import.meta.dirname, '..');
const source = JSON.parse(await readFile(`${root}/examples/decisions/graph.json`));
const config = JSON.parse(await readFile(`${root}/community.config.json`));

test('custom config drives static output, server bootstrap and runtime display consistently', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'community-config-'));
  let store, server;
  try {
    await mkdir(`${temporary}/content`);
    const graph = { ...source, revision: 7 };
    await writeFile(`${temporary}/content/graph.json`, JSON.stringify(graph));
    const settings = { ...config, site: { ...config.site, brand: '决策共知' } };
    const file = `${temporary}/community.config.json`; await writeFile(file, JSON.stringify(settings));
    const loaded = await loadCommunity({ root: temporary, env: {} }); assert.equal(loaded.graph.id, source.id);
    await buildSite({ root: temporary, env: {}, output: `${temporary}/dist` });
    assert.deepEqual(JSON.parse(await readFile(`${temporary}/dist/data/graph.json`)), graph);
    assert.equal(JSON.parse(await readFile(`${temporary}/dist/runtime-config.json`)).site.brand, '决策共知');
    const environment = { ...process.env, COMMUNITY_CONFIG: file, GRAPH_FILE: '', DATA_DIR: `${temporary}/data` };
    await run(process.execPath, [`${root}/scripts/init-server.mjs`], { env: environment });
    await assert.rejects(run(process.execPath, [`${root}/scripts/init-server.mjs`], { env: environment }), /数据库已存在/);
    store = new SqliteStore(`${temporary}/data/community.sqlite`, graph); assert.deepEqual(store.load(), graph);
    const next = store.commit(makeChange(graph, [{ op: 'putNode', value: { ...graph.nodes[0], id: 'after-migration' } }]));
    server = createApp({ root: `${temporary}/dist`, store, site: loaded.site }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(url + '/api/graph')).json(), next);
    assert.deepEqual(await (await fetch(url + '/data/graph.json')).json(), next);
    assert.equal((await (await fetch(url + '/runtime-config.json')).json()).site.brand, '决策共知');
    await run(process.execPath, [`${root}/scripts/snapshot.mjs`, `${temporary}/data/community.sqlite`, `${temporary}/exported.json`]);
    await buildSite({ root: temporary, env: { GRAPH_FILE: `${temporary}/exported.json` }, output: `${temporary}/mirror` });
    assert.deepEqual(JSON.parse(await readFile(`${temporary}/mirror/data/graph.json`)), next);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); store?.close(); await rm(temporary, { recursive: true, force: true }); }
});
test('GRAPH_FILE explicitly overrides configuration, invalid config paths fail closed', async () => {
  assert.equal((await loadCommunity({ env: { GRAPH_FILE: 'examples/decisions/graph.json' } })).graph.id, source.id);
  const temporary = await mkdtemp(join(tmpdir(), 'community-config-invalid-'));
  try { await writeFile(`${temporary}/community.config.json`, JSON.stringify({ ...config, graphFile: '../outside.json' })); await assert.rejects(loadCommunity({ root: temporary, env: {} }), /所在目录内/); }
  finally { await rm(temporary, { recursive: true, force: true }); }
});
