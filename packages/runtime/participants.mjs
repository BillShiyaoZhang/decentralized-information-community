import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RuntimeError, jsonClone } from './errors.mjs';

const reject = (code, message, status = 400) => { throw new RuntimeError(code, message, status); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,119}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const fields = (value, allowed, code = 'INVALID_PARTICIPANT_INPUT') => {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) reject(code, 'Expected a plain object');
  jsonClone(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) reject(code, 'Unexpected participant field');
};
const nowOf = options => { const now = options?.now ?? Date.now(); if (!integer(now)) reject('INVALID_PARTICIPANT_TIME', 'Expected an epoch timestamp'); return now; };
const dataOf = state => { if (!state.modules?.participants) reject('MODULE_DISABLED', 'Participant invitations are disabled', 404); return state.modules.participants; };
const validEligibility = value => {
  fields(value, Object.keys(value ?? {}), 'INVALID_ELIGIBILITY');
  if (Object.keys(value).length > 32 || Object.entries(value).some(([key, eligible]) => !identifier(key) || typeof eligible !== 'boolean')) reject('INVALID_ELIGIBILITY', 'Eligibility must contain at most 32 named boolean fields');
};
const audit = (state, subjectId, action, targetId, now) => state.audit.push({ id: randomUUID(), subjectId, actorId: 'system:participant-provisioning', sessionId: null, action, targetId, at: now });

/** Trusted deployment policy. No role, lifetime or eligibility is accepted on redemption. */
export function validateParticipantConfig(config) {
  if (config === undefined || config === null || config === false) reject('PARTICIPANTS_DISABLED', 'Participant invitations are not configured', 404);
  fields(config, ['role', 'invitationTtlMs', 'sessionTtlMs', 'idleTtlMs', 'selfService'], 'INVALID_PARTICIPANT_CONFIG');
  const result = { role: 'participant', invitationTtlMs: 24 * 60 * 60_000, sessionTtlMs: 8 * 60 * 60_000, idleTtlMs: 30 * 60_000, ...jsonClone(config) };
  if (!identifier(result.role)) reject('INVALID_PARTICIPANT_CONFIG', 'A valid participant role is required');
  for (const [key, maximum] of [['invitationTtlMs', 7 * 24 * 60 * 60_000], ['sessionTtlMs', 24 * 60 * 60_000], ['idleTtlMs', 60 * 60_000]]) {
    if (!integer(result[key]) || result[key] === 0 || result[key] > maximum) reject('INVALID_PARTICIPANT_CONFIG', 'Participant credential lifetime exceeds its bound');
  }
  if (result.idleTtlMs > result.sessionTtlMs) reject('INVALID_PARTICIPANT_CONFIG', 'Idle lifetime cannot exceed session lifetime');
  fields(result.selfService, ['actions', 'types'], 'INVALID_PARTICIPANT_CONFIG');
  if (!Array.isArray(result.selfService.actions) || result.selfService.actions.some(action => !['consent', 'create', 'withdraw', 'logout', 'list'].includes(action)) ||
    new Set(result.selfService.actions).size !== result.selfService.actions.length || !Array.isArray(result.selfService.types) || result.selfService.types.some(type => !identifier(type)) || new Set(result.selfService.types).size !== result.selfService.types.length) reject('INVALID_PARTICIPANT_CONFIG', 'Explicit self-service action and workflow allowlists are required');
  return result;
}

/** Invitation assurance permits only explicitly configured self-service operations. */
export function assertParticipantOperation(principal, input, config) {
  if (principal?.assurance !== 'invitation') return principal;
  const policy = validateParticipantConfig(config);
  if (!policy.selfService.actions.includes(input?.action) || (['consent', 'create'].includes(input.action) && !policy.selfService.types.includes(input.type)) ||
    (input?.type !== undefined && !policy.selfService.types.includes(input.type))) reject('FORBIDDEN', 'Invitation credentials cannot perform this operation', 403);
  return principal;
}

