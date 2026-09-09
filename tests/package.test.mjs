import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const run = promisify(execFile), root = resolve(import.meta.dirname, '..');

test('packed core installs independently and exposes strict NodeNext/Bundler types', { timeout: 60000 }, async () => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run the complete suite through npm test');
  const temporary = await mkdtemp(join(tmpdir(), 'community-package-'));
  try {
    const cache = join(temporary, 'npm-cache');
    const { stdout } = await run(process.execPath, [npm, 'pack', './packages/core', '--json', '--ignore-scripts', '--cache', cache, '--pack-destination', temporary], { cwd: root });
    const [packed] = JSON.parse(stdout);
    assert.deepEqual(packed.files.map(f => f.path).sort(), ['LICENSE', 'README.md', 'index.d.ts', 'index.js', 'package.json']);
    const consumer = join(temporary, 'consumer'); await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'external-consumer', version: '1.0.0', type: 'module', private: true }));
    await run(process.execPath, [npm, 'install', join(temporary, packed.filename), '--cache', cache, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: consumer });
    assert.equal((await lstat(join(consumer, 'node_modules/@information-community/core'))).isSymbolicLink(), false);
    const seed = JSON.parse(await readFile(join(root, 'examples/campus/graph.json'), 'utf8'));
    await writeFile(join(consumer, 'graph.json'), JSON.stringify(seed));
    await writeFile(join(consumer, 'runtime.mjs'), `
import { validateGraph, makeChange, applyChange, searchGraph, neighborhood } from '@information-community/core';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const graph = validateGraph(JSON.parse(await readFile(new URL('./graph.json', import.meta.url))));
assert.equal(searchGraph(graph, {query:'新生入学'})[0].id, 'arrival');
assert.ok(neighborhood(graph, 'arrival').nodes.length > 1);
const value = {...graph.nodes[0], id:'external', properties:{verified:true}};
const change = makeChange(graph, [{op:'putNode', value}], 'external-change');
const next = applyChange(graph, change);
assert.equal(next.nodes.at(-1).properties.verified, true);
assert.equal(graph.nodes.length, 8);
assert.throws(()=>applyChange(next,change), error=>error.code==='CONFLICT');
console.log('independent consumer passed');
`);
    const runtime = await run(process.execPath, ['runtime.mjs'], { cwd: consumer }); assert.match(runtime.stdout, /independent consumer passed/);
    await writeFile(join(consumer, 'consumer.ts'), `
import { validateGraph, makeChange, applyChange, searchGraph, neighborhood, type Graph, type GraphNode, type ChangeOperation } from '@information-community/core';
interface CampusNode extends GraphNode { slug: string }
declare const incoming: unknown;
const graph: Graph = validateGraph(incoming);
const change = makeChange(graph, [{op:'putNode', value:graph.nodes[0]}], 'typed-change');
const next: Graph = applyChange(graph, change);
declare const campus: Graph<CampusNode>;
const slug: string = searchGraph(campus)[0].slug;
const neighborSlug: string = neighborhood(campus, 'node-id').nodes[0].slug;
// @ts-expect-error Unknown operations must be rejected by the public declaration.
const invalid: ChangeOperation = {op:'removeNode', value:graph.nodes[0]};
void [next, slug, neighborSlug, invalid];
`);
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    for (const [module, moduleResolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
      await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module, moduleResolution }, files: ['consumer.ts'] }));
      await run(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json')], { cwd: consumer });
    }
  } finally { assert.ok(resolve(temporary).startsWith(resolve(tmpdir()))); await rm(temporary, { recursive: true, force: true }); }
});
