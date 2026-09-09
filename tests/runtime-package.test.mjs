import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile), repository = resolve(import.meta.dirname, '..');
const example = join(repository, 'examples/runtime');
const prefix = 'community-runtime-consumer-';

async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
function isInside(root, path) { const part = relative(resolve(root), resolve(path)); return part !== '..' && !part.startsWith('..' + sep) && !resolve(path).startsWith('\\\\'); }
// Independent RFC 6238 calculation, using the RFC's 20-byte test key.
function codeAt(now, rawSecret = '12345678901234567890') {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', rawSecret).update(counter).digest(), offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
function base32(raw) {
  const bits = [...Buffer.from(raw)].map(byte => byte.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{1,5}/g).map(chunk => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}

test('packed governed runtime runs in an independent consumer, survives a synthetic compatible upgrade and restores reviewed content', { timeout: 60000 }, async () => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run this acceptance test through npm test');
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  const children = new Set();
  const environment = { ...process.env, RUNTIME_MFA_KEY: randomBytes(32).toString('hex'), RUNTIME_KEYRING: JSON.stringify({ activeVersion: 'v1', keys: { v1: randomBytes(32).toString('hex') } }), RUNTIME_OPERATOR_ID: 'external-reviewed-operator', HOST: '127.0.0.1', PORT: '0' };
  const cache = join(temporary, 'npm-cache');
  const npmRun = (args, cwd) => run(process.execPath, [npm, ...args, '--cache', cache], { cwd, env: environment, timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const cliPath = consumer => join(consumer, 'node_modules/@information-community/runtime/cli.mjs');
  const cli = (consumer, args) => run(process.execPath, [cliPath(consumer), ...args], { cwd: consumer, env: environment, timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const json = async path => JSON.parse(await readFile(path, 'utf8'));

  async function start(consumer) {
    const child = spawn(process.execPath, [cliPath(consumer), 'start'], { cwd: consumer, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', errorOutput = '';
    child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
    const base = await new Promise((resolveBase, reject) => {
      const timer = setTimeout(() => reject(new Error(`Installed runtime did not start: ${errorOutput}`)), 10000);
      const finish = (error, url) => { clearTimeout(timer); child.removeListener('error', onError); child.removeListener('exit', onExit); error ? reject(error) : resolveBase(url); };
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Installed runtime exited ${code}: ${errorOutput}`));
      child.once('error', onError); child.once('exit', onExit);
      child.stdout.on('data', chunk => { output += chunk.toString(); const match = output.match(/Community runtime listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) finish(null, match[1]); });
    });
    return { child, base };
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
    const ended = new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error('Installed runtime process failed to stop')), 5000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
    child.kill('SIGTERM'); await ended; children.delete(child);
  }
  const get = (base, path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
  const post = (base, path, input, token, key = 'external-consumer-publication') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}`, 'Idempotency-Key': key }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });

  try {
    const packs = [];
    for (const name of ['core', 'runtime']) {
      const packed = JSON.parse((await npmRun(['pack', `./packages/${name}`, '--json', '--ignore-scripts', '--pack-destination', temporary], repository)).stdout)[0];
      packs.push(packed);
      assert.ok(packed.files.some(file => file.path === 'package.json'));
      if (name === 'runtime') {
        assert.ok(packed.files.some(file => file.path === 'cli.mjs'));
        assert.ok(packed.files.some(file => file.path === 'http.mjs'));
        assert.ok(packed.files.every(file => !/^(?:examples|server|tests|content|\.runtime)\//.test(file.path)), 'The engine archive must not contain consumer data');
      }
    }
    async function prepareConsumer(name) {
      const consumer = join(temporary, name);
      await cp(example, consumer, { recursive: true });
      const initial = (await files(consumer)).map(path => relative(consumer, path).replaceAll('\\', '/'));
      assert.ok(initial.every(path => !/(?:^|\/)(?:server|packages|node_modules|src)\//.test(path)), 'Consumer starts with business JSON, UI and deployment declarations only');
      assert.ok(initial.every(path => /\.(?:json|html|yaml|md)$/.test(path) || (path.startsWith('ui/') && /\.(?:js|css|svg)$/.test(path)) || ['Dockerfile', '.dockerignore', '.gitignore'].includes(path)), 'Example must not copy the platform backend');
      await mkdir(join(consumer, 'vendor'));
      for (const packed of packs) await cp(join(temporary, packed.filename), join(consumer, 'vendor', packed.filename));
      await npmRun(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
      for (const name of ['core', 'runtime']) {
        const installed = join(consumer, 'node_modules/@information-community', name);
        assert.equal((await lstat(installed)).isSymbolicLink(), false);
        assert.ok(isInside(consumer, await realpath(installed)), 'Package must resolve within the external consumer');
      }
      return consumer;
    }
    const consumer = await prepareConsumer('consumer');
    const config = await json(join(consumer, 'runtime.config.json'));
    config.communityId = 'external-governed-community'; config.site.brand = '隔离消费测试社区';
    await writeFile(join(consumer, 'runtime.config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(consumer, 'ui/index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><title>自定义 UI</title><h1>Consumer-owned extension marker</h1></html>');
    const ownedFiles = ['runtime.config.json', 'business.json', 'content-profile.json', 'content.json', 'lifecycle.json', 'ui/index.html', 'ui/participate.html', 'ui/participate.js', 'ui/participate.css'];
    const ownedBytes = new Map(await Promise.all(ownedFiles.map(async file => [file, await readFile(join(consumer, file), 'utf8')])));
    for (const file of await files(join(consumer, 'node_modules/@information-community/runtime'))) if (file.endsWith('.mjs')) {
      const code = await readFile(file, 'utf8');
      assert.ok(!code.includes(repository) && !code.includes(repository.replaceAll('\\', '/')));
      assert.doesNotMatch(code, /(?:\.\.\/)+(?:core|server|packages|web)\//, `Installed file ${basename(file)} must not import adjacent repository sources`);
    }
    await cli(consumer, ['build']);
    for (const file of await files(join(consumer, 'dist'))) {
      const text = await readFile(file, 'utf8');
      assert.doesNotMatch(text, /privateEditorialNote|This private extension|legacy-answer-revision-17|原版证据/);
      assert.ok(!file.endsWith('content.json') && !file.endsWith('graph.json'));
    }
    await writeFile(join(consumer, 'private-account.json'), JSON.stringify({ id: 'external-reviewer', displayName: 'External reviewer', password: 'external-consumer-password-2026', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', roles: ['content_editor', 'content_reviewer'] }), { mode: 0o600 });
    const bootstrap = await cli(consumer, ['bootstrap', 'private-account.json']);
    assert.match(bootstrap.stdout, /external-reviewer/); assert.doesNotMatch(bootstrap.stdout, /external-consumer-password|GEZDGNBV/);
    assert.equal(JSON.parse((await cli(consumer, ['accounts'])).stdout)[0].version, 0);
    await writeFile(join(consumer, 'reviewed-eligibility.json'), JSON.stringify({ eligibility: { eligible: true, adult: true } }), { mode: 0o600 });
    const invitation = JSON.parse((await cli(consumer, ['invite', 'reviewed-eligibility.json'])).stdout);
    let server = await start(consumer);
    assert.match(await (await get(server.base, '/')).text(), /隔离消费测试社区/);
    assert.match(await (await get(server.base, '/extensions/index.html')).text(), /Consumer-owned extension marker/);
    assert.equal((await (await get(server.base, '/api/graph')).json()).nodes.length, 0);
    const login = await post(server.base, '/api/auth/login', { accountId: 'external-reviewer', password: 'external-consumer-password-2026', code: codeAt(Date.now()) });
    assert.equal(login.status, 200); const token = (await login.json()).token; assert.equal(typeof token, 'string');
    const published = await post(server.base, '/api/content/publish', { entityId: 'guide-answer', revisionId: 'answer-revision-17', expectedVersion: 0 }, token);
    assert.equal(published.status, 200, await published.clone().text());
    assert.equal((await published.json()).publicRevisionId, 'answer-revision-17');
    const rotatedPassword = 'external-consumer-rotated-password-2026', rotatedRaw = 'abcdefghijabcdefghij';
    await writeFile(join(consumer, 'credential-change.private.json'), JSON.stringify({ action: 'credentials', accountId: 'external-reviewer', expectedVersion: 0, password: rotatedPassword, totpSecret: base32(rotatedRaw) }), { mode: 0o600 });
    await assert.rejects(run(process.execPath, [cliPath(consumer), 'account', 'credential-change.private.json'], { cwd: consumer, env: { ...environment, RUNTIME_OPERATOR_ID: '' }, timeout: 15000, windowsHide: true }), error => error.stderr.includes('OFFLINE_OPERATOR_REQUIRED') && !error.stderr.includes(rotatedPassword));
    await writeFile(join(consumer, 'malformed.private.json'), '{"password":"SYNTHETIC_SECRET_MUST_NOT_APPEAR" broken}', { mode: 0o600 });
    await assert.rejects(cli(consumer, ['account', 'malformed.private.json']), error => error.stderr.includes('INVALID_JSON') && !error.stderr.includes('SYNTHETIC_SECRET_MUST_NOT_APPEAR'));
    assert.equal(JSON.parse((await cli(consumer, ['accounts'])).stdout)[0].version, 0);
    const rotation = await cli(consumer, ['account', 'credential-change.private.json']);
    const rotatedAccount = JSON.parse(rotation.stdout); assert.equal(rotatedAccount.id, 'external-reviewer'); assert.equal(rotatedAccount.version, 1);
    assert.ok(!rotation.stdout.includes(rotatedPassword) && !rotation.stdout.includes(base32(rotatedRaw)));
    await assert.rejects(cli(consumer, ['account', 'credential-change.private.json']), error => error.stderr.includes('ACCOUNT_VERSION_CONFLICT') && !error.stderr.includes(rotatedPassword));
    assert.equal((await get(server.base, '/api/auth/me', token)).status, 401);
    assert.equal((await post(server.base, '/api/auth/login', { accountId: 'external-reviewer', password: 'external-consumer-password-2026', code: codeAt(Date.now()) })).status, 401);
    assert.equal((await post(server.base, '/api/auth/login', { accountId: 'external-reviewer', password: rotatedPassword, code: codeAt(Date.now()) })).status, 401);
    const newLogin = await post(server.base, '/api/auth/login', { accountId: 'external-reviewer', password: rotatedPassword, code: codeAt(Date.now(), rotatedRaw) });
    assert.equal(newLogin.status, 200, await newLogin.clone().text()); const rotatedToken = (await newLogin.json()).token;
    const graph = await (await get(server.base, '/api/graph')).json(); assert.equal(graph.id, config.communityId); assert.equal(graph.nodes[0].id, 'guide-answer');
    const searched = await get(server.base, '/api/search?q=xjtlu'); assert.equal(searched.status, 200); assert.equal((await searched.json())[0].revisionId, 'answer-revision-17');
    const exported = await get(server.base, '/api/export'); assert.match(exported.headers.get('cache-control'), /no-store/); assert.doesNotMatch(await exported.text(), /privateEditorialNote|legacy-answer-revision-17/);
    for (const path of ['/content.json', '/private-account.json', '/.runtime/community.sqlite', '/data/graph.json/old']) assert.equal((await get(server.base, path)).status, 404, path);
    assert.match(await (await get(server.base, '/extensions/participate.html')).text(), /匿名隐私问题报告/);
    const redeemed = await post(server.base, '/api/participants/redeem', { token: invitation.token });
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const participant = (await redeemed.json()).token;
    assert.equal((await post(server.base, '/api/participants/redeem', { token: invitation.token })).status, 401);
    const consent = await post(server.base, '/api/private/command', { action: 'consent', type: 'private_intake', version: '2026-09', accepted: true }, participant, 'external-participant-consent');
    assert.equal(consent.status, 200, await consent.clone().text());
    const { consentEpoch } = await consent.json();
    const intake = await post(server.base, '/api/private/command', { action: 'create', type: 'private_intake', consentEpoch, payload: { message: 'External participant clue' } }, participant, 'external-participant-create');
    assert.equal(intake.status, 200, await intake.clone().text());
    assert.equal((await (await get(server.base, '/api/private/self', participant)).json()).length, 1);
    assert.ok([401, 403].includes((await get(server.base, '/api/private/list', participant)).status));
    const anonymous = await post(server.base, '/api/reports', { message: 'Synthetic privacy issue' }, undefined, randomBytes(32).toString('base64url'));
    assert.equal(anonymous.status, 200, await anonymous.clone().text());
    const { receipt } = await anonymous.json();
    assert.equal((await (await get(server.base, '/api/reports/status', receipt)).json()).status, 'submitted');
    await stop(server.child);
    server = await start(consumer);
    assert.equal((await (await get(server.base, '/api/revisions/answer-revision-17')).json()).id, 'guide-answer');
    assert.equal((await (await get(server.base, '/api/private/self', participant)).json()).length, 1);
    assert.equal((await post(server.base, '/api/private/command', { action: 'withdraw' }, participant)).status, 200);
    assert.equal((await get(server.base, '/api/auth/me', participant)).status, 401);
    await stop(server.child);
    await cli(consumer, ['backup', 'before-upgrade.private.json']);
    const before = await json(join(consumer, 'before-upgrade.private.json'));
    assert.equal(before.state.modules.auth.sessions.length, 1);
    assert.equal(before.state.modules.content.entities.find(value => value.id === 'guide-answer').externalId, 'd1-answer-17');
    assert.equal(before.state.audit.filter(value => value.action === 'content.publish').length, 1);
    assert.equal(before.state.audit.find(value => value.action === 'content.publish').actorId, 'external-reviewer');
    assert.equal(before.state.audit.find(value => value.action === 'account.credentials').actorId, 'external-reviewed-operator');
    assert.ok(!JSON.stringify(before.state.audit).includes(rotatedPassword) && !JSON.stringify(before.state.idempotency).includes(base32(rotatedRaw)));

    // The next patch archive is an intentionally synthetic compatible-upgrade fixture,
    // not a claim that a newer runtime release exists or has been published.
    const staged = join(temporary, 'synthetic-runtime-upgrade');
    await cp(join(consumer, 'node_modules/@information-community/runtime'), staged, { recursive: true });
    const upgradedManifest = await json(join(staged, 'package.json'));
    const [major, minor, patch] = upgradedManifest.version.split('.').map(Number);
    const upgradedVersion = `${major}.${minor}.${patch + 1}`;
    upgradedManifest.version = upgradedVersion;
    await writeFile(join(staged, 'package.json'), JSON.stringify(upgradedManifest, null, 2));
    const upgraded = JSON.parse((await npmRun(['pack', staged, '--json', '--ignore-scripts', '--pack-destination', temporary], temporary)).stdout)[0];
    await cp(join(temporary, upgraded.filename), join(consumer, 'vendor', upgraded.filename));
    await npmRun(['install', `./vendor/${upgraded.filename}`, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    assert.equal((await json(join(consumer, 'node_modules/@information-community/runtime/package.json'))).version, upgradedVersion);
    assert.equal((await lstat(join(consumer, 'node_modules/@information-community/runtime'))).isSymbolicLink(), false);
    for (const [file, bytes] of ownedBytes) assert.equal(await readFile(join(consumer, file), 'utf8'), bytes, `Package upgrade preserves consumer ${file}`);
    server = await start(consumer);
    assert.equal((await (await get(server.base, '/api/graph')).json()).nodes[0].revisionId, 'answer-revision-17');
    assert.match(await (await get(server.base, '/extensions/index.html')).text(), /Consumer-owned extension marker/);
    await stop(server.child);
    await cli(consumer, ['backup', 'after-upgrade.private.json']);
    const after = await json(join(consumer, 'after-upgrade.private.json'));
    assert.deepEqual(after.state.modules.content, before.state.modules.content);
    assert.deepEqual(after.state.audit, before.state.audit);

    const restoredConsumer = await prepareConsumer('restored-consumer');
    for (const [file, bytes] of ownedBytes) await writeFile(join(restoredConsumer, file), bytes);
    await cp(join(consumer, 'after-upgrade.private.json'), join(restoredConsumer, 'restore.private.json'));
    await writeFile(join(restoredConsumer, 'withdrawal-review.json'), JSON.stringify({ withdrawnSubjectIds: [invitation.subjectId], revokedSubjectIds: [invitation.subjectId] }));
    await cli(restoredConsumer, ['restore', 'restore.private.json', 'withdrawal-review.json']);
    await cli(restoredConsumer, ['backup', 'restored.private.json']);
    const restored = await json(join(restoredConsumer, 'restored.private.json'));
    assert.deepEqual(restored.state.modules.content, after.state.modules.content);
    assert.deepEqual(restored.state.modules.auth.sessions, []);
    assert.deepEqual(restored.state.idempotency, {});
    assert.deepEqual(restored.state.audit.slice(0, after.state.audit.length), after.state.audit);
    assert.equal(restored.state.audit.at(-1).action, 'runtime.restore');
    assert.equal(restored.state.modules.content.revisions.find(value => value.id === 'answer-revision-17').extensions.externalRevisionId, 'legacy-answer-revision-17');
    const restoredServer = await start(restoredConsumer);
    assert.equal((await get(restoredServer.base, '/api/auth/me', token)).status, 401);
    assert.equal((await get(restoredServer.base, '/api/auth/me', rotatedToken)).status, 401);
    assert.equal((await post(restoredServer.base, '/api/auth/login', { accountId: 'external-reviewer', password: rotatedPassword, code: codeAt(Date.now(), rotatedRaw) })).status, 401);
    const lockedAccount = JSON.parse((await cli(restoredConsumer, ['accounts'])).stdout)[0];
    assert.equal(lockedAccount.credentialsRequired, true);
    const recoveryPassword = 'external-consumer-recovery-password-2026', recoveryRaw = 'klmnopqrstklmnopqrst';
    await writeFile(join(restoredConsumer, 'recover.private.json'), JSON.stringify({ action: 'credentials', accountId: lockedAccount.id, expectedVersion: lockedAccount.version, password: recoveryPassword, totpSecret: base32(recoveryRaw) }), { mode: 0o600 });
    const recovered = JSON.parse((await cli(restoredConsumer, ['account', 'recover.private.json'])).stdout);
    assert.equal(recovered.id, 'external-reviewer'); assert.equal(recovered.credentialsRequired, false);
    const recoveredLogin = await post(restoredServer.base, '/api/auth/login', { accountId: recovered.id, password: recoveryPassword, code: codeAt(Date.now(), recoveryRaw) });
    assert.equal(recoveredLogin.status, 200, await recoveredLogin.clone().text());
    assert.equal((await get(restoredServer.base, '/api/auth/me', participant)).status, 401);
    assert.equal((await post(restoredServer.base, '/api/participants/redeem', { token: invitation.token })).status, 401);
    assert.equal((await get(restoredServer.base, '/api/reports/status', receipt)).status, 404);
    assert.equal((await (await get(restoredServer.base, '/api/graph')).json()).nodes[0].revisionId, 'answer-revision-17');
    await stop(restoredServer.child);
  } finally {
    await Promise.all([...children].map(stop));
    const target = resolve(temporary), parent = resolve(tmpdir());
    assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith(prefix));
    await rm(target, { recursive: true, force: true });
  }
});
