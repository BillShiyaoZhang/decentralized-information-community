import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { authenticateIdentity, loadRuntimeConfig, openRuntime } from '../packages/runtime/index.mjs';

const run = promisify(execFile), repository = resolve(import.meta.dirname, '..');
const prefix = 'community-provider-config-', cliPath = join(repository, 'packages/runtime/cli.mjs');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, clean: async () => {
    const actual = await realpath(root), parent = await realpath(tmpdir()), rel = relative(parent, actual);
    assert.ok(basename(actual).startsWith(prefix) && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
    await rm(actual, { recursive: true, force: true });
  } };
}

async function prepareConsumer(root, name, { token = randomBytes(32).toString('base64url'), missing, asynchronous } = {}) {
  const consumer = join(root, name);
  await cp(join(repository, 'examples/runtime'), consumer, { recursive: true });
  const configPath = join(consumer, 'runtime.config.json'), config = await json(configPath);
  Object.assign(config, { communityId: 'custom-provider-consumer', identityProvider: 'identity-provider.mjs', extensions: ['identity-state.mjs'] });
  delete config.maintenanceIntervalMs;
  await writeJson(configPath, config);
  const module = `export default {
    name: 'external-identity', schemaVersion: 1,
    initialState: () => ({ sessions: [{ id: 'synthetic-device', subjectId: 'synthetic-subject', tokenHash: '${createHash('sha256').update(token).digest('hex')}' }], touches: 0, restores: 0, reviewed: [] }),
    validate(value) { if (!Array.isArray(value.sessions) || !Number.isSafeInteger(value.touches) || !Number.isSafeInteger(value.restores) || !Array.isArray(value.reviewed)) throw new Error('Invalid synthetic provider state'); }
  };\n`;
  const provider = `import { createHash } from 'node:crypto';
    import { RuntimeError } from ${JSON.stringify(pathToFileURL(join(repository, 'packages/runtime/errors.mjs')).href)};
    const provider = {
      authenticate(state, token) {
        const data = state.modules['external-identity']; data.touches++;
        const session = data.sessions.find(value => value.tokenHash === createHash('sha256').update(token).digest('hex'));
        if (!session) throw new RuntimeError('UNAUTHENTICATED', 'Synthetic session unavailable', 401);
        return { id: session.subjectId, subjectId: session.subjectId, sessionId: session.id, roles: ['participant'], assurance: 'invitation', mfa: false, eligibility: { adult: true, eligible: true } };
      },
      revokeSession(state, principal, { sessionId }) {
        const data = state.modules['external-identity'];
        const session = data.sessions.find(value => value.id === sessionId);
        if (!session || session.subjectId !== principal.id) throw new RuntimeError('FORBIDDEN', 'Session belongs to another subject', 403);
        data.sessions = data.sessions.filter(value => value.id !== sessionId); return { revoked: true };
      },
      revokeSubject(state, subjectId) { const data = state.modules['external-identity']; data.sessions = data.sessions.filter(value => value.subjectId !== subjectId); return { revoked: true }; },
      prepareRestore(state, options) { const data = state.modules['external-identity']; data.sessions = []; data.restores++; data.reviewed = options.withdrawnSubjectIds ?? []; },
    };
    ${missing ? `delete provider[${JSON.stringify(missing)}];` : ''}
    ${asynchronous ? `const synchronous = provider[${JSON.stringify(asynchronous)}]; provider[${JSON.stringify(asynchronous)}] = (...args) => Promise.resolve(synchronous(...args));` : ''}
    export default provider;\n`;
  await writeFile(join(consumer, 'identity-state.mjs'), module);
  await writeFile(join(consumer, 'identity-provider.mjs'), provider);
  return { consumer, configPath, config, token };
}

test('runtime config loads a consumer-owned identity provider and its persistent extension state', async () => {
  const temp = await temporary();
  try {
    const fixture = await prepareConsumer(temp.root, 'consumer');
    const loaded = await loadRuntimeConfig({ root: fixture.consumer });
    assert.equal(loaded.root, fixture.consumer); assert.equal(loaded.config.identityProvider, 'identity-provider.mjs');
    const runtime = await openRuntime({ root: fixture.consumer, seed: false });
    try {
      assert.ok(['authenticate', 'revokeSession', 'revokeSubject', 'prepareRestore'].every(hook => typeof runtime.identityProvider[hook] === 'function'));
      const principal = runtime.store.transact(state => authenticateIdentity(state, fixture.token, { provider: runtime.identityProvider, participantsConfig: runtime.business.participants }));
      assert.equal(principal.id, 'synthetic-subject'); assert.equal(principal.mfa, false); assert.equal(principal.assurance, 'invitation');
      assert.equal(runtime.store.read().modules['external-identity'].touches, 1);
    } finally { runtime.store.close(); }
    const reopened = await openRuntime({ root: fixture.consumer, seed: false });
    try { assert.equal(reopened.store.read().modules['external-identity'].touches, 1); }
    finally { reopened.store.close(); }
  } finally { await temp.clean(); }
});

