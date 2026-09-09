#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntime, loadRuntimeConfig, buildRuntime, createRuntimeApp, bootstrapAccount, importContent, lifecycleCommand, issueParticipantInvitation, cancelParticipantInvitation, inspectAccountsOffline, maintainAccountOffline, appendAudit } from './index.mjs';
import { RuntimeError } from './errors.mjs';

function parsePrivateJson(text) {
  try { return JSON.parse(text); }
  catch { throw new RuntimeError('INVALID_JSON', 'Private input must be valid JSON; contents are omitted from diagnostics'); }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command = 'help', filename, reviewFile] = args;
  const options = { root: process.cwd(), configFile: env.RUNTIME_CONFIG ?? 'runtime.config.json' };
  if (command === 'help') { console.log('community-runtime build | start | bootstrap <private-account.json> | accounts | account <private-change.json> | invite <reviewed-eligibility.json> | cancel-invitation <invitation.json> | import <content.json> | configure-content | backup <private.json> | restore <private.json> [withdrawal-review.json] | maintain\naccounts / account / cancel-invitation require a reviewed named operator in RUNTIME_OPERATOR_ID; account maintenance is offline and local-provider only.'); return; }
  if (command === 'build') {
    const loaded = await loadRuntimeConfig(options); const result = await buildRuntime(loaded);
    console.log(`Built server UI shell: ${result.output}`); return;
  }
  if (!['start', 'bootstrap', 'accounts', 'account', 'invite', 'cancel-invitation', 'import', 'backup', 'restore', 'maintain', 'configure-content'].includes(command)) throw new RuntimeError('UNKNOWN_COMMAND', 'Unknown runtime command');
  const offlineAccountOperation = ['accounts', 'account', 'cancel-invitation'].includes(command);
  if (offlineAccountOperation && !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,119}$/.test(env.RUNTIME_OPERATOR_ID ?? '')) throw new RuntimeError('OFFLINE_OPERATOR_REQUIRED', 'Set RUNTIME_OPERATOR_ID to the reviewed operator identity; host access is the offline authorization boundary');
  if (['accounts', 'account'].includes(command) && (await loadRuntimeConfig(options)).config.identityProvider) throw new RuntimeError('EXTERNAL_IDENTITY_PROVIDER', 'Offline local account maintenance cannot administer an external identity provider');
  const runtime = await openRuntime({ ...options, seed: command !== 'restore' && !offlineAccountOperation, allowProfileMismatch: command === 'configure-content' }), { store, business, config } = runtime;
  let started = false;
  try {
    const lifecycle = { config: business.lifecycle, participants: business.participants, provider: runtime.identityProvider, policy: business.roles, keyring: env.RUNTIME_KEYRING ? parsePrivateJson(env.RUNTIME_KEYRING) : undefined };
    if (command === 'start') {
      if (!/^[a-fA-F0-9]{64}$/.test(env.RUNTIME_MFA_KEY ?? '')) throw new RuntimeError('MFA_KEY_REQUIRED', 'Set RUNTIME_MFA_KEY to a private random 32-byte hex key');
      const { assets } = await buildRuntime(runtime);
      const app = createRuntimeApp({ store, auth: { mfaKey: env.RUNTIME_MFA_KEY, rolePermissions: business.roles, participants: business.participants, provider: runtime.identityProvider }, lifecycle, anonymousReports: business.anonymousReports, assets });
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
    if (command === 'accounts') { console.log(JSON.stringify(inspectAccountsOffline(store, { operatorId: env.RUNTIME_OPERATOR_ID }))); return; }
    if (!filename) throw new RuntimeError('FILE_REQUIRED', `${command} needs an explicit file path`);
    if (command === 'backup') { await writeFile(resolve(filename), JSON.stringify(store.backup(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log('Private backup written; keep encryption keys separately.'); return; }
    const input = parsePrivateJson(await readFile(resolve(filename), 'utf8'));
    if (command === 'bootstrap') console.log(JSON.stringify(bootstrapAccount(store, input, { mfaKey: env.RUNTIME_MFA_KEY })));
    if (command === 'account') console.log(JSON.stringify(maintainAccountOffline(store, input, { operatorId: env.RUNTIME_OPERATOR_ID, mfaKey: env.RUNTIME_MFA_KEY })));
    if (command === 'invite') console.log(JSON.stringify(store.transact(state => issueParticipantInvitation(state, input, { config: business.participants }))));
    if (command === 'cancel-invitation') console.log(JSON.stringify(store.transact(state => {
      const result = cancelParticipantInvitation(state, input);
      appendAudit(state, { id: env.RUNTIME_OPERATOR_ID }, 'participant.invitation.cancel.offline', { targetId: result.invitationId });
      return result;
    })));
    if (command === 'restore') console.log(JSON.stringify(store.restore(input, { ...(reviewFile ? parsePrivateJson(await readFile(resolve(reviewFile), 'utf8')) : {}), provider: runtime.identityProvider })));
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
