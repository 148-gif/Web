import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from 'mysql2/promise';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const user = (changes = {}) => ({ id: 'a'.repeat(32), username: 'administrator', display_name: 'מנהל מקומי', password_hash: 'test-only-noncredential-hash', owner_hash: 'b'.repeat(64), role: 'owner', version: 1, disabled: false, ...changes });
const session = (changes = {}) => ({ token_hash: 'c'.repeat(64), csrf_hash: 'd'.repeat(64), user_id: 'a'.repeat(32), version: 1, expires_at: 1794000000000, ...changes });
async function setup(pool, database) {
  const initialized = createInitializedMysqlPool(pool), plan = await initializeLocalAuthSchema(null);
  await initializeLocalAuthSchema(initialized, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  return createMysqlAuthStore(initialized);
}
const integration = (name, fn) => test(name, { skip: !mysqlEnabled }, () => withMysqlDatabase(fn));

integration('local auth setup is additive and preserves existing content, memberships and coordination locks', async ({ pool, database }) => {
  await pool.execute('INSERT INTO log (ts, action, summary) VALUES (?, ?, ?)', [1790000000000, 'existing', 'נשמר']);
  await pool.execute('INSERT INTO editors_kv (`key`, value) VALUES (?, ?)', ['people', '[{"email":"existing@example.test"}]']);
  const [beforeLocks] = await pool.query('SELECT name FROM cms_locks ORDER BY name');
  const auth = await setup(pool, database);
  assert.equal((await auth.ensureSchema()).schemaVerified, true);
  assert.deepEqual(await auth.getSettings(), { id: 1, local_enabled: false, google_enabled: true, local_verified: false, google_verified_until: 0, bootstrap_hash: null, bootstrap_expires: 0, bootstrap_owner_hash: null, bootstrap_consumed: false });
  assert.equal((await createMysqlDataStore(createInitializedMysqlPool(pool)).ensureSchema()).schemaVerified, true);
  const [afterLocks] = await pool.query('SELECT name FROM cms_locks ORDER BY name');
  assert.deepEqual(afterLocks, beforeLocks);
  const [[log]] = await pool.query('SELECT action, summary FROM log'); assert.deepEqual(log, { action: 'existing', summary: 'נשמר' });
  const [[kv]] = await pool.query('SELECT value FROM editors_kv WHERE `key` = ?', ['people']); assert.equal(kv.value, '[{"email":"existing@example.test"}]');
  const plan = await initializeLocalAuthSchema(null);
  await assert.rejects(initializeLocalAuthSchema(createInitializedMysqlPool(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 }), /already exist/);
});

integration('local auth verification refuses missing or drifted schema without creating or repairing tables', async ({ pool, database }) => {
  const initialized = createInitializedMysqlPool(pool);
  await assert.rejects(createMysqlAuthStore(initialized).ensureSchema(), /required local authentication table/);
  const [absent] = await pool.query("SHOW TABLES LIKE 'local_auth_%'"); assert.equal(absent.length, 0);
  await setup(pool, database);
  await pool.query('ALTER TABLE local_auth_users DROP INDEX local_auth_username');
  await assert.rejects(createMysqlAuthStore(initialized).ensureSchema(), /required local authentication index/);
});

integration('local auth verification rejects collation weakening and missing singleton', async ({ pool, database }) => {
  await setup(pool, database); const initialized = createInitializedMysqlPool(pool);
  await pool.query('ALTER TABLE local_auth_users MODIFY username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL');
  await assert.rejects(createMysqlAuthStore(initialized).ensureSchema(), /required local authentication columns/);
  await pool.query('ALTER TABLE local_auth_users MODIFY username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL');
  await pool.query('DELETE FROM local_auth_settings');
  await assert.rejects(createMysqlAuthStore(initialized).ensureSchema(), /Invalid local authentication state/);
});

integration('local auth singleton transaction serializes one-shot bootstrap across independent pools', async ({ pool, config, database }) => {
  const first = await setup(pool, database), otherPool = createPool(config), second = createMysqlAuthStore(createInitializedMysqlPool(otherPool));
  try {
    await first.atomic(async (tx) => {
      const s = await tx.getSettings(); await tx.saveSettings({ ...s, bootstrap_hash: 'e'.repeat(64), bootstrap_owner_hash: 'b'.repeat(64), bootstrap_expires: 1794000000000 });
    });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).atomic(async (tx) => {
      const s = await tx.getSettings(); if (s.bootstrap_consumed) return false;
      await tx.insertUser(user());
      await tx.saveSettings({ ...s, local_enabled: true, bootstrap_hash: null, bootstrap_expires: 0, bootstrap_owner_hash: null, bootstrap_consumed: true });
      return true;
    })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await first.countUsers(), 1);
    assert.equal((await first.getUserByUsername('administrator')).owner_hash, 'b'.repeat(64));
    await assert.rejects(first.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), bootstrap_consumed: false })), /Invalid local authentication state/);
    assert.equal((await first.getSettings()).bootstrap_consumed, true);
  } finally { await otherPool.end(); }
});

