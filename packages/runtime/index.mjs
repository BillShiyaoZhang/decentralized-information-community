import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuntimeStore } from './store.mjs';
import { loadRuntimeConfig, inside } from './config.mjs';
import { contentModule, importContent } from './content.mjs';
import { authModule } from './auth.mjs';
import { lifecycleModule } from './lifecycle.mjs';
import { participantsModule } from './participants.mjs';
import { reportsModule } from './reports.mjs';
import { RuntimeError, canonicalJson } from './errors.mjs';
export { RuntimeStore, RUNTIME_CONTRACT_VERSION } from './store.mjs';
export { RuntimeError } from './errors.mjs';
export { loadRuntimeConfig } from './config.mjs';
export { buildRuntime } from './build.mjs';
export { createRuntimeApp } from './http.mjs';
export * from './auth.mjs';
export * from './content.mjs';
export * from './lifecycle.mjs';
export * from './participants.mjs';
export * from './reports.mjs';

/** Open a consumer-owned database. Installed package paths never determine user data paths. */
export async function openRuntime(options = {}) {
  const loaded = await loadRuntimeConfig(options), { config, business } = loaded;
  const modules = [{ ...contentModule, initialState: () => contentModule.initialState({ profile: business.content }) }, authModule];
  if (business.lifecycle) modules.push(lifecycleModule);
  if (business.participants) modules.push(participantsModule);
  if (business.anonymousReports) modules.push(reportsModule);
  for (const path of config.extensions ?? []) {
    const extension = await import(pathToFileURL(inside(loaded.root, path, 'extension')).href);
    modules.push(extension.default);
  }
  let identityProvider;
  if (config.identityProvider) {
    identityProvider = (await import(pathToFileURL(inside(loaded.root, config.identityProvider, 'identityProvider')).href)).default;
    if (!identityProvider || ['authenticate', 'revokeSession', 'revokeSubject', 'prepareRestore'].some(method => typeof identityProvider[method] !== 'function')) throw new RuntimeError('INVALID_IDENTITY_PROVIDER', 'Identity providers must implement synchronous authentication, session revocation, subject revocation and restore hooks');
  }
  await mkdir(loaded.dataDirectory, { recursive: true });
  const store = new RuntimeStore(join(loaded.dataDirectory, 'community.sqlite'), { communityId: config.communityId, modules });
  try {
    if (!options.allowProfileMismatch && canonicalJson(store.read().modules.content.profile) !== canonicalJson(business.content)) throw new RuntimeError('CONFIGURATION_CHANGED', 'Content policy changed; run community-runtime configure-content to validate and apply it explicitly');
    if (options.seed !== false && loaded.contentFile && store.read().revision === 0) {
      const bundle = JSON.parse(await readFile(loaded.contentFile, 'utf8'));
      store.transact(state => { state.modules.content = importContent(state.modules.content, bundle); });
    }
    return { ...loaded, store, identityProvider };
  } catch (error) { store.close(); throw error; }
}
