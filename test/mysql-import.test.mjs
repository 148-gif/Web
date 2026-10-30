import test from 'node:test';
import assert from 'node:assert/strict';
import { importMysqlSnapshot, MysqlImportError } from '../server/mysql-import.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const empty = () => ({ format: 'heichal-cms-snapshot', version: 1, tables: { drafts: [], log: [], media: [], media_chunks: [], ai_usage: [] }, kv: {} });
const fixture = () => {
  const snapshot = empty();
  snapshot.tables.drafts = [
    { path: 'data/pages/A.json', content: ' {"text":"שלום 😀 é é"}\n ', deleted: 0, base_sha: null, created_at: 1700000000000, updated_at: 1700000000001, email: 'private@example.test', name: 'שם ' },
    { path: 'data/pages/a.json', content: null, deleted: 1, base_sha: 'a'.repeat(40), created_at: 0, updated_at: 0, email: 'private@example.test', name: '' },
  ];
  snapshot.tables.log = [
    { id: 4294967296, ts: 1700000000000, email: null, name: null, action: 'save', path: null, summary: "Robert'); DROP TABLE drafts; --\u0000\n", sha: null },
    { id: 1, ts: 0, email: 'private@example.test', name: 'שם ', action: 'publish', path: 'data/pages/A.json', summary: '', sha: 'b'.repeat(40) },
  ];
  snapshot.tables.media = [{ id: 'fixture', name: 'שלום.txt', kind: 'doc', mime: 'text/plain; charset=utf-8', size: 5, store: 'github', key: 'site/media/fixture.txt', status: 'staged', email: 'private@example.test', by_name: 'שם ', created_at: 1700000000000 }];
  snapshot.tables.media_chunks = [{ id: 'fixture', n: 0, data: 'aGVsbG8=' }];
  snapshot.tables.ai_usage = [{ day: '2026-10-30', email: 'private@example.test', n: 15 }];
  snapshot.kv = { people: '[ { "email": "private@example.test", "name": "שם ", "publisher": true } ]\n', editors: '["legacy@example.test"]', 'owner-names': `{ "${'c'.repeat(64)}": "בעלים 😀" }` };
  return snapshot;
};
async function testPool(config) {
  const { createPool } = await import('mysql2/promise');
  return createPool(config);
}
async function applied(snapshot, config, extra = {}) {
  const reviewed = await importMysqlSnapshot({ snapshot });
  return importMysqlSnapshot({ snapshot, apply: true, initializeSchema: true, targetIsIsolated: true,
    targetDatabase: config.database, expectedSourceSha256: reviewed.sourceSha256, expectedSchemaSha256: reviewed.schemaSha256,
    createPool: () => testPool(config), ...extra });
}
async function decoratedPool(config, decorate) {
  const pool = await testPool(config);
  return {
    getConnection: async () => {
      const connection = await pool.getConnection();
      const result = Object.fromEntries(['query', 'execute', 'beginTransaction', 'commit', 'rollback', 'release'].map((name) => [name, connection[name].bind(connection)]));
      return decorate(result);
    },
    end: () => pool.end(),
  };
}

test('dry-run validates and fingerprints original snapshot without obtaining a connection or disclosing values', async () => {
  const snapshot = fixture(), original = structuredClone(snapshot);
  const report = await importMysqlSnapshot({ snapshot, createPool: () => { throw new Error('must never connect'); } });
  assert.deepEqual(snapshot, original); assert.equal(report.readyToImport, true);
  assert.equal(report.databaseConnected, false); assert.equal(report.databaseModified, false);
  assert.equal(report.deploymentReady, false); assert.equal(report.imported, false);
  assert.match(report.sourceSha256, /^[0-9a-f]{64}$/); assert.match(report.schemaSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(report).includes('private@example.test'), false);
  assert.equal(report.counts.drafts, 2);
});