integration('local auth transaction rolls back credentials, bootstrap state and sessions together', async ({ pool, database }) => {
  const auth = await setup(pool, database);
  await assert.rejects(auth.atomic(async (tx) => {
    await tx.insertUser(user()); await tx.insertSession(session());
    await tx.saveSettings({ ...await tx.getSettings(), local_enabled: true, bootstrap_consumed: true });
    throw new Error('deliberate rollback');
  }), /deliberate rollback/);
  assert.equal(await auth.getUserById('a'.repeat(32)), null);
  assert.equal(await auth.getSession('c'.repeat(64)), null);
  assert.equal((await auth.getSettings()).bootstrap_consumed, false);
});

integration('local auth password version change and all-session revocation commit atomically', async ({ pool, database }) => {
  const auth = await setup(pool, database);
  await auth.atomic(async (tx) => { await tx.insertUser(user()); await tx.insertSession(session()); await tx.insertSession(session({ token_hash: 'e'.repeat(64) })); });
  await auth.atomic(async (tx) => {
    const u = await tx.getUserById('a'.repeat(32));
    await tx.saveUser({ ...u, version: 2, password_hash: 'different-test-only-hash' });
    await tx.deleteUserSessions(u.id);
    await tx.insertSession(session({ version: 2, token_hash: 'f'.repeat(64) }));
  });
  assert.equal(await auth.getSession('c'.repeat(64)), null);
  assert.equal(await auth.getSession('e'.repeat(64)), null);
  assert.equal((await auth.getSession('f'.repeat(64))).version, 2);
  await assert.rejects(auth.atomic((tx) => tx.insertSession(session())), /Invalid local authentication state/);
  await auth.atomic(async (tx) => { const u = await tx.getUserById('a'.repeat(32)); await tx.saveUser({ ...u, version: 3, disabled: true }); });
  await assert.rejects(auth.atomic((tx) => tx.insertSession(session({ version: 3 }))), /Invalid local authentication state/);
});

integration('local auth method disable revokes all sessions without deleting users or other application rows', async ({ pool, database }) => {
  const auth = await setup(pool, database);
  await auth.atomic(async (tx) => {
    await tx.insertUser(user()); await tx.insertUser(user({ id: 'b'.repeat(32), username: 'second-admin' }));
    await tx.insertSession(session()); await tx.insertSession(session({ user_id: 'b'.repeat(32), token_hash: 'e'.repeat(64) }));
    await tx.saveSettings({ ...await tx.getSettings(), local_enabled: true, bootstrap_consumed: true });
  });
  await auth.atomic(async (tx) => { await tx.saveSettings({ ...await tx.getSettings(), local_enabled: false }); await tx.deleteAllSessions(); });
  assert.equal(await auth.countUsers(), 2);
  assert.equal(await auth.getSession('c'.repeat(64)), null); assert.equal(await auth.getSession('e'.repeat(64)), null);
  assert.equal((await createMysqlDataStore(createInitializedMysqlPool(pool)).ensureSchema()).schemaVerified, true);
});

