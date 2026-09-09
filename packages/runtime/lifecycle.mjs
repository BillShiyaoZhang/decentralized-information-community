import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { RuntimeError } from './errors.mjs';
import { defaultRolePermissions, requirePermission } from './auth.mjs';
import { projectPublic, readPublicRevision } from './content.mjs';

const fail = (code, message, status = 400) => { throw new RuntimeError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const subjectOf = principal => principal?.subjectId ?? principal?.id;
const timestamp = options => options?.now ?? Date.now();

function json(value, depth = 0) {
  if (depth > 32) fail('INVALID_PRIVATE_DATA', 'Private data nesting exceeds 32 levels');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!object(value) && !Array.isArray(value)) fail('INVALID_PRIVATE_DATA', 'Private data must be JSON');
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) fail('INVALID_PRIVATE_DATA', 'Private data must use plain objects');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!own(descriptor, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_PRIVATE_DATA', 'Unsupported private property');
    json(descriptor.value, depth + 1);
  }
}

function keyBytes(keyring, version) {
  const supplied = keyring?.keys?.[version];
  if (!supplied) fail('KEY_UNAVAILABLE', 'Private encryption key is unavailable', 503);
  const key = Buffer.isBuffer(supplied) || supplied instanceof Uint8Array ? Buffer.from(supplied)
    : typeof supplied === 'string' ? Buffer.from(supplied, /^[0-9a-f]{64}$/i.test(supplied) ? 'hex' : 'base64') : Buffer.alloc(0);
  if (key.length !== 32) fail('INVALID_KEY', 'AES-GCM keys must contain exactly 32 bytes', 503);
  return key;
}

function validateEnvelope(envelope, id) {
  if (!object(envelope) || envelope.version !== 1 || !identifier(envelope.keyVersion) || envelope.contextId !== id ||
    Object.keys(envelope).some(key => !['version', 'keyVersion', 'contextId', 'aad', 'iv', 'ciphertext', 'tag'].includes(key)) ||
    ![`information-community:lifecycle:v1:${id}`, `research-intake:v1:${id}`].includes(envelope.aad) ||
    !['iv', 'tag', 'ciphertext'].every(key => typeof envelope[key] === 'string' && /^[A-Za-z0-9_-]+$/.test(envelope[key])) ||
    Buffer.from(envelope.iv, 'base64url').length !== 12 || Buffer.from(envelope.tag, 'base64url').length !== 16) {
    fail('INVALID_CIPHERTEXT', 'Invalid ciphertext or changed encryption context');
  }
}