test('invalid or blocked snapshots and unreviewed apply options cannot reach a connection', async () => {
  let connections = 0;
  const snapshot = fixture(), dry = await importMysqlSnapshot({ snapshot });
  const options = { snapshot, apply: true, initializeSchema: true, targetIsIsolated: true, targetDatabase: 'cms_fresh',
    expectedSourceSha256: dry.sourceSha256, expectedSchemaSha256: dry.schemaSha256,
    createPool: () => { connections++; throw new Error('must never connect'); } };
  for (const override of [{ initializeSchema: false }, { targetIsIsolated: false }, { targetDatabase: 'x;DROP DATABASE x' },
    { expectedSourceSha256: '0'.repeat(64) }, { expectedSchemaSha256: '0'.repeat(64) }]) {
    await assert.rejects(importMysqlSnapshot({ ...options, ...override }), MysqlImportError);
  }
  const tampered = structuredClone(snapshot); tampered.tables.drafts[0].name = 'changed';
  await assert.rejects(importMysqlSnapshot({ ...options, snapshot: tampered }), { code: 'reviewed-hash-mismatch' });
  const blocked = fixture(); blocked.tables.media[0].status = 'uploading';
  assert.equal((await importMysqlSnapshot({ snapshot: blocked })).readyToImport, false);
  await assert.rejects(importMysqlSnapshot({ ...options, snapshot: blocked }), { code: 'snapshot-blocked' });
  await assert.rejects(importMysqlSnapshot({ ...options, snapshot: { sql: 'DROP DATABASE anything' } }));
  assert.equal(connections, 0);
});

test('snapshot object mutation after invocation cannot change the imported review artifact', async () => {
  const snapshot = fixture(), initial = await importMysqlSnapshot({ snapshot });
  const pending = importMysqlSnapshot({ snapshot }); snapshot.tables.drafts[0].name = 'changed after invocation';
  assert.equal((await pending).sourceSha256, initial.sourceSha256);
});

test('real MySQL fresh-target import preserves every value, null, large integer and row despite source order', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    const snapshot = fixture(), report = await applied(snapshot, config);
    assert.equal(report.imported, true); assert.equal(report.rowsCommitted, true);
    assert.equal(report.deploymentReady, false); assert.equal(report.externalDependenciesVerified, false);
    assert.equal(report.verification.nextLogId, 4294967297);
    assert.deepEqual(report.counts, { drafts: 2, log: 2, media: 1, media_chunks: 1, ai_usage: 1, editors_kv: 3 });
    const [drafts] = await pool.query('SELECT path, content, name FROM drafts ORDER BY path');
    assert.deepEqual(drafts.map((row) => ({ ...row })), snapshot.tables.drafts.map(({ path, content, name }) => ({ path, content, name })));
    const [kv] = await pool.query('SELECT `key`, value FROM editors_kv');
    assert.deepEqual(Object.fromEntries(kv.map((row) => [row.key, row.value])), snapshot.kv);
    const [limits] = await pool.query('SELECT COUNT(*) AS n FROM request_limits'); assert.equal(Number(limits[0].n), 0);
  }, { schema: false });
});

test('real MySQL rejects a populated or previously initialized target without changing it', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    await pool.query('CREATE TABLE unrelated (value TEXT)'); await pool.execute('INSERT INTO unrelated VALUES (?)', ['keep me']);
    await assert.rejects(applied(empty(), config), (error) => error.code === 'target-not-empty' && error.state.databaseModified === false);
    const [rows] = await pool.query('SELECT value FROM unrelated'); assert.equal(rows[0].value, 'keep me');
    const [tables] = await pool.query('SHOW TABLES'); assert.equal(tables.length, 1);
  }, { schema: false });
  await withMysqlDatabase(async ({ config }) => {
    await assert.rejects(applied(empty(), config), (error) => error.code === 'target-not-empty' && error.state.databaseModified === false);
  });
});

test('real MySQL rejects a connection to a different database before schema initialization', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    await assert.rejects(applied(empty(), config, { targetDatabase: 'another_explicit_target' }), { code: 'target-database' });
    const [tables] = await pool.query('SHOW TABLES'); assert.equal(tables.length, 0);
  }, { schema: false });
});

