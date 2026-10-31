import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitializedMysqlPool, MysqlSessionInitializationError } from '../server/mysql-pool.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('every pool entry point waits for its own connection initialization', async () => {
  const states = Array.from({ length: 3 }, () => ({ started: deferred(), ready: deferred(), calls: [], releases: 0 }));
  let acquired = 0;
  const connections = states.map((state) => ({
    async query(sql, values) {
      if (sql.startsWith('SET SESSION ')) {
        state.started.resolve();
        await state.ready.promise;
        state.initialized = true;
        return [{}, []];
      }
      assert.equal(state.initialized, true);
      state.calls.push(['query', sql, values]);
      return [[{ ok: true }], []];
    },
    async execute(sql, values) {
      assert.equal(state.initialized, true);
      state.calls.push(['execute', sql, values]);
      return [[{ ok: true }], []];
    },
    release() { state.releases++; },
    destroy() { assert.fail('Successful initialization must not destroy the connection'); },
  }));
  const pool = createInitializedMysqlPool({
    async getConnection() { return connections[acquired++]; },
    query() { assert.fail('Raw pool.query must not bypass initialization'); },
    execute() { assert.fail('Raw pool.execute must not bypass initialization'); },
    async end() {},
  });
  const values = ['bound value'];
  let returned = false;
  const lease = pool.getConnection().then((connection) => { returned = true; return connection; });
  const query = pool.query('SELECT ?', values);
  const execute = pool.execute('SELECT ?', values);
  await Promise.all(states.map((state) => state.started.promise));
  assert.equal(returned, false);
  assert.ok(states.every((state) => state.calls.length === 0 && state.releases === 0));
  states[1].ready.resolve();
  assert.deepEqual(await query, [[{ ok: true }], []]);
  assert.equal(returned, false);
  assert.equal(states[2].calls.length, 0, 'Another slot must not borrow this slot’s readiness');
  states[2].ready.resolve(); await execute;
  states[0].ready.resolve();
  const connection = await lease;
  assert.equal(connection, connections[0]);
  assert.equal(states[0].releases, 0, 'Explicit leases stay owned by the caller');
  connection.release();
  assert.ok(states.every((state) => state.releases === 1));
  assert.deepEqual(states[1].calls, [['query', 'SELECT ?', values]]);
  assert.deepEqual(states[2].calls, [['execute', 'SELECT ?', values]]);
});

test('a reused connection is initialized again before the next lease', async () => {
  let initialized = 0, releases = 0;
  const connection = {
    async query(sql) { assert.ok(sql.startsWith('SET SESSION ')); initialized++; },
    release() { releases++; }, destroy() { assert.fail('Unexpected disposal'); },
  };
  const pool = createInitializedMysqlPool({ async getConnection() { return connection; }, async end() {} });
  for (let i = 1; i <= 3; i++) {
    const leased = await pool.getConnection();
    assert.equal(initialized, i);
    assert.equal(leased, connection);
    leased.release();
  }
  assert.equal(releases, 3);
});

for (const method of ['getConnection', 'query', 'execute']) {
  test(`${method} rejects initialization failure without releasing or using the connection`, async () => {
    const privateError = new Error('fixture-only-private-driver-details');
    let initialized = 0, destroyed = 0;
    const connection = {
      async query(sql) {
        assert.ok(sql.startsWith('SET SESSION '), 'No application query may run');
        initialized++; throw privateError;
      },
      async execute() { assert.fail('Application SQL ran before initialization'); },
      release() { assert.fail('Failed initialization must not return the connection to the pool'); },
      destroy() { destroyed++; },
    };
    const pool = createInitializedMysqlPool({ async getConnection() { return connection; }, async end() {} });
    await assert.rejects(pool[method]('SELECT 1'), (error) => {
      assert.ok(error instanceof MysqlSessionInitializationError);
      assert.equal(error.message, 'MySQL session initialization failed');
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(privateError.message));
      return true;
    });
    assert.equal(initialized, 1); assert.equal(destroyed, 1);
  });
}

test('a disposal error cannot release a failed lease or replace the safe initialization error', async () => {
  const pool = createInitializedMysqlPool({
    async getConnection() {
      return {
        async query() { throw new Error('private initialization details'); },
        destroy() { throw new Error('private disposal details'); },
        release() { assert.fail('Failed connection must remain unavailable'); },
      };
    },
    async end() {},
  });
  await assert.rejects(pool.execute('SELECT 1'), (error) => error instanceof MysqlSessionInitializationError && error.message === 'MySQL session initialization failed');
});

test('application SQL failures release exactly once and retain their original error', async () => {
  for (const method of ['query', 'execute']) {
    const businessError = new Error('application query failed');
    let released = 0;
    const connection = {
      async query(sql) { if (!sql.startsWith('SET SESSION ')) throw businessError; },
      async execute() { throw businessError; },
      release() { released++; }, destroy() { assert.fail('Not an initialization failure'); },
    };
    const pool = createInitializedMysqlPool({ async getConnection() { return connection; }, async end() {} });
    await assert.rejects(pool[method]('SELECT 1'), (error) => error === businessError);
    assert.equal(released, 1);
  }
});

test('pool acquisition and shutdown retain the promise pool lifecycle', async () => {
  const acquireError = new Error('pool closed');
  let ends = 0;
  const pool = createInitializedMysqlPool({
    async getConnection() { throw acquireError; },
    async end() { ends++; return 'closed'; },
  });
  await assert.rejects(pool.getConnection(), (error) => error === acquireError);
  assert.equal(await pool.end(), 'closed');
  assert.equal(ends, 1);
});

test('pool methods preserve mysql2 read-only failure eviction without retrying a statement', async () => {
  for (const method of ['query', 'execute']) for (const errno of [1290, 1792, 1836]) {
    const original = Object.assign(new Error('server became read-only'), { errno });
    let acquired = 0, destroyed = 0, released = 0, statements = 0;
    const pool = createInitializedMysqlPool({
      async getConnection() {
        const stale = ++acquired === 1;
        const statement = async () => { statements++; if (stale) throw original; return [[{ ok: true }], []]; };
        return {
          async query(sql) { if (!sql.startsWith('SET SESSION ')) return statement(); },
          execute: statement,
          destroy() { assert.equal(stale, true); destroyed++; },
          release() { assert.equal(stale, false); released++; },
        };
      },
      async end() {},
    });
    await assert.rejects(pool[method]('application statement'), (error) => error === original);
    assert.equal(acquired, 1); assert.equal(statements, 1, 'No implicit retry');
    assert.equal(destroyed, 1); assert.equal(released, 0);
    assert.deepEqual(await pool[method]('another statement'), [[{ ok: true }], []]);
    assert.equal(acquired, 2); assert.equal(statements, 2);
    assert.equal(destroyed, 1); assert.equal(released, 1);
  }
});