function validateParticipants(data, previous) {
  fields(data, ['subjects', 'invitations', 'sessions'], 'INVALID_PARTICIPANTS');
  if (![data.subjects, data.invitations, data.sessions].every(Array.isArray)) reject('INVALID_PARTICIPANTS', 'Invalid participant storage');
  const subjects = new Map();
  for (const subject of data.subjects) {
    fields(subject, ['id', 'eligibility', 'createdAt', 'revokedAt'], 'INVALID_PARTICIPANTS');
    if (!identifier(subject.id) || subjects.has(subject.id) || !integer(subject.createdAt) || !(subject.revokedAt === null || integer(subject.revokedAt))) reject('INVALID_PARTICIPANTS', 'Invalid participant subject');
    validEligibility(subject.eligibility);
    if (subject.revokedAt !== null && Object.keys(subject.eligibility).length) reject('INVALID_PARTICIPANTS', 'Revoked subject retains eligibility');
    subjects.set(subject.id, subject);
  }
  for (const [name, extra] of [['invitations', ['redeemedAt']], ['sessions', ['idleExpiresAt', 'idleTtlMs']]]) {
    const ids = new Set(), hashes = new Set();
    for (const credential of data[name]) {
      fields(credential, ['id', 'subjectId', 'tokenHash', 'issuedAt', 'expiresAt', 'revokedAt', ...extra], 'INVALID_PARTICIPANTS');
      if (!identifier(credential.id) || ids.has(credential.id) || !subjects.has(credential.subjectId) || !/^[a-f0-9]{64}$/.test(credential.tokenHash) || hashes.has(credential.tokenHash) ||
        !integer(credential.issuedAt) || !integer(credential.expiresAt) || credential.expiresAt <= credential.issuedAt || !(credential.revokedAt === null || integer(credential.revokedAt))) reject('INVALID_PARTICIPANTS', 'Invalid participant credential');
      if (name === 'invitations' && !(credential.redeemedAt === null || integer(credential.redeemedAt))) reject('INVALID_PARTICIPANTS', 'Invalid invitation redemption');
      if (name === 'sessions' && (!integer(credential.idleExpiresAt) || credential.idleExpiresAt > credential.expiresAt || !integer(credential.idleTtlMs) || !credential.idleTtlMs || credential.idleTtlMs > 60 * 60_000)) reject('INVALID_PARTICIPANTS', 'Invalid participant session');
      if (subjects.get(credential.subjectId).revokedAt !== null) reject('INVALID_PARTICIPANTS', 'Revoked subject retains credentials');
      ids.add(credential.id); hashes.add(credential.tokenHash);
    }
  }
  for (const old of previous?.subjects ?? []) if (old.revokedAt !== null) {
    const current = subjects.get(old.id);
    if (!current || current.revokedAt !== old.revokedAt) reject('PARTICIPANT_REVOCATION_IMMUTABLE', 'Participant revocation cannot be reversed');
  }
  return data;
}

export const participantsModule = {
  name: 'participants', schemaVersion: 1,
  initialState: () => ({ subjects: [], invitations: [], sessions: [] }),
  validate: validateParticipants,
  validateState(state) {
    // A named account withdrawal may leave a tombstone beside its disabled account.
    for (const subject of state.modules.participants.subjects) if (state.modules.auth?.accounts.some(account => account.id === subject.id && (subject.revokedAt === null || account.active))) reject('SUBJECT_CONFLICT', 'Participant and named-account identities must be distinct');
  },
  prepareRestore: prepareParticipantRestore,
};

