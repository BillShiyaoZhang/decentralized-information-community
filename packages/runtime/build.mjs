import { readFile, mkdir, writeFile, readdir, lstat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, sep, dirname, extname, isAbsolute } from 'node:path';
import { RuntimeError } from './errors.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const manifestName = '.runtime-ui-manifest.json';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new RuntimeError(code, message); };
const within = (parent, child) => { const path = relative(parent, child); return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
async function stat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

/** Existing ancestors must be ordinary directories, including the configured root. */
async function directoryPath(root, directory) {
  const paths = [root]; let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) { current = resolve(current, part); paths.push(current); }
  for (const path of paths) {
    const info = await stat(path);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) fail('UNSAFE_BUILD_PATH', 'Build paths must use ordinary directories without symbolic links');
  }
}
function generatedPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return ['index.html', 'app.js', 'style.css'].includes(name) || (name.startsWith('extensions/') && Object.hasOwn(types, extname(name)));
}
function outputFile(output, name) {
  const path = resolve(output, name);
  if (!within(output, path)) fail('UNSAFE_BUILD_PATH', 'Generated file must stay inside the output directory');
  return path;
}

async function inspectOutput(output) {
  const existing = new Map();
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, path = outputFile(output, name), info = await lstat(path);
      if (info.isSymbolicLink()) fail('UNSAFE_BUILD_PATH', 'Output cannot contain symbolic links');
      if (info.isDirectory()) await walk(path, name + '/');
      else if (info.isFile()) existing.set(name, path);
      else fail('UNSAFE_BUILD_PATH', 'Output can contain only ordinary generated files and directories');
    }
  }
  if (!(await stat(output))) return { files: {} };
  await walk(output);
  if (!existing.size) return { files: {} };
  if (!existing.has(manifestName)) fail('UNMANAGED_BUILD_OUTPUT', 'Nonempty output has no runtime manifest; use a new empty output directory');
  let manifest;
  try { manifest = JSON.parse(await readFile(existing.get(manifestName), 'utf8')); } catch { fail('UNMANAGED_BUILD_OUTPUT', 'Runtime output manifest is invalid'); }
  if (!manifest || Array.isArray(manifest) || manifest.schemaVersion !== 1 || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object' || Object.keys(manifest).some(key => !['schemaVersion', 'files'].includes(key))) fail('UNMANAGED_BUILD_OUTPUT', 'Runtime output manifest is invalid');
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!generatedPath(name) || !/^[a-f0-9]{64}$/.test(digest)) fail('UNMANAGED_BUILD_OUTPUT', 'Runtime manifest contains an unsupported file');
    if (!existing.has(name) || hash(await readFile(existing.get(name))) !== digest) fail('MODIFIED_BUILD_OUTPUT', `Generated output ${name} was changed or removed; preserve it before rebuilding`);
  }
  for (const name of existing.keys()) if (name !== manifestName && !Object.hasOwn(manifest.files, name)) fail('UNMANAGED_BUILD_OUTPUT', `Output contains untracked file ${name}; use a separate output directory`);
  return manifest;
}

/** Builds only a server UI shell. Validate all source and prior output before changing any file. */
export async function buildRuntime({ root = process.cwd(), config, output } = {}) {
  root = resolve(root); output = resolve(root, output ?? 'dist');
  if (!within(root, output)) fail('INVALID_CONFIG', 'Output must be a child directory of the consumer project');
  if (config?.mode !== undefined && config.mode !== 'server') fail('SERVER_ONLY', 'Governed runtime builds a server UI shell only');
  await directoryPath(root, output);
  const files = new Map(), assets = {};
  for (const name of ['index.html', 'app.js', 'style.css']) {
    let text = await readFile(new URL(`./ui/${name}`, import.meta.url), 'utf8');
    if (name === 'index.html') text = text.replaceAll('{{brand}}', escape(config.site?.brand ?? config.communityId)).replace('{{extensions}}', config.uiDirectory ? '<a href="/extensions/index.html">社区扩展页面</a>' : '');
    files.set(name, text);
    const asset = { body: text, type: types[extname(name)] };
    assets[`/${name}`] = asset;
    if (name === 'index.html') assets['/'] = asset;
  }
  if (config.uiDirectory) {
    if (typeof config.uiDirectory !== 'string' || isAbsolute(config.uiDirectory)) fail('INVALID_CONFIG', 'uiDirectory must be a relative directory in the consumer project');
    const source = resolve(root, config.uiDirectory);
    if (!within(root, source)) fail('INVALID_CONFIG', 'uiDirectory must be inside the consumer project');
    if (source === output || within(source, output) || within(output, source)) fail('INVALID_CONFIG', 'UI source and output directories must not overlap');
    await directoryPath(root, source);
    async function collect(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name, path = resolve(directory, entry.name), info = await lstat(path);
        if (info.isSymbolicLink()) fail('INVALID_UI', 'UI extensions cannot contain symbolic links');
        if (info.isDirectory()) { await collect(path, name + '/'); continue; }
        if (!info.isFile() || !generatedPath(`extensions/${name}`)) fail('INVALID_UI', 'UI extensions may contain only HTML, JS, CSS and SVG assets');
        const body = await readFile(path, 'utf8');
        files.set(`extensions/${name}`, body);
        assets['/extensions/' + name.split('/').map(encodeURIComponent).join('/')] = { body, type: types[extname(name)] };
      }
    }
    await collect(source);
  }
  const previous = await inspectOutput(output);
  const manifest = { schemaVersion: 1, files: Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)).map(([name, body]) => [name, hash(body)])) };
  // Delete only exact stale files owned by the previous manifest, never trees.
  await mkdir(output, { recursive: true });
  for (const name of Object.keys(previous.files)) if (!files.has(name)) await unlink(outputFile(output, name));
  for (const [name, body] of files) {
    const destination = outputFile(output, name);
    await directoryPath(root, dirname(destination));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
  }
  await writeFile(outputFile(output, manifestName), JSON.stringify(manifest, null, 2) + '\n');
  return { output, assets };
}
