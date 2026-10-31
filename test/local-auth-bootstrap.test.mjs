import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { armLocalAuth } from '../server/local-auth-bootstrap.mjs';
import { digestToken } from '../server/local-auth-crypto.mjs';
import { runLocalAuthArm } from '../scripts/arm-local-auth.mjs';

const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64), NOW = 1800000000000;
const initial = () => ({ id: 1, local_enabled: false, google_enabled: true, local_verified: false, google_verified_until: 0, bootstrap_hash: null, bootstrap_expires: 0, bootstrap_owner_hash: null, bootstrap_consumed: false });
function memoryStore({ settings = initial(), users = 0, rejectSave = false } = {}) {
  let current = structuredClone(settings), serial = Promise.resolve(), schemas = 0;
  return {
    get state() { return structuredClone(current); }, get schemas() { return schemas; },
    async ensureSchema() { schemas++; },
    atomic(fn) {
      const work = serial.then(async () => {
        let draft = structuredClone(current);
        const result = await fn({ getSettings: async () => structuredClone(draft), countUsers: async () => users,
          saveSettings: async (value) => { if (rejectSave) throw new Error('fixture-private-driver-details'); draft = structuredClone(value); } });
        current = draft; return result;
      });
      serial = work.catch(() => {}); return work;
    },
  };
}
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'heichal-bootstrap-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const privateRoot = join(base, 'private'), publicRoot = join(base, 'public');
  await mkdir(privateRoot, { mode: 0o700 }); await mkdir(publicRoot, { mode: 0o755 });
  return { base, privateRoot, publicRoot, codeFile: join(privateRoot, 'bootstrap-code.txt') };
}
const arm = (store, paths, extra = {}) => armLocalAuth({ store, owners: OWNER, now: NOW, ...paths, ...extra });

test('host arming writes one private capability, persists only its digest and never returns it', async (t) => {
  const paths = await fixture(t), store = memoryStore();
  const report = await arm(store, paths);
  const bytes = await readFile(paths.codeFile, 'utf8'), code = bytes.slice(0, -1);
  assert.match(bytes, /^[A-Za-z0-9_-]{43}\n$/);
  assert.equal((await lstat(paths.codeFile)).mode & 0o777, 0o600);
  assert.equal(store.state.bootstrap_hash, digestToken(code));
  assert.equal(store.state.bootstrap_owner_hash, OWNER); assert.equal(store.state.bootstrap_consumed, false);
  assert.equal(store.state.bootstrap_expires, NOW + 900000); assert.equal(store.schemas, 1);
  assert.equal(report.armed, true); assert.equal(report.passwordCreated, false);
  assert.equal(JSON.stringify(report).includes(code), false); assert.equal(JSON.stringify(report).includes(store.state.bootstrap_hash), false);
  assert.equal(store.state.local_enabled, false, 'Arming alone grants no login');
});

test('only explicitly selected configured owner identifiers can be bound', async (t) => {
  const paths = await fixture(t), store = memoryStore();
  for (const extra of [{ owners: '' }, { owners: OWNER + ',garbage' }, { owners: [OWNER, OTHER] }, { ownerHash: OTHER }]) {
    await assert.rejects(arm(store, paths, extra), /owner identifier/);
  }
  assert.deepEqual(await readdir(paths.privateRoot), []);
  assert.equal(store.schemas, 0);
  await arm(store, paths, { owners: [OWNER, OTHER], ownerHash: OTHER });
  assert.equal(store.state.bootstrap_owner_hash, OTHER);
});

test('consumed bootstrap and any existing user prevent rearming regardless of expiry', async (t) => {
  const paths = await fixture(t);
  for (const store of [memoryStore({ settings: { ...initial(), bootstrap_consumed: true } }), memoryStore({ users: 1 })]) {
    await assert.rejects(arm(store, paths), /already consumed/);
    assert.deepEqual(await readdir(paths.privateRoot), []);
  }
});

