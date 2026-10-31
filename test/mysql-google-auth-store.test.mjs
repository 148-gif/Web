import test from 'node:test';
import assert from 'node:assert/strict';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { normalizeGoogleConfig } from '../server/mysql-google-auth-store.mjs';

const CLIENT = '123456789012-example_client_identifier.apps.googleusercontent.com';
const OTHER_CLIENT = '123456789012-second_client_identifier.apps.googleusercontent.com';
const initial = (changes = {}) => ({ id: 1, revision: 1, active_version: 1, active_client_id: null, pending_client_id: null, pending_nonce_hash: null, pending_session_hash: null, pending_user_id: null, pending_user_version: 0, pending_owner_hash: null, pending_issued_at: 0, pending_expires_at: 0, verified_until: 0, ...changes });
const pending = (changes = {}) => initial({ revision: 2, pending_client_id: CLIENT, pending_nonce_hash: 'a'.repeat(64), pending_session_hash: 'b'.repeat(64), pending_user_id: 'c'.repeat(32), pending_user_version: 1, pending_owner_hash: 'd'.repeat(64), pending_issued_at: 1700000000000, pending_expires_at: 1700000060000, ...changes });
const settings = { id: 1, local_enabled: false, google_enabled: true, local_verified: false, google_verified_until: 0, bootstrap_hash: null, bootstrap_expires: 0, bootstrap_owner_hash: null, bootstrap_consumed: false };

function fixture(config = initial()) {
  const calls = [];
  let row = { ...config };
  const connection = {
    async execute(sql, values = []) {
      calls.push({ source: 'connection', sql, values });
      if (sql.startsWith('SELECT * FROM local_auth_settings')) return [[{ ...settings }]];
      if (sql.startsWith('SELECT * FROM google_auth_config')) return [[{ ...row }]];
      if (sql.startsWith('UPDATE google_auth_config')) { row = Object.fromEntries(Object.keys(initial()).map((key, index) => [key, index ? values[index - 1] : 1])); return [{ affectedRows: 1 }]; }
      throw new Error('Unexpected test SQL');
    },
    async query(sql) { calls.push({ source: 'connection', sql }); },
    async beginTransaction() { calls.push({ action: 'begin' }); },
    async commit() { calls.push({ action: 'commit' }); },
    async rollback() { calls.push({ action: 'rollback' }); },
    release() { calls.push({ action: 'release' }); },
    destroy() { calls.push({ action: 'destroy' }); },
  };
  const pool = { async getConnection() { return connection; }, async execute(sql, values) { calls.push({ source: 'pool', sql, values }); return connection.execute(sql, values); } };
  return { pool, calls };
}

test('Google config accepts exactly initial, pending and consumed-proof typed states', () => {
  for (const row of [initial(), pending(), pending({ pending_nonce_hash: null, verified_until: 1700000050000 }), initial({ active_client_id: CLIENT, revision: 4, active_version: 2 })]) assert.deepEqual(normalizeGoogleConfig(row), row);
  assert.deepEqual(normalizeGoogleConfig(initial({ id: '1', revision: '1', active_version: '1', pending_expires_at: '0' })), initial());
  assert.equal(normalizeGoogleConfig(initial({ revision: Number.MAX_SAFE_INTEGER })).revision, Number.MAX_SAFE_INTEGER);
});

test('Google config rejects malformed types, arbitrary keys and incomplete pending states', () => {
  const bad = [null, [], {}, initial({ surprise: 'value' }), initial({ [Symbol('hidden')]: true }), initial({ id: 2 }), initial({ revision: 0 }), initial({ active_version: -1 }), initial({ revision: Number.MAX_SAFE_INTEGER + 1 }), initial({ revision: 1.1 }), initial({ revision: '01' }), initial({ revision: true }), initial({ revision: NaN }), initial({ pending_issued_at: -0 }), initial({ pending_user_version: 1 }), initial({ pending_nonce_hash: 'a'.repeat(64) }), pending({ pending_session_hash: null }), pending({ pending_user_id: null }), pending({ pending_owner_hash: null }), pending({ pending_user_version: 0 }), pending({ pending_issued_at: 0 }), pending({ pending_expires_at: 1700000000000 }), pending({ pending_nonce_hash: null }), pending({ verified_until: 1700000010000 }), pending({ pending_nonce_hash: null, verified_until: 1700000070000 }), pending({ pending_session_hash: 'B'.repeat(64) }), pending({ pending_user_id: 'a'.repeat(64) })];
  const missing = initial(); delete missing.verified_until; bad.push(missing);
  for (const row of bad) assert.throws(() => normalizeGoogleConfig(row), /Invalid Google authentication configuration/);
  for (const client of ['', CLIENT + ' ', CLIENT + '\n', ' ' + CLIENT, "' OR 1=1 --", CLIENT.replace('123456789012', '12345'), CLIENT.replace('example_client_identifier', 'short'), CLIENT.toUpperCase(), '1'.repeat(33) + '-identifier_long_enough.apps.googleusercontent.com', '123456-' + 'a'.repeat(161) + '.apps.googleusercontent.com', 123, {}]) {
    assert.throws(() => normalizeGoogleConfig(initial({ active_client_id: client })), /Invalid Google authentication configuration/);
    assert.throws(() => normalizeGoogleConfig(pending({ pending_client_id: client })), /Invalid Google authentication configuration/);
  }
});

