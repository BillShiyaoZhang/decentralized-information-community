import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { RuntimeError } from './errors.mjs';
import { validateParticipantConfig } from './participants.mjs';
import { validateAnonymousReportConfig } from './reports.mjs';

export function inside(root, path, name) {
  if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) throw new RuntimeError('INVALID_CONFIG', `${name} must be a relative path`);
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith('..' + sep)) throw new RuntimeError('INVALID_CONFIG', `${name} must stay inside the consumer directory`);
  return absolute;
}
export async function loadRuntimeConfig({ root = process.cwd(), configFile = 'runtime.config.json' } = {}) {
  const path = resolve(root, configFile), base = dirname(path);
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(config.communityId ?? '')) throw new RuntimeError('INVALID_CONFIG', 'Expected runtime config v1 and a stable communityId');
  if (config.mode !== undefined && config.mode !== 'server') throw new RuntimeError('SERVER_ONLY', 'Governed runtime supports server mode only');
  if (config.site && (typeof config.site.brand !== 'string' || !config.site.brand.trim() || config.site.brand.length > 200)) throw new RuntimeError('INVALID_CONFIG', 'site.brand must be 1–200 characters');
  const businessPath = inside(base, config.businessFile, 'businessFile');
  const business = JSON.parse(await readFile(businessPath, 'utf8'));
  if (business.contentProfileFile) business.content = JSON.parse(await readFile(inside(dirname(businessPath), business.contentProfileFile, 'contentProfileFile'), 'utf8'));
  if (business.lifecycleFile) business.lifecycle = JSON.parse(await readFile(inside(dirname(businessPath), business.lifecycleFile, 'lifecycleFile'), 'utf8'));
  if (business.schemaVersion !== 1 || !business.content || !business.roles || Array.isArray(business.roles)) throw new RuntimeError('INVALID_CONFIG', 'Expected business config v1 with content and roles');
  for (const [role, permissions] of Object.entries(business.roles)) if (!/^[a-zA-Z0-9_:-]+$/.test(role) || !Array.isArray(permissions) || permissions.some(value => typeof value !== 'string')) throw new RuntimeError('INVALID_CONFIG', 'Roles map to arrays of permission names');
  if (business.participants !== undefined) {
    const participantPolicy = validateParticipantConfig(business.participants);
    if (!business.lifecycle || !business.roles[participantPolicy.role]?.includes('lifecycle:self') || participantPolicy.selfService.types.some(type => !Object.hasOwn(business.lifecycle.workflows ?? {}, type))) throw new RuntimeError('INVALID_CONFIG', 'Participant self-service requires configured lifecycle workflows and a lifecycle:self role');
  }
  if (business.anonymousReports !== undefined) validateAnonymousReportConfig(business.anonymousReports, business.lifecycle);
  if (config.identityProvider !== undefined) inside(base, config.identityProvider, 'identityProvider');
  if (config.extensions !== undefined && (!Array.isArray(config.extensions) || config.extensions.some(value => typeof value !== 'string'))) throw new RuntimeError('INVALID_CONFIG', 'extensions must list trusted local module entry paths');
  if (config.maintenanceIntervalMs !== undefined && (!Number.isSafeInteger(config.maintenanceIntervalMs) || config.maintenanceIntervalMs < 1000)) throw new RuntimeError('INVALID_CONFIG', 'maintenanceIntervalMs must be at least 1000');
  return { root: base, config, business, dataDirectory: inside(base, config.dataDirectory ?? '.runtime', 'dataDirectory'), contentFile: config.contentFile ? inside(base, config.contentFile, 'contentFile') : null };
}
