import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const REQUIRED_MODES = ['STRICT_ALL_TABLES', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION'];
const SESSION = 'SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode';
const integration = (name, fn) => test(name, { skip: !mysqlEnabled, timeout: 30000 }, () => withMysqlDatabase(fn));
const modes = (value) => new Set(value.split(',').filter(Boolean));
const checkStrict = (row) => {
  for (const mode of REQUIRED_MODES) assert.ok(modes(row.mode).has(mode), `Session must include ${mode}`);
};

async function withSeededPool(config, initialMode, fn) {
  // Keep driver loading inside opted-in tests so dependency-free discovery works.
  const { createPool } = await import('mysql2/promise');
  const raw = createPool({ ...config, connectionLimit: 3 });
  const baseline = new Map(), setupErrors = [], leased = new Set();
  raw.on('connection', (connection) => {
    // Test-only simulation of a hosting default. Both callback commands are
    // queued synchronously before mysql2 hands the connection to the facade;
    // production must await its initializer and never depend on async events.
    connection.query('SET SESSION sql_mode = ?', [initialMode], (error) => {
      if (error) { setupErrors.push(error.code); connection.destroy(); }
    });
    connection.query(SESSION, (error, rows) => {
      if (error) { setupErrors.push(error.code); connection.destroy(); }
      else baseline.set(Number(rows[0].id), rows[0].mode);
    });
  });
  const pool = createInitializedMysqlPool(raw);
  const checkout = async () => {
    const connection = await pool.getConnection();
    leased.add(connection);
    return connection;
  };
  const release = (connection) => { leased.delete(connection); connection.release(); };
  const destroy = (connection) => { leased.delete(connection); connection.destroy(); };
  try {
    await fn({ pool, baseline, checkout, release, destroy });
    assert.deepEqual(setupErrors, [], 'The nonstrict session simulation must succeed');
  } finally {
    for (const connection of leased) connection.destroy();
    await pool.end();
  }
}

integration('real MySQL initializes all pool slots, reused and replacement connections before any query', async ({ pool: fixturePool, config }) => {
  const [[before]] = await fixturePool.query('SELECT @@GLOBAL.sql_mode AS mode');
  await fixturePool.query('CREATE TABLE strict_pool_probe (value VARCHAR(3) NOT NULL, n TINYINT UNSIGNED NOT NULL) ENGINE=InnoDB');
  await withSeededPool(config, '', async ({ pool, baseline, checkout, release, destroy }) => {
    assert.equal((await createMysqlDataStore(pool).ensureSchema()).schemaVerified, true);
    const connections = await Promise.all(Array.from({ length: 3 }, () => checkout()));
    const sessions = await Promise.all(connections.map(async (connection) => (await connection.query(SESSION))[0][0]));
    const originalIds = new Set(sessions.map((row) => Number(row.id)));
    assert.equal(originalIds.size, 3, 'Holding three leases must use three distinct physical connections');
    for (const row of sessions) {
      assert.equal(baseline.get(Number(row.id)), '', 'Each fresh physical connection began nonstrict');
      checkStrict(row);
    }
    await Promise.all(connections.map(async (connection) => {
      await assert.rejects(connection.execute('INSERT INTO strict_pool_probe (value, n) VALUES (?, ?)', ['long', 1]), { code: 'ER_DATA_TOO_LONG' });
      await assert.rejects(connection.query('INSERT INTO strict_pool_probe (value, n) VALUES (?, ?)', ['ok', 256]), { code: 'ER_WARN_DATA_OUT_OF_RANGE' });
      // Simulate state changed by a previous borrower, without touching GLOBAL.
      await connection.query("SET SESSION sql_mode = ''");
      release(connection);
    }));

    const reused = await Promise.all(Array.from({ length: 3 }, () => checkout()));
    const reusedSessions = await Promise.all(reused.map(async (connection) => (await connection.execute(SESSION))[0][0]));
    assert.deepEqual(new Set(reusedSessions.map((row) => Number(row.id))), originalIds);
    for (const row of reusedSessions) checkStrict(row);

    // Keep two leases checked out so the fourth connection must replace the
    // destroyed slot, rather than merely reusing a healthy free connection.
    destroy(reused[0]);
    const replacement = await checkout();
    const [[next]] = await replacement.query(SESSION);
    assert.equal(originalIds.has(Number(next.id)), false);
    assert.equal(baseline.get(Number(next.id)), '');
    checkStrict(next);
    assert.equal(baseline.size, 4);
    for (const connection of [...reused.slice(1), replacement]) {
      await connection.query("SET SESSION sql_mode = ''");
      release(connection);
    }

    // Both convenience entrypoints must reacquire through the initializer.
    await Promise.all([
      assert.rejects(pool.execute('INSERT INTO strict_pool_probe (value, n) VALUES (?, ?)', ['long', 1]), { code: 'ER_DATA_TOO_LONG' }),
      assert.rejects(pool.query('INSERT INTO strict_pool_probe (value, n) VALUES (?, ?)', ['ok', 256]), { code: 'ER_WARN_DATA_OUT_OF_RANGE' }),
    ]);
    const [[rows]] = await pool.query('SELECT COUNT(*) AS n FROM strict_pool_probe');
    assert.equal(Number(rows.n), 0, 'Rejected writes must not silently insert truncated or clamped data');
  });
  const [[after]] = await fixturePool.query('SELECT @@GLOBAL.sql_mode AS mode');
  assert.equal(after.mode, before.mode, 'Initializing application sessions must not change GLOBAL SQL mode');
});

integration('real MySQL pool initialization preserves existing NO_ZERO_DATE on every checkout', async ({ pool: fixturePool, config }) => {
  const [[before]] = await fixturePool.query('SELECT @@GLOBAL.sql_mode AS mode');
  await withSeededPool(config, 'NO_ZERO_DATE', async ({ pool, baseline, checkout, release }) => {
    const connections = await Promise.all(Array.from({ length: 3 }, () => checkout()));
    for (const connection of connections) {
      const [[row]] = await connection.query(SESSION);
      assert.equal(baseline.get(Number(row.id)), 'NO_ZERO_DATE');
      assert.ok(modes(row.mode).has('NO_ZERO_DATE'));
      checkStrict(row);
      release(connection);
    }
    for (const method of ['query', 'execute']) {
      const [[row]] = await pool[method](SESSION);
      assert.ok(modes(row.mode).has('NO_ZERO_DATE'));
      checkStrict(row);
    }
  });
  const [[after]] = await fixturePool.query('SELECT @@GLOBAL.sql_mode AS mode');
  assert.equal(after.mode, before.mode);
});
