import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RuntimeError, canonicalJson } from './errors.mjs';
import { lifecycleCommand, lifecycleRecordSummary, encryptPrivatePayload, decryptPrivatePayload } from './lifecycle.mjs';

const fail = (code, message, status = 400) => { throw new RuntimeError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$/.test(value);
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const hash = value => createHash('sha256').update(value).digest('hex');
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const dataOf = state => {
  if (!state.modules?.reports) fail('MODULE_DISABLED', 'Anonymous reporting is disabled', 404);
  return state.modules.reports;
};

/** This is one configured safety intake, not an anonymous lifecycle principal. */
export function validateAnonymousReportConfig(config, lifecycleConfig) {
  if (config === undefined || config === null || config === false) fail('MODULE_DISABLED', 'Anonymous reporting is disabled', 404);
  if (!exact(config, ['type', 'fields', 'rateLimit', 'receiptTtlMs']) || !identifier(config.type) ||
    !object(config.fields) || Object.keys(config.fields).length < 1 || Object.keys(config.fields).length > 20 ||
    !exact(config.rateLimit, ['max', 'windowMs']) || !integer(config.rateLimit.max) || config.rateLimit.max < 1 || config.rateLimit.max > 10000 ||
    !integer(config.rateLimit.windowMs) || config.rateLimit.windowMs < 1000 || config.rateLimit.windowMs > 86400000 ||
    !integer(config.receiptTtlMs) || config.receiptTtlMs < 1000 || config.receiptTtlMs > 90 * 86400000) fail('INVALID_ANONYMOUS_CONFIG', 'Configure a bounded anonymous report DTO, rate limit and receipt lifetime');
  for (const [field, rule] of Object.entries(config.fields)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(field) || ['constructor', 'prototype', '__proto__'].includes(field) ||
      !exact(rule, ['required', 'maxLength']) || !integer(rule.maxLength) || rule.maxLength < 1 || rule.maxLength > 10000 ||
      (rule.required !== undefined && typeof rule.required !== 'boolean')) fail('INVALID_ANONYMOUS_CONFIG', 'Anonymous DTO fields must be bounded strings');
  }
  const workflow = lifecycleConfig?.workflows?.[config.type];
  if (!object(workflow) || workflow.requireConsent !== false || !Array.isArray(workflow.eligibilityFields ?? []) || (workflow.eligibilityFields ?? []).length ||
    !integer(workflow.retentionMs) || workflow.retentionMs < 1) fail('INVALID_ANONYMOUS_CONFIG', 'Anonymous reports need a configured workflow without participation consent or eligibility');
  return config;
}

function validateReports(data) {
  if (!exact(data, ['receipts', 'replays', 'rate']) || !object(data.receipts) || !object(data.replays) || !exact(data.rate, ['startedAt', 'count']) ||
    !(data.rate.startedAt === null || integer(data.rate.startedAt)) || !integer(data.rate.count) || (data.rate.startedAt === null && data.rate.count !== 0)) fail('INVALID_REPORTS', 'Invalid anonymous report state');
  for (const [tokenHash, receipt] of Object.entries(data.receipts)) {
    if (!hashValue(tokenHash) || !exact(receipt, ['recordId', 'subjectId', 'issuedAt', 'expiresAt']) || !identifier(receipt.recordId) ||
      !identifier(receipt.subjectId) || !integer(receipt.issuedAt) || !integer(receipt.expiresAt) || receipt.expiresAt <= receipt.issuedAt) fail('INVALID_REPORTS', 'Invalid anonymous receipt');
  }
  for (const [keyHash, replay] of Object.entries(data.replays)) {
    const receipt = data.receipts[replay?.tokenHash], envelope = replay?.envelope;
    if (!hashValue(keyHash) || !exact(replay, ['fingerprint', 'tokenHash', 'envelope', 'expiresAt']) || !hashValue(replay.fingerprint) || !receipt || replay.expiresAt !== receipt.expiresAt ||
      !exact(envelope, ['version', 'keyVersion', 'contextId', 'aad', 'iv', 'ciphertext', 'tag']) || envelope.version !== 1 || !identifier(envelope.keyVersion) ||
      envelope.contextId !== `receipt:${receipt.recordId}` || envelope.aad !== `information-community:lifecycle:v1:receipt:${receipt.recordId}` ||
      !['iv', 'tag', 'ciphertext'].every(key => typeof envelope[key] === 'string' && /^[A-Za-z0-9_-]+$/.test(envelope[key])) ||
      Buffer.from(envelope.iv, 'base64url').length !== 12 || Buffer.from(envelope.tag, 'base64url').length !== 16) fail('INVALID_REPORTS', 'Invalid encrypted anonymous retry receipt');
  }
  return data;
}

export const reportsModule = {
  name: 'reports', schemaVersion: 1,
  initialState: () => ({ receipts: {}, replays: {}, rate: { startedAt: null, count: 0 } }),
  validate: validateReports,
  validateState(state) {
    for (const receipt of Object.values(state.modules.reports.receipts)) {
      const record = state.modules.lifecycle?.records?.[receipt.recordId];
      if (!record || (record.purgedAt === null && record.subjectId !== receipt.subjectId)) fail('INVALID_REPORTS', 'Anonymous receipt must reference its own retained report');
    }
  },
  prepareRestore(state) {
    // Old capabilities and retry keys cannot regain access after an offline restore.
    state.modules.reports.receipts = {};
    state.modules.reports.replays = {};
    state.modules.reports.rate = { startedAt: null, count: 0 };
  },
};