integration('local auth session admission prunes expired rows and bounds retained live sessions per user', async ({ pool, database }) => {
  const auth = await setup(pool, database); await auth.atomic((tx) => tx.insertUser(user()));
  for (let i = 0; i < 14; i++) await auth.atomic(async (tx) => {
    await tx.pruneSessions('a'.repeat(32), 1700000000000);
    await tx.insertSession(session({ token_hash: i.toString(16).padStart(64, '0'), expires_at: 1794000000000 + i }));
  });
  const [rows] = await pool.query('SELECT token_hash FROM local_auth_sessions ORDER BY expires_at');
  assert.equal(rows.length, 8); assert.equal(rows[0].token_hash, '6'.padStart(64, '0'));
  await auth.atomic((tx) => tx.pruneSessions('a'.repeat(32), 1795000000000));
  const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM local_auth_sessions'); assert.equal(Number(count.n), 0);
  await assert.rejects(auth.atomic((tx) => tx.pruneSessions('a'.repeat(32), 1700000000000, 0)), /Invalid local authentication state/);
});

integration('local auth immutable owner binding and identities cannot be reassigned by saveUser', async ({ pool, database }) => {
  const auth = await setup(pool, database); await auth.atomic((tx) => tx.insertUser(user()));
  for (const changes of [{ owner_hash: 'f'.repeat(64) }, { role: 'editor' }, { username: 'replacement' }, { password_hash: 'replacement-without-revocation-version' }, { disabled: true }]) {
    await assert.rejects(auth.atomic((tx) => tx.saveUser(user(changes))), /Invalid local authentication state/);
  }
  assert.deepEqual(await auth.getUserById('a'.repeat(32)), user());
  for (const name of ['Administrator', 'administrator ', "' OR 1=1 --"]) await assert.rejects(auth.getUserByUsername(name), /Invalid local authentication state/);
  let escaped;
  await auth.atomic(async (tx) => { escaped = tx; });
  await assert.rejects(escaped.getSettings(), /transaction has ended/);
});

integration('local auth setup rejects a partial prior migration without completing it or touching content', async ({ pool, database }) => {
  await pool.query('CREATE TABLE local_auth_settings (id INT PRIMARY KEY)');
  const plan = await initializeLocalAuthSchema(null);
  await assert.rejects(initializeLocalAuthSchema(createInitializedMysqlPool(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 }), /already exist/);
  const [tables] = await pool.query("SHOW TABLES LIKE 'local_auth_%'"); assert.equal(tables.length, 1);
});

integration('local auth setup and verification complete with a single available pool slot', async ({ config, database }) => {
  const single = createPool({ ...config, connectionLimit: 1 });
  try {
    const auth = await setup(single, database);
    await auth.atomic(async (tx) => { await tx.insertUser(user()); await tx.insertSession(session()); });
    assert.equal(await auth.countUsers(), 1);
    assert.equal((await auth.getSession('c'.repeat(64))).user_id, 'a'.repeat(32));
  } finally { await single.end(); }
});

integration('local auth setup serializes concurrent attempts without overwriting a completed schema', async ({ pool, config, database }) => {
  const other = createPool(config), plan = await initializeLocalAuthSchema(null);
  try {
    const results = await Promise.allSettled([pool, other].map((raw) => initializeLocalAuthSchema(createInitializedMysqlPool(raw), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const auth = createMysqlAuthStore(createInitializedMysqlPool(pool));
    assert.equal((await auth.ensureSchema()).schemaVerified, true);
    assert.equal(await auth.countUsers(), 0);
  } finally { await other.end(); }
});