test('parallel arming creates exactly one capability and does not replace its active state', async (t) => {
  const paths = await fixture(t), store = memoryStore();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => arm(store, { ...paths, codeFile: join(paths.privateRoot, `code-${i}.txt`) })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await readdir(paths.privateRoot)).length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'already-armed'));
  const before = store.state;
  await assert.rejects(arm(store, paths), /unexpired/); assert.deepEqual(store.state, before);
});

test('expired state can be rearmed explicitly into a new file, never overwrite old bytes', async (t) => {
  const paths = await fixture(t), store = memoryStore();
  await arm(store, paths, { minutes: 1 }); const old = await readFile(paths.codeFile);
  await assert.rejects(arm(store, paths, { now: NOW + 60000 }), /did not complete/);
  assert.deepEqual(await readFile(paths.codeFile), old);
  const next = join(paths.privateRoot, 'next-code.txt');
  await arm(store, { ...paths, codeFile: next }, { now: NOW + 60000, minutes: 30 });
  assert.notDeepEqual(await readFile(next), old); assert.deepEqual(await readFile(paths.codeFile), old);
  assert.equal(store.state.bootstrap_expires, NOW + 60000 + 1800000);
});

test('transaction failure removes only its new file and preserves previous state', async (t) => {
  const paths = await fixture(t), store = memoryStore({ rejectSave: true });
  await assert.rejects(arm(store, paths), (error) => error.code === 'arming-failed' && !JSON.stringify(error).includes('fixture-private-driver-details'));
  assert.deepEqual(store.state, initial()); assert.deepEqual(await readdir(paths.privateRoot), []);
  await writeFile(paths.codeFile, 'pre-existing private data', { mode: 0o600 });
  await assert.rejects(arm(store, paths)); assert.equal(await readFile(paths.codeFile, 'utf8'), 'pre-existing private data');
});

test('public, weak-permission and symlink paths are rejected before storage access', async (t) => {
  const paths = await fixture(t), store = memoryStore();
  await assert.rejects(arm(store, { ...paths, codeFile: join(paths.publicRoot, 'code') }), /outside/);
  await assert.rejects(arm(store, { ...paths, publicRoot: '/' }), /outside/);
  await chmod(paths.privateRoot, 0o755); await assert.rejects(arm(store, paths), /mode0700/); await chmod(paths.privateRoot, 0o700);
  const link = join(paths.base, 'private-link'); await symlink(paths.privateRoot, link);
  await assert.rejects(arm(store, { ...paths, codeFile: join(link, 'code') }), /Symlink/);
  await assert.rejects(arm(store, { ...paths, codeFile: 'relative-code.txt' }), /absolute/);
  assert.equal(store.schemas, 0); assert.deepEqual(await readdir(paths.privateRoot), []);
  await symlink(join(paths.publicRoot, 'destination'), paths.codeFile);
  await assert.rejects(arm(store, paths)); assert.equal((await lstat(paths.codeFile)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(paths.publicRoot), []);
});

test('expiry bounds and default CLI plan require no credentials, files or connection', async () => {
  const values = new Proxy({}, { get() { throw new Error('Credentials must not be read'); } });
  const report = await runLocalAuthArm([], { values, poolFactory: () => assert.fail('No connection allowed') });
  assert.equal(report.mode, 'plan'); assert.equal(report.capabilityCreated, false); assert.equal(report.databaseConnected, false);
  for (const args of [['--arm', '--arm'], ['--minutes', '15'], ['--arm', '--minutes', '31'], ['--arm', '--minutes', '0'], ['--arm', '--code-file'], ['--force'], ['--arm', '--minutes', '15', '--minutes', '15']]) {
    await assert.rejects(runLocalAuthArm(args, { values, poolFactory: () => assert.fail('No connection allowed') }));
  }
  for (const minutes of [0, 31, 1.5, '15']) await assert.rejects(armLocalAuth({ store: memoryStore(), owners: OWNER, minutes }), /expiry/);
});
