#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntime, loadRuntimeConfig, buildRuntime, createRuntimeApp, bootstrapAccount, importContent, lifecycleCommand } from './index.mjs';
import { RuntimeError } from './errors.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command = 'help', filename, reviewFile] = args;
  const options = { root: process.cwd(), configFile: env.RUNTIME_CONFIG ?? 'runtime.config.json' };
  if (command === 'help') { console.log('community-runtime build | start | bootstrap <private-account.json> | import <content.json> | configure-content | backup <private.json> | restore <private.json> [withdrawal-review.json] | maintain'); return; }
  if (command === 'build') {
    const loaded = await loadRuntimeConfig(options); const result = await buildRuntime(loaded);
    console.log(`Built server UI shell: ${result.output}`); return;
  }
  if (!['start', 'bootstrap', 'import', 'backup', 'restore', 'maintain', 'configure-content'].includes(command)) throw new RuntimeError('UNKNOWN_COMMAND', 'Unknown runtime command');
  const runtime = await openRuntime({ ...options, seed: command !== 'restore', allowProfileMismatch: command === 'configure-content' }), { store, business, config } = runtime;
  const lifecycle = { config: business.lifecycle, policy: business.roles, keyring: env.RUNTIME_KEYRING ? JSON.parse(env.RUNTIME_KEYRING) : undefined };
  let started = false;
  try {
    if (command === 'start') {
      if (!/^[a-fA-F0-9]{64}$/.test(env.RUNTIME_MFA_KEY ?? '')) throw new RuntimeError('MFA_KEY_REQUIRED', 'Set RUNTIME_MFA_KEY to a private random 32-byte hex key');
      const { assets } = await buildRuntime(runtime);
      const app = createRuntimeApp({ store, auth: { mfaKey: env.RUNTIME_MFA_KEY, rolePermissions: business.roles }, lifecycle, assets });
      const port = Number(env.PORT ?? 4180), host = env.HOST ?? '127.0.0.1';
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RuntimeError('INVALID_CONFIG', 'Invalid PORT');
      await new Promise((resolve, reject) => { app.once('error', reject); app.listen(port, host, resolve); });
      started = true;
      console.log(`Community runtime listening at http://${host}:${app.address().port}`);
      let timer;
      if (config.maintenanceIntervalMs && business.lifecycle) {
        timer = setInterval(() => { try { runMaintenance(store, lifecycle); } catch (error) { console.error(`Maintenance failed: ${error.code ?? 'INTERNAL_ERROR'}`); } }, config.maintenanceIntervalMs); timer.unref();
      }
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); app.close(() => store.close()); app.closeIdleConnections(); });
      return app;
    }
    if (command === 'maintain') { console.log(JSON.stringify(runMaintenance(store, lifecycle))); return; }
    if (command === 'configure-content') { console.log(JSON.stringify(store.configureContentProfile(business.content))); return; }
    if (!filename) throw new RuntimeError('FILE_REQUIRED', `${command} needs an explicit file path`);
    if (command === 'backup') { await writeFile(resolve(filename), JSON.stringify(store.backup(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log('Private backup written; keep encryption keys separately.'); return; }
    const input = JSON.parse(await readFile(resolve(filename), 'utf8'));
    if (command === 'bootstrap') console.log(JSON.stringify(bootstrapAccount(store, input, { mfaKey: env.RUNTIME_MFA_KEY })));
    if (command === 'restore') console.log(JSON.stringify(store.restore(input, reviewFile ? JSON.parse(await readFile(resolve(reviewFile), 'utf8')) : {})));
    if (command === 'import') {
      store.transact(state => { state.modules.content = importContent(state.modules.content, input); state.audit.push({ action: 'content.import', actorId: 'offline-administrator', at: Date.now() }); });
      console.log('Content imported atomically; publication pointers were not changed.');
    }
  } finally { if (!started) store.close(); }
}
function runMaintenance(store, lifecycle) {
  if (!lifecycle.config) throw new RuntimeError('MODULE_DISABLED', 'Lifecycle module is disabled');
  const principal = { id: 'system:maintenance', sessionId: null, mfa: true, roles: ['runtime_maintenance'] };
  return store.transact(state => lifecycleCommand(state, principal, { action: 'retain' }, { ...lifecycle, policy: { runtime_maintenance: ['operations:manage'] } }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(`${error.code ?? 'RUNTIME_ERROR'}: ${error.message}`); process.exitCode = 1; }
}