function clean(data, state, now) {
  for (const [tokenHash, receipt] of Object.entries(data.receipts)) {
    const record = state.modules.lifecycle?.records?.[receipt.recordId];
    if (receipt.expiresAt <= now || !record || record.purgedAt !== null || record.expiresAt <= now) delete data.receipts[tokenHash];
  }
  for (const [keyHash, replay] of Object.entries(data.replays)) if (!data.receipts[replay.tokenHash]) delete data.replays[keyHash];
}

/** A supplied retry key is also a secret capability: browsers should generate 32 random bytes. */
export function submitAnonymousReport(store, input, options = {}) {
  const config = validateAnonymousReportConfig(options.config, options.lifecycle?.config), now = options.now ?? Date.now();
  if (!integer(now)) fail('INVALID_REQUEST', 'Invalid report time');
  if (!object(input) || Object.keys(input).some(field => !Object.hasOwn(config.fields, field))) fail('INVALID_ANONYMOUS_DTO', 'Only configured report fields are accepted');
  for (const [field, rule] of Object.entries(config.fields)) {
    if (!Object.hasOwn(input, field)) { if (rule.required) fail('INVALID_ANONYMOUS_DTO', 'A required report field is missing'); continue; }
    if (typeof input[field] !== 'string' || input[field].length > rule.maxLength || (rule.required && !input[field].trim())) fail('INVALID_ANONYMOUS_DTO', 'Report fields must be bounded strings');
  }
  if (options.key !== undefined && options.key !== null && !secret(options.key)) fail('INVALID_IDEMPOTENCY_KEY', 'Anonymous retries require a secret key containing 32 random bytes in base64url form');
  const fingerprint = hash(canonicalJson(input)), keyHash = options.key ? hash(options.key) : null;
  return store.transact(state => {
    const data = dataOf(state);
    clean(data, state, now);
    const previous = keyHash ? data.replays[keyHash] : null;
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'The retry key already belongs to different report data', 409);
      const receipt = data.receipts[previous.tokenHash];
      const decrypted = decryptPrivatePayload(`receipt:${receipt.recordId}`, previous.envelope, options.lifecycle?.keyring);
      if (!secret(decrypted.receipt) || hash(decrypted.receipt) !== previous.tokenHash) fail('INVALID_REPORTS', 'Anonymous retry receipt cannot be authenticated', 500);
      return { receipt: decrypted.receipt, expiresAt: receipt.expiresAt };
    }
    if (data.rate.startedAt === null || data.rate.startedAt + config.rateLimit.windowMs <= now) data.rate = { startedAt: now, count: 0 };
    if (data.rate.count >= config.rateLimit.max) fail('RATE_LIMITED', 'Anonymous reporting rate limit reached', 429);
    data.rate.count += 1;
    const id = randomUUID(), subjectId = `anonymous-report:${randomUUID()}`;
    const record = lifecycleCommand(state, { id: subjectId }, { action: 'create', id, type: config.type, payload: input }, { ...options.lifecycle, now });
    const expiresAt = Math.min(now + config.receiptTtlMs, record.expiresAt);
    if (!integer(expiresAt) || expiresAt <= now) fail('INVALID_ANONYMOUS_CONFIG', 'Receipt expiry exceeds supported timestamps');
    const receipt = randomBytes(32).toString('base64url'), tokenHash = hash(receipt);
    data.receipts[tokenHash] = { recordId: id, subjectId, issuedAt: now, expiresAt };
    if (keyHash) data.replays[keyHash] = { fingerprint, tokenHash, envelope: encryptPrivatePayload(`receipt:${id}`, { receipt }, options.lifecycle?.keyring), expiresAt };
    return { receipt, expiresAt };
  });
}

/** Receipt possession grants only a status projection for one report. */
export function readAnonymousReport(state, token, options = {}) {
  const config = validateAnonymousReportConfig(options.config, options.lifecycleConfig), now = options.now ?? Date.now();
  const data = dataOf(state), receipt = secret(token) ? data.receipts[hash(token)] : null;
  if (!receipt || !integer(now) || receipt.expiresAt <= now) fail('NOT_FOUND', 'Report receipt is unavailable', 404);
  const record = state.modules.lifecycle?.records?.[receipt.recordId];
  if (!record || record.subjectId !== receipt.subjectId || record.type !== config.type) fail('NOT_FOUND', 'Report receipt is unavailable', 404);
  const summary = lifecycleRecordSummary(state, receipt.recordId, { config: options.lifecycleConfig, now });
  if (!summary) fail('NOT_FOUND', 'Report receipt is unavailable', 404);
  return { status: summary.status, createdAt: summary.createdAt, updatedAt: summary.updatedAt, expiresAt: Math.min(summary.expiresAt, receipt.expiresAt), result: summary.result };
}
