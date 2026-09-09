import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeChange } from '../packages/core/index.js';
import { SqliteStore } from '../server/store.mjs';
const run = promisify(execFile), root = resolve(import.meta.dirname, '..');
const seed = JSON.parse(await readFile(`${root}/examples/campus/graph.json`));
test('CLI proposal acceptance and SQLite export produce portable valid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'community-cli-'));
  try {
    const graphFile = join(dir, 'graph.json'), proposalFile = join(dir, 'proposal.json');
    const proposal = makeChange(seed, [{ op: 'putNode', value: { ...seed.nodes[0], id: 'cli-new' } }]);
    await writeFile(graphFile, JSON.stringify(seed)); await writeFile(proposalFile, JSON.stringify(proposal));
    await run(process.execPath, [`${root}/scripts/apply.mjs`, graphFile, proposalFile, graphFile]);
    const accepted = JSON.parse(await readFile(graphFile, 'utf8')); assert.equal(accepted.revision, 1);
    await assert.rejects(run(process.execPath, [`${root}/scripts/apply.mjs`, graphFile, proposalFile, graphFile]));
    assert.equal(JSON.parse(await readFile(graphFile, 'utf8')).revision, 1);
    const dbPath = join(dir, 'graph.sqlite'), store = new SqliteStore(dbPath, seed); store.commit(proposal); store.close();
    const output = join(dir, 'export.json'); await run(process.execPath, [`${root}/scripts/snapshot.mjs`, dbPath, output]);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), accepted);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('concurrent CLI merges cannot silently overwrite each other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'community-lock-'));
  try {
    const graphFile = join(dir, 'graph.json'); await writeFile(graphFile, JSON.stringify(seed));
    const files = [];
    for (const id of ['first', 'second']) { const file = join(dir, id + '.json'); await writeFile(file, JSON.stringify(makeChange(seed, [{ op: 'putNode', value: { ...seed.nodes[0], id } }]))); files.push(file); }
    const results = await Promise.allSettled(files.map(file => run(process.execPath, [`${root}/scripts/apply.mjs`, graphFile, file, graphFile])));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(JSON.parse(await readFile(graphFile, 'utf8')).nodes.length, 9);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
