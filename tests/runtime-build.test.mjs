import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, unlink, symlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { buildRuntime } from '../packages/runtime/build.mjs';

const config = { schemaVersion: 1, communityId: 'consumer', mode: 'server', site: { brand: 'Consumer <Guide>' } };
const digest = body => createHash('sha256').update(body).digest('hex');
const code = expected => error => error.code === expected;
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-'));
  try { await run(root); }
  finally {
    const path = relative(resolve(tmpdir()), resolve(root)); assert.ok(path && path !== '..' && !path.startsWith('..' + sep));
    await rm(root, { recursive: true, force: true });
  }
}

test('fresh output contains a hashed UI shell and never reads content data', () => fixture(async root => {
  await writeFile(join(root, 'content.json'), 'PRIVATE secret snapshot and invalid JSON');
  const result = await buildRuntime({ root, config: { ...config, contentFile: 'content.json' } });
  assert.equal(result.output, join(root, 'dist'));
  assert.ok(result.assets['/'].body.includes('Consumer &lt;Guide&gt;'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE secret'));
  assert.deepEqual((await readdir(result.output)).sort(), ['.runtime-ui-manifest.json', 'app.js', 'index.html', 'style.css']);
  const manifest = JSON.parse(await readFile(join(result.output, '.runtime-ui-manifest.json'), 'utf8'));
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(digest(await readFile(join(result.output, name))), hash);
  await buildRuntime({ root, config });
}));

test('old static graph without runtime ownership is rejected without changing any files', () => fixture(async root => {
  await mkdir(join(root, 'dist', 'data'), { recursive: true });
  await writeFile(join(root, 'dist', 'data', 'graph.json'), 'withdrawn-content');
  await writeFile(join(root, 'dist', 'index.html'), 'old-static-page');
  await assert.rejects(buildRuntime({ root, config }), code('UNMANAGED_BUILD_OUTPUT'));
  assert.equal(await readFile(join(root, 'dist', 'data', 'graph.json'), 'utf8'), 'withdrawn-content');
  assert.equal(await readFile(join(root, 'dist', 'index.html'), 'utf8'), 'old-static-page');
  await assert.rejects(readFile(join(root, 'dist', '.runtime-ui-manifest.json')), { code: 'ENOENT' });
}));

test('changed UI source rebuilds and removed source assets are unlinked from prior output', () => fixture(async root => {
  await mkdir(join(root, 'ui', 'nested'), { recursive: true });
  await writeFile(join(root, 'ui', 'index.html'), '<p>first UI</p>');
  await writeFile(join(root, 'ui', 'nested', 'removed.js'), 'old script');
  await writeFile(join(root, 'ui', '页面.css'), 'p { color: red }');
  const input = { root, config: { ...config, uiDirectory: 'ui' } };
  const first = await buildRuntime(input);
  assert.ok(first.assets['/extensions/%E9%A1%B5%E9%9D%A2.css']);
  await writeFile(join(root, 'ui', 'index.html'), '<p>new UI</p>');
  await unlink(join(root, 'ui', 'nested', 'removed.js'));
  const second = await buildRuntime(input);
  assert.equal(second.assets['/extensions/index.html'].body, '<p>new UI</p>');
  await assert.rejects(readFile(join(root, 'dist', 'extensions', 'nested', 'removed.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'dist', 'extensions', 'index.html'), 'utf8'), '<p>new UI</p>');
  await buildRuntime(input);
  await buildRuntime({ root, config });
  await assert.rejects(readFile(join(root, 'dist', 'extensions', 'index.html')), { code: 'ENOENT' });
  const manifest = JSON.parse(await readFile(join(root, 'dist', '.runtime-ui-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['app.js', 'index.html', 'style.css']);
}));

test('untracked output files and user-modified generated files are preserved and block rebuilding', () => fixture(async root => {
  await buildRuntime({ root, config });
  const original = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  await writeFile(join(root, 'dist', 'notes.txt'), 'User-owned file');
  await assert.rejects(buildRuntime({ root, config: { ...config, site: { brand: 'Changed' } } }), code('UNMANAGED_BUILD_OUTPUT'));
  assert.equal(await readFile(join(root, 'dist', 'notes.txt'), 'utf8'), 'User-owned file');
  assert.equal(await readFile(join(root, 'dist', 'index.html'), 'utf8'), original);
  await unlink(join(root, 'dist', 'notes.txt'));
  await writeFile(join(root, 'dist', 'index.html'), 'User edited generated page');
  await assert.rejects(buildRuntime({ root, config }), code('MODIFIED_BUILD_OUTPUT'));
  assert.equal(await readFile(join(root, 'dist', 'index.html'), 'utf8'), 'User edited generated page');
}));

test('old static files inserted into managed output cannot survive a successful build', () => fixture(async root => {
  await buildRuntime({ root, config });
  await mkdir(join(root, 'dist', 'data'));
  await writeFile(join(root, 'dist', 'data', 'graph.json'), 'stale graph');
  await assert.rejects(buildRuntime({ root, config }), code('UNMANAGED_BUILD_OUTPUT'));
  assert.equal(await readFile(join(root, 'dist', 'data', 'graph.json'), 'utf8'), 'stale graph');
}));

test('unsafe output, overlapping source/output, and invalid UI fail before generating a shell', () => fixture(async root => {
  for (const input of [
    { root, config, output: root },
    { root, config, output: resolve(root, '..', 'outside') },
    { root, config: { ...config, uiDirectory: 'dist' } },
    { root, config: { ...config, uiDirectory: 'dist/ui' } },
    { root, config: { ...config, uiDirectory: 'ui' }, output: 'ui/dist' },
  ]) await assert.rejects(buildRuntime(input), code('INVALID_CONFIG'));
  await assert.rejects(readFile(join(root, 'dist', 'index.html')), { code: 'ENOENT' });
  await mkdir(join(root, 'ui')); await writeFile(join(root, 'ui', 'private.json'), '{"secret":"do not copy"}');
  await assert.rejects(buildRuntime({ root, config: { ...config, uiDirectory: 'ui' } }), code('INVALID_UI'));
  await assert.rejects(readFile(join(root, 'dist', 'index.html')), { code: 'ENOENT' });
}));

test('manifest traversal and forged graph ownership cannot authorize deletion', () => fixture(async root => {
  await buildRuntime({ root, config });
  const filename = join(root, 'dist', '.runtime-ui-manifest.json');
  for (const name of ['../private.js', 'data/graph.json', 'extensions/../private.js']) {
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, files: { [name]: '0'.repeat(64) } }));
    await assert.rejects(buildRuntime({ root, config }), code('UNMANAGED_BUILD_OUTPUT'));
  }
}));

test('symbolic output and UI source directories are rejected', () => fixture(async root => {
  await mkdir(join(root, 'real-ui')); await writeFile(join(root, 'real-ui', 'index.html'), 'source');
  await symlink(join(root, 'real-ui'), join(root, 'linked-ui'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildRuntime({ root, config: { ...config, uiDirectory: 'linked-ui' } }), code('UNSAFE_BUILD_PATH'));
  await symlink(join(root, 'real-ui'), join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildRuntime({ root, config }), code('UNSAFE_BUILD_PATH'));
  assert.equal(await readFile(join(root, 'real-ui', 'index.html'), 'utf8'), 'source');
}));