test('runtime provider configuration rejects escaping paths, malformed hooks and asynchronous authentication', async () => {
  const temp = await temporary();
  try {
    for (const [index, patch] of [{ identityProvider: '../outside.mjs' }, { identityProvider: join(temp.root, 'absolute.mjs') }, { extensions: ['../outside.mjs'] }, { identityProvider: 42 }].entries()) {
      const fixture = await prepareConsumer(temp.root, `escape-${index}`);
      await writeJson(fixture.configPath, { ...fixture.config, ...patch });
      await assert.rejects(openRuntime({ root: fixture.consumer }), { code: 'INVALID_CONFIG' });
    }
    for (const missing of ['authenticate', 'revokeSession', 'revokeSubject', 'prepareRestore']) {
      const fixture = await prepareConsumer(temp.root, `missing-${missing}`, { missing });
      await assert.rejects(openRuntime({ root: fixture.consumer }), { code: 'INVALID_IDENTITY_PROVIDER' });
    }
    const malformed = await prepareConsumer(temp.root, 'malformed');
    await writeFile(join(malformed.consumer, 'identity-provider.mjs'), 'export default { authenticate: true, revokeSession: null, revokeSubject: 7, prepareRestore: [] };\n');
    await assert.rejects(openRuntime({ root: malformed.consumer }), { code: 'INVALID_IDENTITY_PROVIDER' });
    const asynchronous = await prepareConsumer(temp.root, 'asynchronous', { asynchronous: 'authenticate' });
    const runtime = await openRuntime({ root: asynchronous.consumer, seed: false });
    try {
      const before = runtime.store.read();
      assert.throws(() => runtime.store.transact(state => authenticateIdentity(state, asynchronous.token, { provider: runtime.identityProvider, participantsConfig: runtime.business.participants })), { code: 'ASYNC_PROVIDER' });
      assert.deepEqual(runtime.store.read(), before, 'Even the synchronous portion of a rejected async provider hook rolls back');
    } finally { runtime.store.close(); }
  } finally { await temp.clean(); }
});

test('standard CLI forwards custom identity through HTTP logout and reviewed backup restore', { timeout: 45000 }, async () => {
  const temp = await temporary(), children = new Set();
  const environment = { ...process.env, RUNTIME_MFA_KEY: randomBytes(32).toString('hex'), RUNTIME_KEYRING: JSON.stringify({ activeVersion: 'v1', keys: { v1: randomBytes(32).toString('hex') } }), HOST: '127.0.0.1', PORT: '0' };
  delete environment.RUNTIME_CONFIG;
  const cli = (consumer, args) => run(process.execPath, [cliPath, ...args], { cwd: consumer, env: environment, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  async function start(consumer) {
    const child = spawn(process.execPath, [cliPath, 'start'], { cwd: consumer, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = '', stderr = '';
    child.stderr.on('data', value => { stderr += value.toString(); });
    const base = await new Promise((resolveBase, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI did not start: ${stderr}`)), 10000);
      const finish = (error, url) => { clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); error ? reject(error) : resolveBase(url); };
      const onError = error => finish(error), onExit = code => finish(new Error(`CLI exited ${code}: ${stderr}`));
      child.once('error', onError); child.once('exit', onExit);
      child.stdout.on('data', value => { stdout += value.toString(); const match = stdout.match(/Community runtime listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) finish(null, match[1]); });
    });
    return { child, base };
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
    const ended = new Promise((resolveExit, reject) => { const timer = setTimeout(() => reject(new Error('CLI failed to stop')), 5000); child.once('exit', () => { clearTimeout(timer); resolveExit(); }); });
    child.kill('SIGTERM'); await ended; children.delete(child);
  }
  const get = (base, path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  const post = (base, path, value, token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': randomBytes(32).toString('base64url') }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
  const readOk = async response => { const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  try {
    const source = await prepareConsumer(temp.root, 'source');
    let server = await start(source.consumer);
    assert.equal((await readOk(await get(server.base, '/api/auth/me', source.token))).assurance, 'invitation');
    assert.deepEqual(await readOk(await get(server.base, '/api/private/self', source.token)), []);
    const grant = await readOk(await post(server.base, '/api/private/command', { action: 'consent', type: 'private_intake', version: '2026-09', accepted: true }, source.token));
    await readOk(await post(server.base, '/api/private/command', { action: 'create', id: 'provider-intake', type: 'private_intake', consentEpoch: grant.consentEpoch, payload: { message: 'CUSTOM_PROVIDER_PRIVATE_PAYLOAD' } }, source.token));
    assert.equal((await readOk(await get(server.base, '/api/private/self', source.token))).length, 1);
    await stop(server.child);
    const backupPath = join(temp.root, 'private-backup.json');
    await cli(source.consumer, ['backup', backupPath]);
    assert.ok(!(await readFile(backupPath, 'utf8')).includes('CUSTOM_PROVIDER_PRIVATE_PAYLOAD'));
    server = await start(source.consumer);
    await readOk(await post(server.base, '/api/auth/logout', {}, source.token));
    assert.equal((await get(server.base, '/api/auth/me', source.token)).status, 401);
    await stop(server.child);
    const target = await prepareConsumer(temp.root, 'restored', { token: source.token });
    const reviewPath = join(temp.root, 'withdrawal-review.json');
    await writeJson(reviewPath, { withdrawnSubjectIds: ['synthetic-subject'] });
    const result = await cli(target.consumer, ['restore', backupPath, reviewPath]);
    assert.equal(JSON.parse(result.stdout).sessionsInvalidated, true);
    const restored = await openRuntime({ root: target.consumer, seed: false });
    try {
      const state = restored.store.read();
      assert.equal(state.modules['external-identity'].restores, 1);
      assert.deepEqual(state.modules['external-identity'].reviewed, ['synthetic-subject']);
      assert.deepEqual(state.modules['external-identity'].sessions, []);
      assert.equal(state.modules.lifecycle.records['provider-intake'].payload, null);
      assert.equal(state.modules.lifecycle.records['provider-intake'].subjectId, null);
      assert.ok(state.modules.lifecycle.subjects['synthetic-subject'].withdrawnAt !== null);
    } finally { restored.store.close(); }
    server = await start(target.consumer);
    assert.equal((await get(server.base, '/api/auth/me', source.token)).status, 401);
    await stop(server.child);
  } finally {
    for (const child of children) await stop(child);
    await temp.clean();
  }
});