test('real MySQL rolls every data table back after a mid-import failure and keeps initialized schema', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    const factory = () => decoratedPool(config, (connection) => {
      const execute = connection.execute;
      connection.execute = (sql, values) => /^INSERT INTO `log`/.test(sql) ? Promise.reject(new Error('private connection failure, do not echo')) : execute(sql, values);
      return connection;
    });
    await assert.rejects(applied(fixture(), config, { createPool: factory }), (error) => {
      assert.equal(error.code, 'database-operation-failed'); assert.equal(error.state.transactionRolledBack, true);
      assert.equal(error.state.schemaInitialized, true); assert.equal(error.state.rowsCommitted, false);
      assert.equal(error.message.includes('private connection failure'), false); return true;
    });
    for (const table of ['drafts', 'log', 'media', 'media_chunks', 'ai_usage', 'editors_kv', 'request_limits']) {
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`); assert.equal(Number(rows[0].n), 0, table);
    }
    const [locks] = await pool.query('SELECT COUNT(*) AS n FROM cms_locks'); assert.equal(Number(locks[0].n), 5);
    await assert.rejects(applied(empty(), config), { code: 'target-not-empty' });
  }, { schema: false });
});

test('real MySQL readback detects a whitespace-altered value and rolls back all imported rows', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    const factory = () => decoratedPool(config, (connection) => {
      const execute = connection.execute;
      connection.execute = (sql, values) => {
        if (/^INSERT INTO `drafts`/.test(sql) && values[1]) { const changed = [...values]; changed[1] = changed[1].trim(); return execute(sql, changed); }
        return execute(sql, values);
      }; return connection;
    });
    await assert.rejects(applied(fixture(), config, { createPool: factory }), (error) => error.code === 'readback-mismatch' && error.state.transactionRolledBack === true);
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM drafts'); assert.equal(Number(rows[0].n), 0);
  }, { schema: false });
});

test('real MySQL retains partial DDL and reports it instead of claiming a rollback', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    const factory = () => decoratedPool(config, (connection) => {
      const query = connection.query;
      connection.query = (sql, values) => /^CREATE TABLE log/.test(sql) ? Promise.reject(new Error('DDL failed')) : query(sql, values);
      return connection;
    });
    await assert.rejects(applied(empty(), config, { createPool: factory }), (error) => {
      assert.equal(error.state.schemaStatementsCompleted, 1); assert.equal(error.state.databaseModified, true);
      assert.equal(error.state.transactionStarted, false); assert.equal(error.state.transactionRolledBack, false); return true;
    });
    const [tables] = await pool.query('SHOW TABLES'); assert.equal(tables.length, 1);
  }, { schema: false });
});

test('real MySQL commit-acknowledgment failure reports unknown outcome, never a false successful rollback', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    const factory = () => decoratedPool(config, (connection) => {
      const commit = connection.commit;
      connection.commit = async () => { await commit(); throw new Error('Acknowledgment lost'); }; return connection;
    });
    await assert.rejects(applied(fixture(), config, { createPool: factory }), (error) => {
      assert.equal(error.state.commitOutcomeUnknown, true); assert.equal(error.state.transactionRolledBack, false);
      assert.equal(error.state.databaseModified, true); return true;
    });
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM drafts'); assert.equal(Number(rows[0].n), 2);
  }, { schema: false });
});

test('real MySQL lost first-DDL acknowledgment is reported as possibly modified even before one confirmed statement', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool, config }) => {
    const factory = () => decoratedPool(config, (connection) => {
      const query = connection.query;
      connection.query = async (sql, values) => {
        const result = await query(sql, values);
        if (/^CREATE TABLE drafts/.test(sql)) throw new Error('DDL acknowledgment lost');
        return result;
      }; return connection;
    });
    await assert.rejects(applied(empty(), config, { createPool: factory }), (error) => {
      assert.equal(error.state.schemaStatementsCompleted, 0); assert.equal(error.state.schemaStatementsAttempted, 1);
      assert.equal(error.state.schemaOutcomeUnknown, true); assert.equal(error.state.databaseMayHaveChanged, true);
      assert.equal(error.state.transactionRolledBack, false); return true;
    });
    const [tables] = await pool.query('SHOW TABLES'); assert.equal(tables.length, 1);
  }, { schema: false });
});