test('default auth store does not read or expose the optional Google addon', async () => {
  const { pool, calls } = fixture();
  for (const options of [undefined, { googleSetup: false }]) {
    const store = createMysqlAuthStore(pool, options);
    assert.equal(store.getGoogleConfig, undefined);
    await store.atomic((tx) => { assert.equal(tx.getGoogleConfig, undefined); assert.equal(tx.saveGoogleConfig, undefined); });
  }
  assert.ok(calls.every((call) => !call.sql?.includes('google_auth_config')));
  assert.throws(() => createMysqlAuthStore(pool, { googleSetup: 'true' }), /must be boolean/);
});

test('Google-enabled transactions lock settings then Google on one connection and expire their methods', async () => {
  const { pool, calls } = fixture();
  const store = createMysqlAuthStore(pool, { googleSetup: true }); let escaped;
  await store.atomic(async (tx) => { escaped = tx; assert.deepEqual(await tx.getGoogleConfig(), initial()); await tx.saveGoogleConfig(pending()); });
  const locks = calls.filter((call) => call.sql?.includes('FOR UPDATE'));
  assert.deepEqual(locks.map((call) => call.sql), ['SELECT * FROM local_auth_settings WHERE id = 1 FOR UPDATE', 'SELECT * FROM google_auth_config WHERE id = 1 FOR UPDATE']);
  assert.ok(locks.every((call) => call.source === 'connection'));
  assert.ok(!calls.some((call) => call.source === 'pool'));
  const update = calls.find((call) => call.sql?.startsWith('UPDATE google_auth_config'));
  assert.equal(update.sql.split('?').length - 1, 12);
  assert.ok(!update.sql.includes(CLIENT));
  assert.deepEqual(update.values, Object.values(pending()).slice(1));
  assert.deepEqual(await store.getGoogleConfig(), pending());
  await assert.rejects(escaped.getGoogleConfig(), /transaction has ended/);
  await assert.rejects(escaped.saveGoogleConfig(initial()), /transaction has ended/);
});

test('Google mutations reject stale revisions, active-version rollback and unversioned Client ID changes before UPDATE', async () => {
  const before = initial({ active_client_id: CLIENT, revision: 4, active_version: 2 });
  for (const row of [initial({ ...before, revision: 3 }), initial({ ...before, revision: 5, active_version: 1 }), initial({ ...before, active_client_id: OTHER_CLIENT }), initial({ ...before, revision: 5, active_client_id: OTHER_CLIENT }), initial({ ...before, active_version: 3 }), pending({ revision: 4, active_version: 2, active_client_id: CLIENT })]) {
    const { pool, calls } = fixture(before), store = createMysqlAuthStore(pool, { googleSetup: true });
    await assert.rejects(store.atomic((tx) => tx.saveGoogleConfig(row)), /Invalid Google authentication configuration/);
    assert.ok(!calls.some((call) => call.sql?.startsWith('UPDATE')));
    assert.ok(calls.some((call) => call.action === 'rollback'));
  }
  const { pool } = fixture(before), store = createMysqlAuthStore(pool, { googleSetup: true });
  await store.atomic((tx) => tx.saveGoogleConfig(before));
  await store.atomic((tx) => tx.saveGoogleConfig(initial({ revision: 5, active_version: 3, active_client_id: OTHER_CLIENT })));
  assert.equal((await store.getGoogleConfig()).active_client_id, OTHER_CLIENT);
});

test('Google config SQL injection values are rejected before any mutation', async () => {
  const { pool, calls } = fixture(), store = createMysqlAuthStore(pool, { googleSetup: true });
  for (const row of [initial({ revision: 2, active_version: 2, active_client_id: "x'); DELETE FROM local_auth_users; --" }), pending({ pending_owner_hash: "' OR 1=1 --" }), pending({ pending_issued_at: '1; DROP TABLE log' }), initial({ revision: 2, 'active_client_id = NULL; --': null })]) await assert.rejects(store.atomic((tx) => tx.saveGoogleConfig(row)), /Invalid Google authentication configuration/);
  assert.ok(calls.every((call) => !call.sql?.startsWith('UPDATE')));
});
