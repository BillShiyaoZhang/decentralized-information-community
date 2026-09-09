import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { RuntimeError } from './errors.mjs';

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
  name: 'auth', schemaVersion: 1,
  initialState: () => ({ accounts: [], sessions: [], failures: {} }),
  validate(data) {
    if (!record(data) || !Array.isArray(data.accounts) || !Array.isArray(data.sessions) || !record(data.failures)) reject('INVALID_AUTH', '无效身份模块');
    const ids = new Set();
    for (const account of data.accounts) {
      if (!identifier(account.id) || ids.has(account.id) || typeof account.displayName !== 'string' || !account.displayName.trim() || account.displayName.length > 120 || !Array.isArray(account.roles) || account.roles.some(role => !identifier(role)) || typeof account.active !== 'boolean' || !/^[a-f0-9]{64}$/.test(account.passwordSalt) || !/^[a-f0-9]{128}$/.test(account.passwordHash) || !record(account.mfa) || !Number.isSafeInteger(account.lastTotpCounter)) reject('INVALID_AUTH', '无效具名账户');
      if (!/^[a-f0-9]{24}$/.test(account.mfa.iv) || !/^[a-f0-9]{32}$/.test(account.mfa.tag) || !/^[a-f0-9]+$/.test(account.mfa.data)) reject('INVALID_AUTH', '无效加密 MFA 凭据');
      ids.add(account.id);
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
  const account = { id: input.id, displayName: input.displayName.trim(), roles: [...new Set(input.roles)], active: true, passwordSalt: salt, passwordHash: passwordDigest(input.password, salt), mfa: encryptSecret(input.totpSecret, input.id, options.mfaKey), lastTotpCounter: -1 };
  return store.transact(state => {
    if (state.modules.auth.accounts.some(value => value.id === account.id)) reject('ACCOUNT_EXISTS', '账户已存在', 409);
    state.modules.auth.accounts.push(account);
    appendAudit(state, { id: 'system:bootstrap', sessionId: null }, 'account.bootstrap', { targetId: account.id }, epoch(options.now));
    return { id: account.id, displayName: account.displayName, roles: account.roles };
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
    if (account?.active && equal(digest, account.passwordHash) && /^\d{6}$/.test(input.code)) {
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
  const now = epoch(options.now);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) reject('UNAUTHENTICATED', '需要有效会话', 401);
  const tokenHash = hash(token), auth = state.modules.auth;
  const session = auth.sessions.find(value => equal(value.tokenHash, tokenHash));
  if (!session || session.revokedAt !== null || session.expiresAt <= now || session.idleExpiresAt <= now) reject('UNAUTHENTICATED', '会话已失效或被撤销', 401);
  const account = auth.accounts.find(value => value.id === session.subjectId && value.active);
  if (!account) reject('UNAUTHENTICATED', '账户不可用', 401);
  session.idleExpiresAt = Math.min(now + 30 * 60_000, session.expiresAt);
  return { id: account.id, displayName: account.displayName, roles: [...account.roles], sessionId: session.id, mfa: true };
}
export const localIdentityProvider = Object.freeze({ authenticate });

export function requirePermission(principal, permission, policy = defaultRolePermissions) {
  if (principal?.mfa !== true || !identifier(principal.id) || !Array.isArray(principal.roles) || principal.roles.some(role => !identifier(role))) reject('UNAUTHENTICATED', '需要已验证的具名 MFA 身份', 401);
  const permissions = principal.roles.flatMap(role => Object.hasOwn(policy, role) && Array.isArray(policy[role]) ? policy[role] : []);
  const required = Array.isArray(permission) ? permission : [permission];
  if (!required.some(value => permissions.includes(value))) reject('FORBIDDEN', '当前角色无权执行此操作', 403);
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
    const principal = (options.provider ?? localIdentityProvider).authenticate(state, token, { now: epoch(options.now) });
    if (principal?.then) reject('ASYNC_PROVIDER', '身份验证器必须在事务内同步检查有效身份与撤销状态', 500);
    requirePermission(principal, options.permission, options.policy);
    return executeOperation(state, principal, options, handler);
  });
}
export function readAuthorized(store, token, options, reader) {
  return store.transact(state => {
    const principal = (options.provider ?? localIdentityProvider).authenticate(state, token, { now: epoch(options.now) });
    if (principal?.then) reject('ASYNC_PROVIDER', '身份验证器必须同步', 500);
    requirePermission(principal, options.permission, options.policy);
    return reader(state, principal);
  });
}
export function revokeSession(store, token, options = {}) {
  return store.transact(state => {
    const principal = authenticate(state, token, options), targetId = options.sessionId ?? principal.sessionId;
    const session = state.modules.auth.sessions.find(value => value.id === targetId);
    if (!session) reject('NOT_FOUND', '会话不存在', 404);
    if (session.subjectId !== principal.id) requirePermission(principal, 'accounts:manage', options.policy);
    session.revokedAt = epoch(options.now);
    appendAudit(state, principal, 'session.revoke', { targetId }, epoch(options.now));
    return { revoked: true, sessionId: targetId };
  });
}