/** Call inside a trusted offline/admin transaction after reviewing eligibility. */
export function issueParticipantInvitation(state, input, options = {}) {
  fields(input, ['subjectId', 'eligibility']);
  const policy = validateParticipantConfig(options.config), now = nowOf(options), data = dataOf(state);
  validEligibility(input.eligibility);
  const subjectId = input.subjectId ?? `participant:${randomUUID()}`;
  if (!identifier(subjectId) || !subjectId.startsWith('participant:')) reject('INVALID_PARTICIPANT_SUBJECT', 'Participant IDs must use the participant: namespace');
  if (state.modules.auth?.accounts.some(account => account.id === subjectId)) reject('SUBJECT_CONFLICT', 'Participant ID collides with a named account', 409);
  let subject = data.subjects.find(item => item.id === subjectId);
  if ((subject && subject.revokedAt !== null) || state.modules.lifecycle?.subjects?.[subjectId]?.withdrawnAt != null) reject('SUBJECT_REVOKED', 'A revoked or withdrawn subject cannot be re-enrolled', 403);
  if (!subject) { subject = { id: subjectId, eligibility: {}, createdAt: now, revokedAt: null }; data.subjects.push(subject); }
  subject.eligibility = jsonClone(input.eligibility);
  const token = `pi_${randomBytes(32).toString('base64url')}`, expiresAt = now + policy.invitationTtlMs;
  if (!integer(expiresAt)) reject('INVALID_PARTICIPANT_TIME', 'Invitation expiry exceeds supported timestamps');
  const invitation = { id: randomUUID(), subjectId, tokenHash: hash(token), issuedAt: now, expiresAt, redeemedAt: null, revokedAt: null };
  data.invitations.push(invitation);
  audit(state, subjectId, 'participant.invitation.issue', invitation.id, now);
  return { invitationId: invitation.id, subjectId, token, expiresAt, nonReplayable: true };
}

/** Trusted administrative cancellation affects only this unredeemed invitation. */
export function cancelParticipantInvitation(state, input, options = {}) {
  fields(input, ['invitationId']);
  if (!identifier(input.invitationId)) reject('INVALID_PARTICIPANT_INPUT', 'A valid invitation ID is required');
  const now = nowOf(options), data = dataOf(state);
  const invitation = data.invitations.find(item => item.id === input.invitationId);
  if (!invitation) reject('NOT_FOUND', 'Invitation does not exist', 404);
  if (invitation.redeemedAt !== null) reject('INVITATION_REDEEMED', 'A redeemed invitation cannot be cancelled; revoke the session instead', 409);
  if (invitation.revokedAt === null) {
    if (invitation.issuedAt > now || invitation.expiresAt <= now) reject('INVITATION_UNAVAILABLE', 'Only a current pending invitation can be cancelled', 409);
    invitation.revokedAt = now;
    invitation.tokenHash = hash(`cancelled:${randomUUID()}`);
    audit(state, invitation.subjectId, 'participant.invitation.cancel', invitation.id, now);
  }
  return { invitationId: invitation.id, subjectId: invitation.subjectId, cancelled: true, revokedAt: invitation.revokedAt };
}

export function redeemParticipantInvitation(store, input, options = {}) {
  fields(input, ['token']);
  const policy = validateParticipantConfig(options.config), now = nowOf(options);
  if (typeof input.token !== 'string' || !/^pi_[A-Za-z0-9_-]{43}$/.test(input.token)) reject('INVALID_INVITATION', 'Invitation is invalid, expired or already used', 401);
  return store.transact(state => {
    const data = dataOf(state), tokenHash = hash(input.token);
    const invitation = data.invitations.find(item => equal(item.tokenHash, tokenHash));
    const subject = data.subjects.find(item => item.id === invitation?.subjectId);
    if (!invitation || invitation.revokedAt !== null || invitation.redeemedAt !== null || invitation.issuedAt > now || invitation.expiresAt <= now || !subject || subject.revokedAt !== null || state.modules.lifecycle?.subjects?.[subject.id]?.withdrawnAt != null) reject('INVALID_INVITATION', 'Invitation is invalid, expired or already used', 401);
    const token = `ps_${randomBytes(32).toString('base64url')}`, expiresAt = now + policy.sessionTtlMs;
    if (!integer(expiresAt)) reject('INVALID_PARTICIPANT_TIME', 'Session expiry exceeds supported timestamps');
    const session = { id: randomUUID(), subjectId: subject.id, tokenHash: hash(token), issuedAt: now, expiresAt, idleExpiresAt: Math.min(now + policy.idleTtlMs, expiresAt), idleTtlMs: policy.idleTtlMs, revokedAt: null };
    invitation.redeemedAt = now; invitation.tokenHash = hash(`redeemed:${randomUUID()}`);
    data.sessions.push(session);
    audit(state, subject.id, 'participant.invitation.redeem', session.id, now);
    return { token, expiresAt, principal: participantPrincipal(subject, session, policy) };
  });
}