export function encryptPrivatePayload(id, value, keyring) {
  if (!identifier(id) || !identifier(keyring?.activeVersion)) fail('INVALID_ENCRYPTION_CONTEXT', 'Record ID and active key version are required');
  json(value);
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > 1024 * 1024) fail('PRIVATE_DATA_TOO_LARGE', 'Private payload exceeds 1 MiB');
  const iv = randomBytes(12), aad = `information-community:lifecycle:v1:${id}`;
  const cipher = createCipheriv('aes-256-gcm', keyBytes(keyring, keyring.activeVersion), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: 1, keyVersion: keyring.activeVersion, contextId: id, aad, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

export function decryptPrivatePayload(id, envelope, keyring) {
  validateEnvelope(envelope, id);
  const key = keyBytes(keyring, envelope.keyVersion);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(envelope.aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { fail('DECRYPTION_FAILED', 'Private ciphertext authentication failed', 500); }
}

/** The guide's original AES-GCM key derivation and AAD are deliberately retained. */
export function legacyIntakeKey(secret) {
  if (typeof secret !== 'string' || secret.trim().length < 32) fail('INVALID_KEY', 'Legacy intake secret must contain at least 32 characters');
  return createHash('sha256').update(secret.trim()).digest();
}

export function importLegacyIntakeEnvelope(id, ciphertext, keyVersion) {
  const [version, iv, encoded, extra] = String(ciphertext).split('.');
  if (version !== 'v1' || !iv || !encoded || extra) fail('INVALID_CIPHERTEXT', 'Unsupported legacy ciphertext');
  const combined = Buffer.from(encoded, 'base64url');
  const envelope = { version: 1, keyVersion, contextId: id, aad: `research-intake:v1:${id}`, iv, ciphertext: combined.subarray(0, -16).toString('base64url'), tag: combined.subarray(-16).toString('base64url') };
  validateEnvelope(envelope, id);
  return envelope;
}

/** Changing an ID is only permitted with authenticated decryption and re-encryption. */
export function migratePrivateRecord(record, { id = record.id, keyring, targetKeyring = keyring, reencrypt = false } = {}) {
  if (!identifier(id)) fail('INVALID_RECORD', 'Invalid migration record ID');
  const next = clone(record);
  if (id !== record.id && !reencrypt) fail('ENCRYPTION_CONTEXT_CHANGE', 'Changing an encrypted record ID requires re-encryption');
  if (record.payload) {
    const value = decryptPrivatePayload(record.id, record.payload, keyring);
    if (reencrypt) next.payload = encryptPrivatePayload(id, value, targetKeyring);
  }
  next.id = id;
  if (id !== record.id) next.externalId = record.externalId ?? record.id;
  return next;
}

function validateLifecycle(data, previous) {
  if (!object(data) || !object(data.records) || !object(data.subjects) || !Array.isArray(data.runs)) fail('INVALID_LIFECYCLE', 'Invalid lifecycle state');
  json(data);
  for (const [id, subject] of Object.entries(data.subjects)) {
    if (!identifier(id) || subject.id !== id || !integer(subject.epoch) || !object(subject.consents) || !object(subject.eligibility) ||
      !(subject.withdrawnAt === null || integer(subject.withdrawnAt))) fail('INVALID_LIFECYCLE', 'Invalid consent subject');
    if (Object.keys(subject).some(key => !['id', 'epoch', 'consents', 'eligibility', 'withdrawnAt'].includes(key)) || !Object.values(subject.eligibility).every(value => typeof value === 'boolean')) fail('INVALID_LIFECYCLE', 'Invalid consent or eligibility fields');
    if (subject.withdrawnAt !== null && (Object.keys(subject.consents).length || Object.keys(subject.eligibility).length)) fail('INVALID_LIFECYCLE', 'Withdrawn subject retains sensitive consent data');
    for (const consent of Object.values(subject.consents)) if (!object(consent) || !identifier(consent.version) || !integer(consent.grantedAt)) fail('INVALID_LIFECYCLE', 'Invalid consent record');
  }
  for (const [id, record] of Object.entries(data.records)) {
    const recordFields = ['id', 'type', 'status', 'version', 'subjectId', 'consentEpoch', 'entityId', 'revisionId', 'externalId', 'assignee', 'decisionCode', 'publicResult', 'createdAt', 'updatedAt', 'expiresAt', 'purgedAt', 'payload'];
    if (!object(record) || Object.keys(record).some(key => !recordFields.includes(key))) fail('INVALID_LIFECYCLE', 'Private fields must be contained in the encrypted payload');
    if (!identifier(id) || record.id !== id || !identifier(record.type) || !identifier(record.status) || !integer(record.version) ||
      !integer(record.createdAt) || !integer(record.updatedAt) || !integer(record.expiresAt) || !integer(record.consentEpoch) ||
      !(record.purgedAt === null || integer(record.purgedAt)) || !(record.subjectId === null || identifier(record.subjectId)) ||
      !(record.entityId === null || identifier(record.entityId)) || !(record.revisionId === null || identifier(record.revisionId)) ||
      !(record.externalId === null || identifier(record.externalId)) || !(record.assignee === null || identifier(record.assignee)) ||
      !(record.decisionCode === null || identifier(record.decisionCode))) fail('INVALID_LIFECYCLE', 'Invalid private record');
    if (record.subjectId !== null && (!data.subjects[record.subjectId] || data.subjects[record.subjectId].withdrawnAt !== null)) fail('INVALID_LIFECYCLE', 'Private record references an inactive subject');
    if (record.purgedAt !== null) {
      if ([record.payload, record.subjectId, record.entityId, record.revisionId, record.externalId, record.assignee, record.decisionCode, record.publicResult].some(value => value !== null)) fail('INVALID_LIFECYCLE', 'Purged record retains private data or associations');
    } else validateEnvelope(record.payload, id);
    if (record.publicResult !== null && (!object(record.publicResult) || !identifier(record.publicResult.code) || typeof record.publicResult.label !== 'string' || record.publicResult.label.length > 300)) fail('INVALID_LIFECYCLE', 'Invalid public result');
  }
  for (const run of data.runs) if (!identifier(run.id) || !identifier(run.task) || !['succeeded', 'failed'].includes(run.status) || !integer(run.startedAt) || !integer(run.finishedAt) || !object(run.evidence)) fail('INVALID_LIFECYCLE', 'Invalid maintenance evidence');
  if (previous) {
    for (const [id, old] of Object.entries(previous.subjects)) if (old.withdrawnAt !== null &&
      (!data.subjects[id] || data.subjects[id].withdrawnAt !== old.withdrawnAt || data.subjects[id].epoch < old.epoch)) fail('WITHDRAWAL_IMMUTABLE', 'Withdrawal tombstones cannot be removed or reversed');
    for (const [id, old] of Object.entries(previous.records)) if (old.purgedAt !== null &&
      (!data.records[id] || data.records[id].purgedAt !== old.purgedAt || data.records[id].version < old.version)) fail('PURGE_IMMUTABLE', 'Purged records cannot be restored by a normal transaction');
  }
  return data;
}

export function validateLifecycleReferences(state, options = {}) {
  const content = state.modules.content;
  for (const record of Object.values(state.modules.lifecycle?.records ?? {})) {
    if (record.revisionId !== null && record.entityId === null) fail('REFERENCE_ENTITY', 'A revision link requires its entity ID');
    if (record.entityId === null) continue;
    if (content) {
      if (!content.entities.some(entity => entity.id === record.entityId)) fail('REFERENCE_MISSING', 'Linked entity does not exist');
      if (record.revisionId !== null) {
        const revision = content.revisions.find(item => item.id === record.revisionId);
        if (!revision) fail('REFERENCE_MISSING', 'Linked revision does not exist');
        if (revision.entityId !== record.entityId) fail('REFERENCE_ENTITY', 'Linked revision belongs to another entity');
      }
    } else if (options.referenceValidator) {
      const accepted = options.referenceValidator({ entityId: record.entityId, revisionId: record.revisionId });
      if (accepted !== true) fail('REFERENCE_MISSING', 'External entity or revision reference is invalid');
    }
  }
}

/** Restore must reconcile an independently retained current withdrawal register. */
export function prepareLifecycleRestore(state, options = {}) {
  const data = dataOf(state), now = timestamp(options);
  if (!integer(now)) fail('INVALID_RESTORE_TIME', 'Restore time must be an epoch timestamp');
  if (Object.keys(data.subjects).length && !Array.isArray(options.withdrawnSubjectIds)) fail('LIFECYCLE_RECONCILIATION_REQUIRED', 'Restore requires a reviewed current withdrawal register, including an explicit empty list when none exist');
  if (options.withdrawnSubjectIds !== undefined && (!Array.isArray(options.withdrawnSubjectIds) || !options.withdrawnSubjectIds.every(identifier))) fail('INVALID_WITHDRAWAL_REGISTER', 'Withdrawal register must contain valid subject IDs');
  let unknownSubjects = 0, appliedWithdrawals = 0;
  for (const id of new Set(options.withdrawnSubjectIds ?? [])) {
    if (!own(data.subjects, id)) { unknownSubjects += 1; continue; }
    if (data.subjects[id].withdrawnAt === null) { lifecycleCommand(state, { id }, { action: 'withdraw' }, { now }); appliedWithdrawals += 1; }
  }
  const maintenance = lifecycleCommand(state, { id: 'system:restore', mfa: true, roles: ['operations_admin'] }, { action: 'retain' }, { now });
  audit(state, null, 'lifecycle.restore.reconcile', null, now, { appliedWithdrawals, unknownSubjects, expiredRecords: maintenance.evidence.purged });
  return { appliedWithdrawals, unknownSubjects, expiredRecords: maintenance.evidence.purged };
}

export const lifecycleModule = { name: 'lifecycle', schemaVersion: 1, initialState: () => ({ records: {}, subjects: {}, runs: [] }), validate: validateLifecycle, validateState: validateLifecycleReferences, prepareRestore: prepareLifecycleRestore };

function dataOf(state) {
  const data = state.modules?.lifecycle;
  if (!data) fail('MODULE_DISABLED', 'Lifecycle module is disabled', 404);
  return data;
}

function workflow(config, type) {
  const policy = config?.workflows?.[type];
  if (!identifier(type) || !object(policy) || !Array.isArray(policy.states) || !policy.states.every(identifier) ||
    !policy.states.includes(policy.initialState) || !object(policy.transitions) || !integer(policy.retentionMs) || policy.retentionMs === 0 ||
    !Array.isArray(policy.decisionCodes ?? []) || !(policy.decisionCodes ?? []).every(identifier) ||
    (policy.requireConsent && (!identifier(policy.purpose) || !identifier(policy.consentVersion)))) fail('INVALID_WORKFLOW', 'Workflow configuration is invalid');
  for (const [from, targets] of Object.entries(policy.transitions)) if (!policy.states.includes(from) || !Array.isArray(targets) || !targets.every(to => policy.states.includes(to))) fail('INVALID_WORKFLOW', 'Workflow transitions reference an unknown state');
  if (!Array.isArray(policy.eligibilityFields ?? []) || !(policy.eligibilityFields ?? []).every(identifier)) fail('INVALID_WORKFLOW', 'Invalid eligibility configuration');
  return policy;
}

function audit(state, principal, action, targetId, now, metadata = {}) {
  state.audit.push({ id: randomUUID(), subjectId: subjectOf(principal) ?? null, action, targetId, createdAt: now, metadata });
}

function subject(data, id) {
  if (!identifier(id)) fail('UNAUTHENTICATED', 'An authenticated subject is required', 401);
  return own(data.subjects, id) ? data.subjects[id] : null;
}

function assertActive(data, id, policy, epoch, now) {
  const current = subject(data, id);
  if (!current || current.withdrawnAt !== null) fail('CONSENT_WITHDRAWN', 'The subject is unavailable or has withdrawn', 403);
  if (epoch !== current.epoch) fail('CONSENT_CONFLICT', 'Consent changed while the request was in flight', 409);
  if (policy.requireConsent) {
    const consent = current.consents[policy.purpose];
    if (!consent || consent.version !== policy.consentVersion || consent.grantedAt > now) fail('CONSENT_REQUIRED', 'Current consent is required', 403);
  }
  for (const field of policy.eligibilityFields ?? []) if (current.eligibility[field] !== true) fail('INELIGIBLE', 'Configured participation eligibility is not satisfied', 403);
  return current;
}

function dto(record) {
  return { id: record.id, type: record.type, status: record.status, version: record.version, entityId: record.entityId, revisionId: record.revisionId, assignee: record.assignee, decisionCode: record.decisionCode, createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt, purgedAt: record.purgedAt };
}

export function lifecycleList(state) { return Object.values(dataOf(state).records).map(dto); }

export function lifecyclePublicResults(state, options = {}) {
  const data = dataOf(state), content = state.modules.content, now = timestamp(options);
  if (!content) return [];
  const publicTime = new Date(now).toISOString();
  const visible = new Set(projectPublic(content, { now: publicTime, communityId: state.communityId, revision: state.revision }).nodes.map(node => node.id));
  return Object.values(data.records).filter(record => record.purgedAt === null && record.expiresAt > now && record.publicResult && visible.has(record.entityId) &&
    (record.revisionId === null || readPublicRevision(content, record.revisionId, { now: publicTime }))).map(record => ({ entityId: record.entityId, revisionId: record.revisionId, result: { code: record.publicResult.code, label: record.publicResult.label }, updatedAt: record.updatedAt }));
}

/** Invoke inside readAuthorized/store.transact so failure to persist the audit prevents disclosure. */
export function lifecycleDetail(state, principal, id, options = {}) {
  const policy = options.policy ?? defaultRolePermissions;
  requirePermission(principal, ['lifecycle:self', 'lifecycle:manage'], policy);
  const record = dataOf(state).records[id];
  if (!record) fail('NOT_FOUND', 'Private record not found', 404);
  let manager = false;
  try { requirePermission(principal, 'lifecycle:manage', policy); manager = true; } catch (error) { if (error.code !== 'FORBIDDEN') throw error; }
  if (record.subjectId !== subjectOf(principal) && !manager) fail('FORBIDDEN', 'Private details belong to another subject', 403);
  if (record.purgedAt === null && record.expiresAt <= timestamp(options)) fail('RECORD_EXPIRED', 'Private payload retention period has ended', 410);
  const payload = record.payload ? decryptPrivatePayload(id, record.payload, options.keyring) : null;
  audit(state, principal, 'lifecycle.detail.read', id, timestamp(options));
  return { ...dto(record), payload: !manager && object(payload) && own(payload, 'data') ? { data: payload.data } : payload };
}

function purgeRecord(record, now) {
  Object.assign(record, { payload: null, subjectId: null, entityId: null, revisionId: null, externalId: null, assignee: null, decisionCode: null, publicResult: null, purgedAt: now, updatedAt: now, version: record.version + 1 });
}

function eraseAssociations(state, subjectId, recordIds, { eraseSubject = false } = {}) {
  const ids = new Set(recordIds);
  const linked = value => typeof value === 'string' ? ids.has(value) : value !== null && typeof value === 'object' ? Object.values(value).some(linked) : false;
  for (const [key, entry] of Object.entries(state.idempotency)) {
    // Results/fingerprints may contain target IDs; delete the entire associated entry.
    if ((subjectId && entry.subjectId === subjectId) || linked(entry)) delete state.idempotency[key];
  }
  state.audit = state.audit.filter(entry => !(eraseSubject && [entry.subjectId, entry.actorId, entry.targetId].includes(subjectId)) && !linked(entry));
}

function revokeSessions(state, subjectId, now, sessionId = null) {
  for (const session of state.modules.auth?.sessions ?? []) if (session.subjectId === subjectId && (sessionId === null || session.id === sessionId)) {
    session.revokedAt = now;
    session.tokenHash = createHash('sha256').update(`revoked:${randomUUID()}`).digest('hex');
  }
}

function ownSubject(principal, requested) {
  const id = subjectOf(principal);
  if (!identifier(id)) fail('UNAUTHENTICATED', 'An authenticated subject is required', 401);
  if (requested !== undefined && requested !== id) fail('FORBIDDEN', 'Consent and withdrawal must belong to the current subject', 403);
  return id;
}

export function lifecycleCommand(state, principal, input, options = {}) {
  const data = dataOf(state), now = timestamp(options);
  if (!integer(now) || !object(input)) fail('INVALID_REQUEST', 'Invalid lifecycle request');
  const { config, keyring } = options;
  if (['transition', 'import'].includes(input.action)) requirePermission(principal, 'lifecycle:manage', options.policy ?? defaultRolePermissions);
  if (['retain', 'task'].includes(input.action)) requirePermission(principal, ['operations:manage', 'lifecycle:manage'], options.policy ?? defaultRolePermissions);
  switch (input.action) {
    case 'consent': {
      const id = ownSubject(principal, input.subjectId), policy = workflow(config, input.type);
      let current = subject(data, id);
      if (current && current.withdrawnAt !== null) fail('CONSENT_WITHDRAWN', 'Withdrawal is final for this subject; create a separately reviewed enrollment', 403);
      if (!object(input.eligibility ?? {}) || !Object.values(input.eligibility ?? {}).every(value => typeof value === 'boolean')) fail('INVALID_ELIGIBILITY', 'Eligibility values must be booleans');
      for (const field of policy.eligibilityFields ?? []) if (input.eligibility?.[field] !== true) fail('INELIGIBLE', 'Required eligibility must be explicitly confirmed', 403);
      if (policy.requireConsent && (input.version !== policy.consentVersion || input.accepted !== true)) fail('CONSENT_REQUIRED', 'Explicit current-version consent is required', 403);
      current ??= { id, epoch: 0, consents: {}, eligibility: {}, withdrawnAt: null };
      current.epoch += 1;
      for (const record of Object.values(data.records)) if (record.subjectId === id && record.purgedAt === null) { record.consentEpoch = current.epoch; record.version += 1; record.updatedAt = now; }
      current.eligibility = { ...current.eligibility, ...clone(input.eligibility ?? {}) };
      if (policy.requireConsent) current.consents[policy.purpose] = { version: input.version, grantedAt: now };
      data.subjects[id] = current;
      audit(state, principal, 'lifecycle.consent.grant', id, now, { purpose: policy.purpose ?? null, version: policy.consentVersion ?? null, epoch: current.epoch });
      return { subjectId: id, consentEpoch: current.epoch };
    }
    case 'create': {
      const id = input.id ?? randomUUID(), owner = ownSubject(principal, input.subjectId), policy = workflow(config, input.type);
      if (!identifier(id) || own(data.records, id)) fail('RECORD_CONFLICT', 'Private record ID already exists or is invalid', 409);
      if (!policy.requireConsent && !subject(data, owner)) data.subjects[owner] = { id: owner, epoch: 0, consents: {}, eligibility: {}, withdrawnAt: null };
      const current = assertActive(data, owner, policy, input.consentEpoch ?? (policy.requireConsent ? undefined : 0), now);
      if (!object(input.payload)) fail('INVALID_PRIVATE_DATA', 'Private payload must be an object');
      const expiresAt = now + policy.retentionMs;
      if (!integer(expiresAt)) fail('INVALID_WORKFLOW', 'Retention expiry exceeds supported timestamps');
      const record = { id, type: input.type, status: policy.initialState, version: 0, subjectId: owner, consentEpoch: current.epoch, entityId: input.entityId ?? null, revisionId: input.revisionId ?? null, externalId: input.externalId ?? null, assignee: null, decisionCode: null, publicResult: null, createdAt: now, updatedAt: now, expiresAt, purgedAt: null, payload: encryptPrivatePayload(id, { data: input.payload, internalNotes: [] }, keyring) };
      data.records[id] = record;
      validateLifecycle(data);
      validateLifecycleReferences(state, options);
      audit(state, principal, 'lifecycle.record.create', id, now);
      return dto(record);
    }
    case 'transition': {
      const record = data.records[input.id];
      if (!record) fail('NOT_FOUND', 'Private record not found', 404);
      if (record.purgedAt !== null || record.expiresAt <= now) fail('RECORD_EXPIRED', 'Private record is expired or withdrawn', 410);
      const policy = workflow(config, record.type);
      assertActive(data, record.subjectId, policy, record.consentEpoch, now);
      if (input.expectedVersion !== record.version) fail('VERSION_CONFLICT', 'Private record version changed', 409);
      if (!(policy.transitions[record.status] ?? []).includes(input.status)) fail('INVALID_TRANSITION', 'Workflow does not allow this state change', 409);
      const decision = input.decisionCode ?? null;
      if (decision !== null && !(policy.decisionCodes ?? []).includes(decision)) fail('INVALID_DECISION', 'Decision code is not configured');
      if ((policy.terminalStates ?? []).includes(input.status) && !decision) fail('DECISION_REQUIRED', 'A terminal state requires a decision code');
      if (input.assignee !== undefined && input.assignee !== null && !identifier(input.assignee)) fail('INVALID_ASSIGNEE', 'Invalid assignee');
      if (input.note !== undefined) {
        if (typeof input.note !== 'string' || input.note.length > 20000) fail('INVALID_NOTE', 'Internal note exceeds 20000 characters');
        const payload = decryptPrivatePayload(record.id, record.payload, keyring);
        if (!object(payload) || !object(payload.data) || !Array.isArray(payload.internalNotes)) fail('INVALID_PRIVATE_DATA', 'Migrate the legacy payload before adding internal notes');
        payload.internalNotes.push({ text: input.note, actorId: subjectOf(principal), createdAt: now });
        record.payload = encryptPrivatePayload(record.id, payload, keyring);
      }
      record.status = input.status;
      record.version += 1;
      record.updatedAt = now;
      if (input.assignee !== undefined) record.assignee = input.assignee;
      record.decisionCode = decision;
      const published = decision && policy.publicResults?.[decision];
      record.publicResult = published ? { code: published.code, label: published.label } : null;
      validateLifecycle(data);
      audit(state, principal, 'lifecycle.record.transition', record.id, now, { state: record.status, version: record.version });
      return dto(record);
    }
    case 'withdraw': {
      const id = ownSubject(principal, input.subjectId), current = subject(data, id);
      if (!current) fail('NOT_FOUND', 'Consent subject not found', 404);
      if (current.withdrawnAt !== null) return { withdrawn: true, nonReplayable: true };
      const ids = Object.values(data.records).filter(record => record.subjectId === id).map(record => record.id);
      for (const recordId of ids) purgeRecord(data.records[recordId], now);
      current.epoch += 1;
      current.withdrawnAt = now;
      current.consents = {};
      current.eligibility = {};
      revokeSessions(state, id, now);
      eraseAssociations(state, id, ids, { eraseSubject: true });
      audit(state, null, 'lifecycle.consent.withdraw', null, now, { purgedRecords: ids.length });
      return { withdrawn: true, nonReplayable: true };
    }
    case 'logout': {
      const id = ownSubject(principal, input.subjectId);
      if (!principal.sessionId) fail('INVALID_SESSION', 'Current device session is required');
      revokeSessions(state, id, now, principal.sessionId);
      return { loggedOut: true, consentWithdrawn: false, nonReplayable: true };
    }
    case 'retain': {
      const ids = Object.values(data.records).filter(record => record.purgedAt === null && record.expiresAt <= now).map(record => record.id);
      for (const id of ids) purgeRecord(data.records[id], now);
      eraseAssociations(state, null, ids);
      const run = { id: randomUUID(), task: 'retention', status: 'succeeded', startedAt: now, finishedAt: now, evidence: { examined: Object.keys(data.records).length, purged: ids.length } };
      data.runs.push(run);
      audit(state, principal, 'lifecycle.retention.run', run.id, now, run.evidence);
      return clone(run);
    }
    case 'task': {
      if (!identifier(input.task) || typeof options.taskProvider !== 'function') fail('INVALID_TASK', 'A configured maintenance task provider is required');
      const run = { id: randomUUID(), task: input.task, status: 'succeeded', startedAt: now, finishedAt: now, evidence: {} };
      try {
        const evidence = options.taskProvider({ task: input.task, now });
        if (evidence?.then) { Promise.resolve(evidence).catch(() => {}); fail('INVALID_TASK_RESULT', 'Maintenance providers must return synchronous JSON evidence'); }
        if (!object(evidence)) fail('INVALID_TASK_RESULT', 'Maintenance providers must return synchronous JSON evidence');
        json(evidence);
        if (Buffer.byteLength(JSON.stringify(evidence)) > 16384) fail('INVALID_TASK_RESULT', 'Maintenance evidence exceeds 16 KiB');
        run.evidence = clone(evidence);
      } catch (error) { run.status = 'failed'; run.evidence = { errorCode: error instanceof RuntimeError ? error.code : 'TASK_FAILED' }; }
      data.runs.push(run);
      audit(state, principal, 'lifecycle.maintenance.run', run.id, now, { status: run.status });
      return clone(run);
    }
    case 'import': {
      if (!object(input.data)) fail('INVALID_IMPORT', 'A private lifecycle snapshot is required');
      const imported = clone(input.data);
      validateLifecycle(imported);
      for (const record of Object.values(imported.records)) if (record.payload) decryptPrivatePayload(record.id, record.payload, keyring);
      if (Object.keys(data.records).length || Object.keys(data.subjects).length || data.runs.length) fail('IMPORT_CONFLICT', 'Private import requires an empty lifecycle module', 409);
      state.modules.lifecycle = imported;
      validateLifecycleReferences(state, options);
      // Import never carries active credentials; the outer runtime restore also invalidates sessions.
      for (const session of state.modules.auth?.sessions ?? []) { session.revokedAt = now; session.tokenHash = createHash('sha256').update(`import:${randomUUID()}`).digest('hex'); }
      state.idempotency = {};
      audit(state, principal, 'lifecycle.private.import', null, now, { records: Object.keys(imported.records).length });
      return { imported: Object.keys(imported.records).length, sessionsInvalidated: true, nonReplayable: true };
    }
    default: fail('INVALID_ACTION', 'Unknown lifecycle action');
  }
}
