import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from 'mysql2/promise';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeGoogleAuthSchema } from '../scripts/setup-google-auth.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const CLIENT = '123456789012-example_client_identifier.apps.googleusercontent.com';
const initial = (changes = {}) => ({ id: 1, revision: 1, active_version: 1, active_client_id: null, pending_client_id: null, pending_nonce_hash: null, pending_session_hash: null, pending_user_id: null, pending_user_version: 0, pending_owner_hash: null, pending_issued_at: 0, pending_expires_at: 0, verified_until: 0, ...changes });
const pending = (changes = {}) => initial({ revision: 2, pending_client_id: CLIENT, pending_nonce_hash: 'a'.repeat(64), pending_session_hash: 'b'.repeat(64), pending_user_id: 'c'.repeat(32), pending_user_version: 1, pending_owner_hash: 'd'.repeat(64), pending_issued_at: 1700000000000, pending_expires_at: 1700000060000, ...changes });
const user = { id: 'c'.repeat(32), username: 'administrator', display_name: 'מנהל', password_hash: 'test-only-noncredential-hash', owner_hash: 'd'.repeat(64), role: 'owner', version: 1, disabled: false };
const session = { token_hash: 'b'.repeat(64), csrf_hash: 'e'.repeat(64), user_id: user.id, version: 1, expires_at: 1794000000000 };
const integration = (name, fn) => test(name, { skip: !mysqlEnabled }, () => withMysqlDatabase(fn));
const initialized = (pool) => createInitializedMysqlPool(pool);