function participantPrincipal(subject, session, config) {
  return { id: subject.id, roles: [config.role], sessionId: session.id, mfa: false, assurance: 'invitation', eligibility: jsonClone(subject.eligibility) };
}

export function authenticateParticipant(state, token, options = {}) {
  const policy = validateParticipantConfig(options.participantsConfig ?? options.config), now = nowOf(options), data = dataOf(state);
  if (typeof token !== 'string' || !/^ps_[A-Za-z0-9_-]{43}$/.test(token)) reject('UNAUTHENTICATED', 'A valid participant session is required', 401);
  const session = data.sessions.find(item => equal(item.tokenHash, hash(token)));
  const subject = data.subjects.find(item => item.id === session?.subjectId);
  if (!session || session.revokedAt !== null || session.issuedAt > now || session.expiresAt <= now || session.idleExpiresAt <= now || !subject || subject.revokedAt !== null || state.modules.lifecycle?.subjects?.[subject.id]?.withdrawnAt != null) reject('UNAUTHENTICATED', 'Participant session is unavailable or revoked', 401);
  session.idleExpiresAt = Math.min(now + session.idleTtlMs, session.expiresAt);
  return participantPrincipal(subject, session, policy);
}

/** Permanent subject tombstone; session logout must use the session-specific hook. */
export function revokeParticipantSubject(state, subjectId, options = {}) {
  if (!identifier(subjectId)) reject('INVALID_PARTICIPANT_SUBJECT', 'A valid subject ID is required');
  const now = nowOf(options), data = dataOf(state);
  let subject = data.subjects.find(item => item.id === subjectId);
  if (!subject) { subject = { id: subjectId, eligibility: {}, createdAt: now, revokedAt: now }; data.subjects.push(subject); }
  subject.revokedAt ??= now; subject.eligibility = {};
  data.sessions = data.sessions.filter(item => item.subjectId !== subjectId);
  data.invitations = data.invitations.filter(item => item.subjectId !== subjectId);
  return { revoked: true, subjectId };
}

/** Old backups cannot resurrect invitations, sessions or independently reviewed revocations. */
export function prepareParticipantRestore(state, options = {}) {
  const data = dataOf(state), now = nowOf(options);
  if (data.subjects.length && !Array.isArray(options.revokedSubjectIds)) reject('PARTICIPANT_RECONCILIATION_REQUIRED', 'Restore requires a reviewed current participant revocation register, including an explicit empty list');
  for (const key of ['revokedSubjectIds', 'withdrawnSubjectIds']) if (options[key] !== undefined && (!Array.isArray(options[key]) || !options[key].every(identifier))) reject('INVALID_REVOCATION_REGISTER', 'Revocation registers must contain valid subject IDs');
  const revoked = new Set([...(options.revokedSubjectIds ?? []), ...(options.withdrawnSubjectIds ?? []), ...Object.values(state.modules.lifecycle?.subjects ?? {}).filter(subject => subject.withdrawnAt !== null).map(subject => subject.id)]);
  data.invitations = []; data.sessions = [];
  for (const subjectId of revoked) revokeParticipantSubject(state, subjectId, { now });
  return { credentialsInvalidated: true, reviewedRevocations: revoked.size };
}
