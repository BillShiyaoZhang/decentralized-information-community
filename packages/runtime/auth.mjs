import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { RuntimeError } from './errors.mjs';
import { authenticateParticipant, revokeParticipantSubject } from './participants.mjs';
export { assertParticipantOperation } from './participants.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,119}$/.test(value);
const reject = (code, message, status = 400) => { throw new RuntimeError(code, message, status); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const epoch = now => now ?? Date.now();

/** Names and permissions are business configuration, not claims supplied by a client. */
export const defaultRolePermissions = Object.freeze({
  content_editor: ['content:read', 'content:edit'],
  content_reviewer: ['content:read', 'content:publish', 'content:visibility'],
  pilot_operator: ['lifecycle:manage'],
  safety_reviewer: ['lifecycle:manage', 'content:visibility'],
  account_admin: ['accounts:manage'],
  operations_admin: ['operations:manage'],
  participant: ['lifecycle:self'],
});

export const authModule = {
  name: 'auth', schemaVersion: 2,
  initialState: () => ({ accounts: [], sessions: [], failures: {}, revokedSubjectIds: [] }),
  migrations: { 2: data => ({ ...data, accounts: data.accounts.map(account => ({ ...account, version: 0, credentialsRequired: false, revokedAt: account.active ? null : 0 })), revokedSubjectIds: data.accounts.filter(account => !account.active).map(account => account.id) }) },
  prepareRestore: (state, options) => prepareIdentityRestore(state, options),
  validate(data, previous) {
    if (!record(data) || !Array.isArray(data.accounts) || !Array.isArray(data.sessions) || !record(data.failures) || !Array.isArray(data.revokedSubjectIds) || data.revokedSubjectIds.some(id => !identifier(id)) || new Set(data.revokedSubjectIds).size !== data.revokedSubjectIds.length) reject('INVALID_AUTH', '无效身份模块');
    if (previous?.revokedSubjectIds?.some(id => !data.revokedSubjectIds.includes(id))) reject('ACCOUNT_REVOKED', '永久撤销记录不能删除', 403);
    const ids = new Set();
    for (const account of data.accounts) {
      if (!identifier(account.id) || ids.has(account.id) || typeof account.displayName !== 'string' || !account.displayName.trim() || account.displayName.length > 120 || !Array.isArray(account.roles) || !account.roles.length || account.roles.some(role => !identifier(role)) || typeof account.active !== 'boolean' || !Number.isSafeInteger(account.lastTotpCounter) || account.lastTotpCounter < -1 || !Number.isSafeInteger(account.version) || account.version < 0 || typeof account.credentialsRequired !== 'boolean' || !(account.revokedAt === null || Number.isSafeInteger(account.revokedAt) && account.revokedAt >= 0) || (account.revokedAt !== null && account.active)) reject('INVALID_AUTH', '无效具名账户');
      if (account.credentialsRequired) {
        if (account.passwordSalt !== null || account.passwordHash !== null || account.mfa !== null || account.lastTotpCounter !== -1) reject('INVALID_AUTH', '恢复后的账户必须重新配置完整凭据');
      } else if (!/^[a-f0-9]{64}$/.test(account.passwordSalt) || !/^[a-f0-9]{128}$/.test(account.passwordHash) || !record(account.mfa) || !/^[a-f0-9]{24}$/.test(account.mfa.iv) || !/^[a-f0-9]{32}$/.test(account.mfa.tag) || !/^[a-f0-9]+$/.test(account.mfa.data)) reject('INVALID_AUTH', '无效加密账户凭据');
      if (data.revokedSubjectIds.includes(account.id) !== (account.revokedAt !== null)) reject('INVALID_AUTH', '账户撤销标记与永久记录不一致');
      ids.add(account.id);
    }
    for (const old of previous?.accounts ?? []) if (old.revokedAt != null) {
      const account = data.accounts.find(value => value.id === old.id);
      if (!account || account.revokedAt !== old.revokedAt || account.active) reject('ACCOUNT_REVOKED', '永久撤销账户不能恢复或删除撤销标记', 403);
    }
    const sessions = new Set();
    for (const session of data.sessions) {
      if (!identifier(session.id) || sessions.has(session.id) || !ids.has(session.subjectId) || !/^[a-f0-9]{64}$/.test(session.tokenHash) || ![session.issuedAt, session.expiresAt, session.idleExpiresAt].every(Number.isSafeInteger) || !(session.revokedAt === null || Number.isSafeInteger(session.revokedAt))) reject('INVALID_AUTH', '无效会话');
      sessions.add(session.id);
    }
    return data;
  },
};

function encryptionKey(value) {
  const key = Buffer.isBuffer(value) ? value : typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : null;
  if (!key || key.length !== 32) reject('MFA_KEY_REQUIRED', '需要配置 32 字节 MFA 加密密钥', 503);
  return key;
}
function decodeBase32(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32,128}$/.test(secret)) reject('INVALID_MFA_SECRET', 'TOTP 密钥必须是至少 160 位的 Base32 字符串');
  let bits = 0, value = 0; const bytes = [];
  for (const char of secret) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
  return Buffer.from(bytes);
}
function effectiveTotpKey(secret) {
  // HMAC-SHA1 hashes long keys and zero-pads short keys; both forms can alias.
  const decoded = decodeBase32(secret), key = decoded.length > 64 ? createHash('sha1').update(decoded).digest() : decoded;
  const block = Buffer.alloc(64); key.copy(block); return block;
}
export function generateTotpSecret() {
  const bytes = randomBytes(20); let bits = 0, value = 0, result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> bits) & 31]; } }
  return result;
}
/** RFC 6238 compatible six-digit authenticator code; exported for provider integration tests. */
export function totpCode(secret, now = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', decodeBase32(secret)).update(counter).digest(); const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
function encryptSecret(secret, id, key) {
  decodeBase32(secret); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv); cipher.setAAD(Buffer.from(`runtime-totp:${id}`));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function decryptSecret(account, key) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(account.mfa.iv, 'hex')); decipher.setAAD(Buffer.from(`runtime-totp:${account.id}`)); decipher.setAuthTag(Buffer.from(account.mfa.tag, 'hex'));
  try { return Buffer.concat([decipher.update(Buffer.from(account.mfa.data, 'hex')), decipher.final()]).toString('utf8'); }
  catch { reject('MFA_KEY_INVALID', 'MFA 密钥不可用', 503); }
}
function passwordDigest(password, salt) { return scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'); }

/** Offline provisioning is deliberately absent from the public HTTP API. */
export function bootstrapAccount(store, input, options = {}) {
  if (!identifier(input.id) || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 120 || typeof input.password !== 'string' || input.password.length < 14 || input.password.length > 1024 || !Array.isArray(input.roles) || !input.roles.length || input.roles.some(role => !identifier(role))) reject('INVALID_ACCOUNT', '具名账户需要有效 ID、姓名、角色及至少 14 字符密码');
  const salt = randomBytes(32).toString('hex');
  const account = { id: input.id, displayName: input.displayName.trim(), roles: [...new Set(input.roles)], active: true, passwordSalt: salt, passwordHash: passwordDigest(input.password, salt), mfa: encryptSecret(input.totpSecret, input.id, options.mfaKey), lastTotpCounter: -1, version: 0, credentialsRequired: false, revokedAt: null };
  return store.transact(state => {
    if (subjectWithdrawn(state, account.id)) reject('ACCOUNT_REVOKED', '永久撤销的账户 ID 不能重新配置', 403);
    if (account.id.startsWith('participant:') || state.modules.participants?.subjects.some(value => value.id === account.id)) reject('SUBJECT_CONFLICT', 'Participant and named-account identities must be distinct', 409);
    if (state.modules.auth.accounts.some(value => value.id === account.id)) reject('ACCOUNT_EXISTS', '账户已存在', 409);
    state.modules.auth.accounts.push(account);
    appendAudit(state, { id: 'system:bootstrap', sessionId: null }, 'account.bootstrap', { targetId: account.id }, epoch(options.now));
    return { id: account.id, displayName: account.displayName, roles: account.roles };
  });
}

const accountView = account => ({ id: account.id, displayName: account.displayName, roles: [...account.roles], active: account.active, version: account.version, credentialsRequired: account.credentialsRequired, revokedAt: account.revokedAt });
function offlineOperator(options) {
  if (!identifier(options.operatorId)) reject('OFFLINE_OPERATOR_REQUIRED', '离线账户维护需要具名操作员 ID');
  return { id: options.operatorId, sessionId: null };
}
function invalidateAccountSessions(state, accountId, now) {
  for (const session of state.modules.auth.sessions) if (session.subjectId === accountId) { session.revokedAt = now; session.tokenHash = hash(`revoked:${randomUUID()}`); }
  for (const [key, entry] of Object.entries(state.idempotency)) if (entry.subjectId === accountId) delete state.idempotency[key];
}

/** Host-level database write access is the trust boundary, never an HTTP principal or MFA claim. */
export function inspectAccountsOffline(store, options = {}) {
  offlineOperator(options);
  return store.read().modules.auth.accounts.map(accountView);
}

/** Audited local-provider maintenance. Secret inputs never enter generic replay or audit storage. */
export function maintainAccountOffline(store, input, options = {}) {
  const operator = offlineOperator(options), now = epoch(options.now);
  const fields = { credentials: ['password', 'totpSecret'], roles: ['roles'], status: ['active'], 'revoke-sessions': [] };
  if (!record(input) || !Object.hasOwn(fields, input.action) || !identifier(input.accountId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !Number.isSafeInteger(now) || now < 0 || Object.keys(input).some(key => !['action', 'accountId', 'expectedVersion', ...fields[input.action]].includes(key))) reject('INVALID_ACCOUNT_MAINTENANCE', '无效账户维护参数');
  const passwordPresent = Object.hasOwn(input, 'password'), totpPresent = Object.hasOwn(input, 'totpSecret');
  if (input.action === 'credentials' && (!passwordPresent && !totpPresent || passwordPresent && (typeof input.password !== 'string' || input.password.length < 14 || input.password.length > 1024))) reject('INVALID_ACCOUNT_MAINTENANCE', '凭据维护需要新密码或 TOTP 密钥，密码至少 14 字符');
  if (totpPresent) decodeBase32(input.totpSecret);
  if (input.action === 'roles' && (!Array.isArray(input.roles) || !input.roles.length || input.roles.some(role => !identifier(role)))) reject('INVALID_ACCOUNT_MAINTENANCE', '需要非空的有效角色列表');
  if (input.action === 'status' && typeof input.active !== 'boolean') reject('INVALID_ACCOUNT_MAINTENANCE', '账户状态必须为布尔值');
  return store.transact(state => {
    const account = state.modules.auth.accounts.find(value => value.id === input.accountId);
    if (!account) reject('ACCOUNT_NOT_FOUND', '账户不存在', 404);
    if (account.version !== input.expectedVersion) reject('ACCOUNT_VERSION_CONFLICT', '账户版本已变化，请重新读取后再操作', 409);
    if (account.revokedAt !== null || subjectWithdrawn(state, account.id)) reject('ACCOUNT_REVOKED', '永久撤销或已撤回隐私同意的账户不能维护', 403);
    if (account.version === Number.MAX_SAFE_INTEGER) reject('ACCOUNT_VERSION_CONFLICT', '账户版本已达到上限', 409);
    if (input.action === 'credentials') {
      if (account.credentialsRequired && (!passwordPresent || !totpPresent)) reject('ACCOUNT_CREDENTIALS_REQUIRED', '恢复后的账户需要同时配置新密码及 TOTP 密钥');
      if (passwordPresent) { const salt = randomBytes(32).toString('hex'); account.passwordSalt = salt; account.passwordHash = passwordDigest(input.password, salt); }
      if (totpPresent) {
        let sameSecret = false;
        if (account.mfa) {
          try { sameSecret = equal(effectiveTotpKey(decryptSecret(account, options.mfaKey)), effectiveTotpKey(input.totpSecret)); }
          catch (error) { if (!(error instanceof RuntimeError) || error.code !== 'MFA_KEY_INVALID' || !passwordPresent) throw error; }
        }
        account.mfa = encryptSecret(input.totpSecret, account.id, options.mfaKey);
        if (!sameSecret) account.lastTotpCounter = -1;
      }
      account.credentialsRequired = false;
      delete state.modules.auth.failures[hash(account.id)];
    } else if (input.action === 'roles') account.roles = [...new Set(input.roles)];
    else if (input.action === 'status') account.active = input.active;
    invalidateAccountSessions(state, account.id, now);
    account.version++;
    appendAudit(state, operator, `account.${input.action}`, { targetId: account.id }, now);
    return accountView(account);
  });
}

export function login(store, input, options = {}) {
  encryptionKey(options.mfaKey);
  if (!identifier(input.accountId) || typeof input.password !== 'string' || input.password.length > 1024 || typeof input.code !== 'string') reject('INVALID_CREDENTIALS', '账号、密码或双重验证码不正确', 401);
  const now = epoch(options.now);
  const result = store.transact(state => {
    const auth = state.modules.auth;
    for (const [key, failure] of Object.entries(auth.failures)) if (failure.until <= now) delete auth.failures[key];
    const failKey = hash(input.accountId); const failure = auth.failures[failKey];
    if (failure?.count >= 8 && failure.until > now) return { denied: true, limited: true };
    // One bounded global bucket stops random account IDs from bypassing account rate limits.
    if (auth.failures.global?.count >= 100 && auth.failures.global.until > now) return { denied: true, limited: true };
    const account = auth.accounts.find(value => value.id === input.accountId);
    const digest = passwordDigest(input.password, account?.passwordSalt ?? '0'.repeat(64));
    let acceptedCounter = -1;
    if (account?.active && !account.credentialsRequired && account.revokedAt === null && !subjectWithdrawn(state, account.id) && equal(digest, account.passwordHash) && /^\d{6}$/.test(input.code)) {
      const secret = decryptSecret(account, options.mfaKey);
      for (const step of [-1, 0, 1]) {
        const counter = Math.floor(now / 30_000) + step;
        if (counter > account.lastTotpCounter && equal(totpCode(secret, counter * 30_000), input.code)) acceptedCounter = counter;
      }
    }
    if (acceptedCounter < 0) {
      if (Object.keys(auth.failures).length < 1001 || failure) auth.failures[failKey] = { count: (failure?.count ?? 0) + 1, until: failure?.until ?? now + 15 * 60_000 };
      auth.failures.global = { count: (auth.failures.global?.count ?? 0) + 1, until: auth.failures.global?.until ?? now + 15 * 60_000 };
      return { denied: true };
    }
    delete auth.failures[failKey]; account.lastTotpCounter = acceptedCounter;
    auth.sessions = auth.sessions.filter(value => value.expiresAt > now && value.revokedAt === null);
    const token = randomBytes(32).toString('base64url');
    const session = { id: randomUUID(), subjectId: account.id, tokenHash: hash(token), issuedAt: now, expiresAt: now + 8 * 60 * 60_000, idleExpiresAt: now + 30 * 60_000, revokedAt: null };
    auth.sessions.push(session);
    appendAudit(state, { id: account.id, sessionId: session.id }, 'session.login', { targetId: session.id }, now);
    return { token, expiresAt: session.expiresAt, principal: { id: account.id, displayName: account.displayName, roles: [...account.roles], sessionId: session.id, mfa: true } };
  });
  if (result.denied) reject(result.limited ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS', '账号、密码或双重验证码不正确', result.limited ? 429 : 401);
  return result;
}

/** Must run inside the same synchronous transaction as a protected operation. */
export function authenticate(state, token, options = {}) {
  if (typeof token === 'string' && token.startsWith('ps_')) return authenticateParticipant(state, token, options);
  const now = epoch(options.now);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) reject('UNAUTHENTICATED', '需要有效会话', 401);
  const tokenHash = hash(token), auth = state.modules.auth;
  const session = auth.sessions.find(value => equal(value.tokenHash, tokenHash));
  if (!session || session.revokedAt !== null || session.expiresAt <= now || session.idleExpiresAt <= now) reject('UNAUTHENTICATED', '会话已失效或被撤销', 401);
  const account = auth.accounts.find(value => value.id === session.subjectId && value.active);
  if (!account || account.credentialsRequired || account.revokedAt !== null || subjectWithdrawn(state, account.id)) reject('UNAUTHENTICATED', '账户不可用', 401);
  session.idleExpiresAt = Math.min(now + 30 * 60_000, session.expiresAt);
  return { id: account.id, displayName: account.displayName, roles: [...account.roles], sessionId: session.id, mfa: true };
}
function subjectWithdrawn(state, id) {
  return state.modules.auth?.revokedSubjectIds.includes(id) || state.modules.lifecycle?.subjects?.[id]?.withdrawnAt != null || state.modules.participants?.subjects.some(subject => subject.id === id && subject.revokedAt !== null);
}

function synchronous(result) {
  if (result?.then) { Promise.resolve(result).catch(() => {}); reject('ASYNC_PROVIDER', 'Identity provider hooks must run synchronously inside the transaction', 500); }
  return result;
}

function providerHook(provider, name, state, ...args) {
  const selected = provider ?? localIdentityProvider;
  if (typeof selected?.[name] !== 'function') reject('IDENTITY_PROVIDER_HOOK_REQUIRED', `Identity provider requires a synchronous ${name} hook`, 503);
  return synchronous(selected[name](state, ...args));
}

/** Authentication and the protected operation share one rollback boundary. */
export function authenticateIdentity(state, token, options = {}) {
  const principal = providerHook(options.provider, 'authenticate', state, token, { now: epoch(options.now), participantsConfig: options.participantsConfig });
  if (!principal || !identifier(principal.id) || (principal.subjectId !== undefined && principal.subjectId !== principal.id) ||
    (principal.assurance === 'invitation' && !identifier(principal.sessionId)) || subjectWithdrawn(state, principal.id)) reject('UNAUTHENTICATED', 'Identity is unavailable or withdrawn', 401);
  return principal;
}

function localRevokeSession(state, principal, options = {}) {
  const targetId = options.sessionId ?? principal.sessionId;
  const session = [...(state.modules.auth?.sessions ?? []), ...(state.modules.participants?.sessions ?? [])].find(value => value.id === targetId);
  if (!session) reject('NOT_FOUND', '会话不存在', 404);
  if (session.subjectId !== principal.id) requirePermission(principal, 'accounts:manage', options.policy);
  session.revokedAt = epoch(options.now); session.tokenHash = hash(`revoked:${randomUUID()}`);
  return { revoked: true, sessionId: targetId };
}

function localRevokeSubject(state, subjectId, options = {}) {
  const now = epoch(options.now);
  if (state.modules.auth && !state.modules.auth.revokedSubjectIds.includes(subjectId)) state.modules.auth.revokedSubjectIds.push(subjectId);
  for (const account of state.modules.auth?.accounts ?? []) if (account.id === subjectId) {
    account.active = false;
    if (account.revokedAt === null) { account.revokedAt = now; account.version++; }
    invalidateAccountSessions(state, account.id, now);
  }
  if (state.modules.participants) revokeParticipantSubject(state, subjectId, { now });
  return { revoked: true, subjectId };
}

function localInvalidateAll(state) {
  if (state.modules.auth) state.modules.auth.sessions = [];
  if (state.modules.participants) { state.modules.participants.sessions = []; state.modules.participants.invitations = []; }
  return { credentialsInvalidated: true };
}

export const localIdentityProvider = Object.freeze({
  authenticate,
  revokeSession: localRevokeSession,
  revokeSubject: localRevokeSubject,
  invalidateAll: localInvalidateAll,
  prepareRestore: localInvalidateAll,
});

export function revokeIdentitySession(state, principal, options = {}) {
  return providerHook(options.provider, 'revokeSession', state, principal, { sessionId: options.sessionId ?? principal.sessionId, now: epoch(options.now), policy: options.policy });
}
export function revokeIdentitySubject(state, subjectId, options = {}) {
  if (!identifier(subjectId)) reject('INVALID_SUBJECT', 'A valid subject ID is required');
  return providerHook(options.provider, 'revokeSubject', state, subjectId, { now: epoch(options.now) });
}
export function invalidateIdentityCredentials(state, options = {}) {
  return providerHook(options.provider, 'invalidateAll', state, { now: epoch(options.now) });
}
export function prepareIdentityRestore(state, options = {}) {
  const auth = state.modules.auth, now = epoch(options.now);
  if (auth?.accounts.length && !Array.isArray(options.revokedSubjectIds)) reject('ACCOUNT_RECONCILIATION_REQUIRED', '恢复具名账户需要核对当前永久撤销 ID 清单');
  for (const [name, code] of [['revokedSubjectIds', 'INVALID_REVOCATION_REGISTER'], ['withdrawnSubjectIds', 'INVALID_WITHDRAWAL_REGISTER']]) {
    const value = options[name];
    if (value !== undefined && (!Array.isArray(value) || value.some(id => !identifier(id)))) reject(code, '撤销清单必须是有效主体 ID 数组');
  }
  const revoked = new Set([...(auth?.revokedSubjectIds ?? []), ...(options.revokedSubjectIds ?? []), ...(options.withdrawnSubjectIds ?? [])]);
  for (const account of auth?.accounts ?? []) if (account.revokedAt !== null || subjectWithdrawn(state, account.id)) revoked.add(account.id);
  const result = providerHook(options.provider, 'prepareRestore', state, { ...options, now, provider: undefined });
  for (const id of state.modules.auth?.revokedSubjectIds ?? []) revoked.add(id);
  if (state.modules.auth) state.modules.auth.revokedSubjectIds = [...revoked];
  for (const account of state.modules.auth?.accounts ?? []) {
    account.passwordSalt = null; account.passwordHash = null; account.mfa = null;
    account.credentialsRequired = true; account.lastTotpCounter = -1; account.version++;
    if (revoked.has(account.id) || subjectWithdrawn(state, account.id)) { account.active = false; account.revokedAt ??= now; }
  }
  if (state.modules.auth) state.modules.auth.sessions = [];
  return result;
}

export function requirePermission(principal, permission, policy = defaultRolePermissions, options = {}) {
  const required = Array.isArray(permission) ? permission : [permission], invitation = principal?.assurance === 'invitation';
  const selfAssurance = invitation && options.assurance === 'invitation' && required.includes('lifecycle:self');
  if ((invitation ? !selfAssurance : principal?.mfa !== true) || !identifier(principal.id) || !Array.isArray(principal.roles) || principal.roles.some(role => !identifier(role))) reject('UNAUTHENTICATED', '需要符合操作要求的已验证身份', 401);
  const permissions = principal.roles.flatMap(role => Object.hasOwn(policy, role) && Array.isArray(policy[role]) ? policy[role] : []);
  if (!(invitation ? permissions.includes('lifecycle:self') : required.some(value => permissions.includes(value)))) reject('FORBIDDEN', '当前角色无权执行此操作', 403);
  return principal;
}

/** Audit accepts identifiers only; callers cannot accidentally archive private request bodies. */
export function appendAudit(state, principal, action, result = {}, now = Date.now()) {
  const targetId = [result.entityId, result.recordId, result.targetId, result.id].find(identifier) ?? null;
  state.audit.push({ id: randomUUID(), subjectId: principal.id, actorId: principal.id, sessionId: principal.sessionId ?? null, action, targetId, at: now });
}

export function executeOperation(state, principal, options, handler) {
  const now = epoch(options.now), { action, key, input } = options;
  if (!identifier(action)) reject('INVALID_ACTION', '无效操作');
  let id, fingerprint;
  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) reject('INVALID_IDEMPOTENCY_KEY', '幂等键需要 8–200 字符');
    id = hash(JSON.stringify([principal.id, action, key])); fingerprint = hash(JSON.stringify(canonical(input ?? null)));
    const previous = state.idempotency[id];
    if (previous) {
      if (previous.fingerprint !== fingerprint) reject('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同输入', 409);
      return structuredClone(previous.result);
    }
  }
  const result = handler(state, principal);
  if (result?.then) reject('ASYNC_TRANSACTION', '事务回调必须同步', 500);
  const safeResult = result ?? null;
  if (options.audit !== false) appendAudit(state, principal, action, record(safeResult) ? safeResult : {}, now);
  if (id && !safeResult?.nonReplayable) state.idempotency[id] = { subjectId: principal.id, action, keyHash: hash(key), fingerprint, result: structuredClone(safeResult), createdAt: now };
  return safeResult;
}
export function executeAuthorized(store, token, options, handler) {
  return store.transact(state => {
    const principal = authenticateIdentity(state, token, options);
    requirePermission(principal, options.permission, options.policy, { assurance: options.assurance });
    if (options.authorize) synchronous(options.authorize(principal, state));
    return executeOperation(state, principal, options, handler);
  });
}
export function readAuthorized(store, token, options, reader) {
  return store.transact(state => {
    const principal = authenticateIdentity(state, token, options);
    requirePermission(principal, options.permission, options.policy, { assurance: options.assurance });
    if (options.authorize) synchronous(options.authorize(principal, state));
    return reader(state, principal);
  });
}
export function revokeSession(store, token, options = {}) {
  return store.transact(state => {
    const principal = authenticateIdentity(state, token, options), targetId = options.sessionId ?? principal.sessionId;
    const result = revokeIdentitySession(state, principal, { ...options, sessionId: targetId });
    appendAudit(state, principal, 'session.revoke', { targetId }, epoch(options.now));
    return result ?? { revoked: true, sessionId: targetId };
  });
}
