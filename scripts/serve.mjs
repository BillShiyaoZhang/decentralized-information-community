import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/http.mjs';
import { resolve } from 'node:path';
import { loadCommunity } from './community-config.mjs';
const port = Number(process.env.PORT ?? 4173), host = process.env.HOST ?? '127.0.0.1';
let building = false, pending = false;
async function build() {
  if (building) { pending = true; return; }
  building = true;
  const status = await new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url))], { stdio: 'inherit' });
    child.on('exit', resolve); child.on('error', () => resolve(1));
  });
  building = false;
  if (status) console.error('Build failed; fix the source and save again.');
  if (pending) { pending = false; await build(); }
}
// Polling also works across Windows / Docker bind mounts where inotify may miss host edits.
async function fingerprint() {
  const paths = [];
  for (const folder of ['web', 'packages', 'content', 'examples']) {
    const directory = resolve(import.meta.dirname, '..', folder);
    for (const name of await readdir(directory, { recursive: true })) paths.push(resolve(directory, name));
  }
  const { configFile, graphFile } = await loadCommunity();
  paths.push(configFile, graphFile);
  const entries = await Promise.all(paths.sort().map(async path => { const info = await stat(path); return `${path}:${info.mtimeMs}:${info.size}`; }));
  return entries.join('|');
}
await build();
let previous = await fingerprint(), checking = false;
const watcher = setInterval(async () => {
  if (checking) return;
  checking = true;
  try { const current = await fingerprint(); if (current !== previous) { previous = current; await build(); } }
  catch (error) { console.error(`Source watcher: ${error.message}`); }
  finally { checking = false; }
}, 1000);
const server = createApp({ root: resolve(import.meta.dirname, '../dist') });
server.listen(port, host, () => console.log(`Static preview: http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(watcher); server.close(); });
