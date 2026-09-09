import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../packages/runtime/store.mjs';

const moduleV1 = { name: 'business', schemaVersion: 1, initialState: () => ({ externalId: 'D1:123', value: 0 }), validate(data) { assert.equal(typeof data.externalId, 'string'); assert.ok(Number.isSafeInteger(data.value) && data.value >= 0); } };
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'));
  try { await fn(join(dir, 'community.sqlite')); }
  finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); await rm(dir, { recursive: true, force: true }); }
}
test('runtime transactions roll back state, audit and idempotency together across connections', () => fixture(async file => {
  const first = new RuntimeStore(file, { communityId: 'consumer', modules: [moduleV1] });
  const second = new RuntimeStore(file, { communityId: 'consumer', modules: [moduleV1] });
  try {
    assert.throws(() => first.transact(state => { state.modules.business.value++; state.audit.push({ action: 'failed' }); state.idempotency.key = { done: true }; throw new Error('injected'); }));
    assert.equal(second.read().revision, 0); assert.equal(second.read().audit.length, 0); assert.deepEqual(second.read().idempotency, {});
    first.transact(state => { state.modules.business.value = 3; }, { expectedRevision: 0 });
    assert.throws(() => second.transact(state => { state.modules.business.value = 4; }, { expectedRevision: 0 }), { code: 'CONFLICT' });
    assert.equal(second.read().modules.business.value, 3);
    assert.throws(() => first.transact(state => { state.modules.business.value = -1; }));
    assert.throws(() => first.transact(async () => 1), { code: 'ASYNC_TRANSACTION' });
    assert.throws(() => first.transact(state => { state.modules.business.value = 90; return () => 'invalid result'; }), { code: 'INVALID_JSON' });
    const detached = first.read(); detached.modules.business.value = 55;
    assert.equal(second.read().modules.business.value, 3);
  } finally { first.close(); second.close(); }
}));
test('extension schema upgrades are versioned, retain IDs and roll back a failed migration', () => fixture(async file => {
  let store = new RuntimeStore(file, { communityId: 'consumer', modules: [moduleV1] });
  store.transact(state => { state.modules.business.value = 7; }); store.close();
  const broken = { ...moduleV1, schemaVersion: 2, migrations: { 2: data => { data.value = 20; throw new Error('migration failed'); } } };
  assert.throws(() => new RuntimeStore(file, { communityId: 'consumer', modules: [broken] }), /migration failed/);
  store = new RuntimeStore(file, { communityId: 'consumer', modules: [moduleV1] }); assert.equal(store.read().modules.business.value, 7); store.close();
  const upgraded = { ...moduleV1, schemaVersion: 2, migrations: { 2: data => ({ ...data, labels: ['preserved'] }) } };
  store = new RuntimeStore(file, { communityId: 'consumer', modules: [upgraded] });
  assert.deepEqual(store.read().modules.business, { externalId: 'D1:123', value: 7, labels: ['preserved'] }); store.close();
  assert.throws(() => new RuntimeStore(file, { communityId: 'consumer', modules: [moduleV1] }), { code: 'INCOMPATIBLE_MODULE' });
  assert.throws(() => new RuntimeStore(file, { communityId: 'consumer', modules: [] }), { code: 'MISSING_MODULE' });
}));
test('administrative restore only accepts a new database and preserves the original on failure', () => fixture(async file => {
  const store = new RuntimeStore(file, { communityId: 'consumer', modules: [moduleV1] });
  store.transact(state => { state.modules.business.value = 9; state.audit.push({ action: 'legacy.audit', id: 'old-audit' }); });
  const backup = store.backup(); store.close();
  const target = new RuntimeStore(file + '.restore', { communityId: 'consumer', modules: [moduleV1] });
  try {
    const broken = structuredClone(backup); broken.state.modules.business.value = -1;
    assert.throws(() => target.restore(broken)); assert.equal(target.read().revision, 0);
    target.restore(backup); assert.equal(target.read().modules.business.value, 9);
    assert.equal(target.read().audit[0].id, 'old-audit');
    assert.throws(() => target.restore(backup), { code: 'RESTORE_NOT_EMPTY' });
  } finally { target.close(); }
}));