async function setupBase(pool, database) {
  const plan = await initializeLocalAuthSchema(null);
  await initializeLocalAuthSchema(initialized(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  return createMysqlAuthStore(initialized(pool));
}
async function setupGoogle(pool, database) {
  const plan = await initializeGoogleAuthSchema(null);
  await initializeGoogleAuthSchema(initialized(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  return createMysqlAuthStore(initialized(pool), { googleSetup: true });
}
async function authSnapshot(pool) {
  const result = {};
  for (const table of ['local_auth_settings', 'local_auth_users', 'local_auth_sessions']) {
    const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);
    result[table] = rows;
  }
  return result;
}

integration('Google addon is optional and base auth never creates or requires its table', async ({ pool, database }) => {
  const base = await setupBase(pool, database);
  assert.equal((await base.ensureSchema()).schemaVerified, true);
  assert.equal(base.getGoogleConfig, undefined);
  await base.atomic((tx) => { assert.equal(tx.getGoogleConfig, undefined); assert.equal(tx.saveGoogleConfig, undefined); });
  await assert.rejects(createMysqlAuthStore(initialized(pool), { googleSetup: true }).ensureSchema(), /required Google authentication table/);
  const [tables] = await pool.query("SHOW TABLES LIKE 'google_auth_config'");
  assert.equal(tables.length, 0);
});

integration('Google addon setup adds one singleton without changing auth rows, content or coordination locks', async ({ pool, database }) => {
  const base = await setupBase(pool, database);
  await base.atomic(async (tx) => { await tx.insertUser(user); await tx.insertSession(session); });
  await pool.execute('INSERT INTO log (ts, action, summary) VALUES (?, ?, ?)', [1700000000000, 'existing', 'נשמר']);
  await pool.execute('INSERT INTO editors_kv (`key`, value) VALUES (?, ?)', ['people', '[{"email":"existing@example.test"}]']);
  const before = await authSnapshot(pool);
  const [beforeTables] = await pool.query('SHOW TABLES'), [beforeLocks] = await pool.query('SELECT * FROM cms_locks ORDER BY name');
  const addon = await setupGoogle(pool, database);
  assert.deepEqual(await addon.getGoogleConfig(), initial());
  assert.equal((await addon.ensureSchema()).googleSchemaVerified, true);
  assert.deepEqual(await authSnapshot(pool), before);
  const [afterTables] = await pool.query('SHOW TABLES'), [afterLocks] = await pool.query('SELECT * FROM cms_locks ORDER BY name');
  assert.equal(afterTables.length, beforeTables.length + 1);
  assert.deepEqual(afterLocks, beforeLocks);
  const [[log]] = await pool.query('SELECT action, summary FROM log'); assert.deepEqual(log, { action: 'existing', summary: 'נשמר' });
  const [[kv]] = await pool.query('SELECT value FROM editors_kv WHERE `key` = ?', ['people']); assert.equal(kv.value, '[{"email":"existing@example.test"}]');
  assert.equal((await createMysqlAuthStore(initialized(pool)).ensureSchema()).schemaVerified, true);
  await assert.rejects(setupGoogle(pool, database), /already exist/);
  assert.deepEqual(await authSnapshot(pool), before);
});

integration('Google config stages, consumes proof, activates and clears pending state with versioned round trips', async ({ pool, database }) => {
  await setupBase(pool, database); const store = await setupGoogle(pool, database);
  await store.atomic((tx) => tx.saveGoogleConfig(pending()));
  assert.deepEqual(await store.getGoogleConfig(), pending());
  const verified = pending({ revision: 3, pending_nonce_hash: null, verified_until: 1700000050000 });
  await store.atomic((tx) => tx.saveGoogleConfig(verified));
  assert.deepEqual(await store.getGoogleConfig(), verified);
  const activated = initial({ revision: 4, active_version: 2, active_client_id: CLIENT });
  await store.atomic((tx) => tx.saveGoogleConfig(activated));
  assert.deepEqual(await store.getGoogleConfig(), activated);
  await store.atomic((tx) => tx.saveGoogleConfig(pending({ revision: 5, active_version: 2, active_client_id: CLIENT })));
  await store.atomic((tx) => tx.saveGoogleConfig({ ...activated, revision: 6 }));
  assert.deepEqual(await store.getGoogleConfig(), { ...activated, revision: 6 });
  for (const changes of [{ revision: 5 }, { active_client_id: null, revision: 7 }, { active_version: 1, revision: 7 }, { unknown: 1, revision: 7 }, { active_client_id: "'); DROP TABLE local_auth_users; --", revision: 7, active_version: 3 }]) await assert.rejects(store.atomic((tx) => tx.saveGoogleConfig({ ...activated, revision: 6, ...changes })), /Invalid Google authentication configuration/);
  assert.deepEqual(await store.getGoogleConfig(), { ...activated, revision: 6 });
});

integration('Google config and local auth state roll back together on the same transaction', async ({ pool, database }) => {
  await setupBase(pool, database); const store = await setupGoogle(pool, database), before = await authSnapshot(pool);
  await assert.rejects(store.atomic(async (tx) => {
    await tx.insertUser(user); await tx.insertSession(session);
    await tx.saveSettings({ ...await tx.getSettings(), local_enabled: true });
    await tx.saveGoogleConfig(pending());
    throw new Error('deliberate rollback');
  }), /deliberate rollback/);
  assert.deepEqual(await store.getGoogleConfig(), initial());
  assert.deepEqual(await authSnapshot(pool), before);
});

integration('Google-enabled and base-only auth callbacks exclude each other across independent pools', async ({ pool, config, database }) => {
  await setupBase(pool, database); const first = await setupGoogle(pool, database), otherPool = createPool(config);
  const second = createMysqlAuthStore(initialized(otherPool), { googleSetup: true }), base = createMysqlAuthStore(initialized(otherPool));
  let entered = 0, maximum = 0, updates = 0;
  try {
    await Promise.all(Array.from({ length: 15 }, (_, index) => [first, second, base][index % 3].atomic(async (tx) => {
      entered++; maximum = Math.max(maximum, entered);
      try {
        const before = tx.getGoogleConfig ? await tx.getGoogleConfig() : null;
        await delay(5);
        if (before) { await tx.saveGoogleConfig({ ...before, revision: before.revision + 1 }); updates++; }
      } finally { entered--; }
    })));
    assert.equal(maximum, 1);
    assert.equal((await first.getGoogleConfig()).revision, 1 + updates);
    assert.equal(updates, 10);
  } finally { await otherPool.end(); }
});

integration('Google addon verification rejects column drift, invalid persisted IDs and missing singleton without repair', async ({ pool, database }) => {
  await setupBase(pool, database); await setupGoogle(pool, database);
  const verify = () => createMysqlAuthStore(initialized(pool), { googleSetup: true }).ensureSchema();
  await pool.query('ALTER TABLE google_auth_config ADD unexpected_column INT NULL');
  await assert.rejects(verify(), /required Google authentication columns/);
  await pool.query('ALTER TABLE google_auth_config DROP COLUMN unexpected_column');
  await pool.query('ALTER TABLE google_auth_config MODIFY active_client_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL');
  await assert.rejects(verify(), /required Google authentication columns/);
  await pool.query('ALTER TABLE google_auth_config MODIFY active_client_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL');
  await pool.query('ALTER TABLE google_auth_config MODIFY revision BIGINT NOT NULL');
  await assert.rejects(verify(), /required Google authentication columns/);
  await pool.query('ALTER TABLE google_auth_config MODIFY revision BIGINT UNSIGNED NOT NULL');
  await pool.query('ALTER TABLE google_auth_config DROP PRIMARY KEY');
  await assert.rejects(verify(), /required Google authentication index/);
  await pool.query('ALTER TABLE google_auth_config ADD PRIMARY KEY (id)');
  await pool.execute('UPDATE google_auth_config SET active_client_id = ?', ['invalid persisted Client ID']);
  await assert.rejects(verify(), /Invalid Google authentication configuration/);
  await pool.query('UPDATE google_auth_config SET active_client_id = NULL');
  await pool.query('DELETE FROM google_auth_config');
  await assert.rejects(verify(), /Invalid Google authentication configuration/);
  const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM google_auth_config'); assert.equal(Number(count.n), 0);
});

integration('Google addon SQL constraints reject invalid state and unsafe unsigned values', async ({ pool, database }) => {
  await setupBase(pool, database); await setupGoogle(pool, database);
  for (const [sql, values] of [
    ['UPDATE google_auth_config SET revision = ?', [0]],
    ['UPDATE google_auth_config SET active_version = ?', [Number.MAX_SAFE_INTEGER + 1]],
    ['UPDATE google_auth_config SET pending_client_id = ?', [CLIENT]],
    ['UPDATE google_auth_config SET verified_until = ?', [1]],
    ['UPDATE google_auth_config SET pending_user_version = ?', [-1]],
  ]) await assert.rejects(pool.execute(sql, values));
  assert.deepEqual(await createMysqlAuthStore(initialized(pool), { googleSetup: true }).getGoogleConfig(), initial());
});

integration('Google setup refuses missing base auth or content schema before creating its addon', async ({ pool, database }) => {
  await assert.rejects(setupGoogle(pool, database), /setup failed/);
  let [tables] = await pool.query("SHOW TABLES LIKE 'google_auth_config'"); assert.equal(tables.length, 0);
  await setupBase(pool, database);
  await pool.query('DROP TABLE log');
  await assert.rejects(setupGoogle(pool, database), /setup failed/);
  [tables] = await pool.query("SHOW TABLES LIKE 'google_auth_config'"); assert.equal(tables.length, 0);
});

integration('Google setup refuses partial addon schema and does not fill or alter it', async ({ pool, database }) => {
  await setupBase(pool, database); const before = await authSnapshot(pool);
  await pool.query('CREATE TABLE google_auth_config (id INT PRIMARY KEY)');
  await assert.rejects(setupGoogle(pool, database), /already exist/);
  const [columns] = await pool.query('SHOW COLUMNS FROM google_auth_config'); assert.equal(columns.length, 1);
  const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM google_auth_config'); assert.equal(Number(count.n), 0);
  assert.deepEqual(await authSnapshot(pool), before);
});

integration('Google setup reports a partial DDL failure safely and refuses to retry the created table', async ({ pool, database }) => {
  await setupBase(pool, database);
  const before = await authSnapshot(pool), wrapped = initialized(pool), plan = await initializeGoogleAuthSchema(null);
  let insertAttempts = 0;
  const faultPool = {
    async getConnection() {
      const connection = await wrapped.getConnection();
      return {
        execute: (...args) => connection.execute(...args),
        async query(sql, ...args) {
          if (sql.startsWith('INSERT INTO google_auth_config')) { insertAttempts++; throw new Error('private diagnostic: do-not-print-secret'); }
          return connection.query(sql, ...args);
        },
        release: () => connection.release(), destroy: () => connection.destroy(),
      };
    },
  };
  await assert.rejects(initializeGoogleAuthSchema(faultPool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 }), (error) => {
    assert.equal(error.state.statementsCompleted, 1);
    assert.equal(error.state.partialSchemaPossible, true);
    assert.equal(error.state.schemaInitialized, false);
    assert.ok(!JSON.stringify({ message: error.message, state: error.state }).includes('do-not-print-secret'));
    return true;
  });
  assert.equal(insertAttempts, 1);
  await assert.rejects(setupGoogle(pool, database), /already exist/);
  const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM google_auth_config'); assert.equal(Number(count.n), 0);
  assert.deepEqual(await authSnapshot(pool), before);
});

integration('Google setup and config transactions work with one available pool connection', async ({ config, database }) => {
  const single = createPool({ ...config, connectionLimit: 1 });
  try {
    await setupBase(single, database); const store = await setupGoogle(single, database);
    assert.equal((await store.ensureSchema()).googleSchemaVerified, true);
    await store.atomic((tx) => tx.saveGoogleConfig(pending()));
    assert.deepEqual(await store.getGoogleConfig(), pending());
  } finally { await single.end(); }
});

integration('Google setup serializes competing attempts and retains exactly one untouched singleton', async ({ pool, config, database }) => {
  await setupBase(pool, database); const other = createPool(config), before = await authSnapshot(pool);
  try {
    const results = await Promise.allSettled([setupGoogle(pool, database), setupGoogle(other, database)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.deepEqual(await createMysqlAuthStore(initialized(pool), { googleSetup: true }).getGoogleConfig(), initial());
    assert.deepEqual(await authSnapshot(pool), before);
  } finally { await other.end(); }
});
