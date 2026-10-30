import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMysqlImport, readImportSnapshot, mysqlImportConnectionOptions } from '../scripts/import-mysql-migration.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const empty = () => ({ format: 'heichal-cms-snapshot', version: 1, tables: { drafts: [], log: [], media: [], media_chunks: [], ai_usage: [] }, kv: {} });
async function fixture(t, data = empty()) {
  const directory = await mkdtemp(join(tmpdir(), 'cms-mysql-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'source.json'); await writeFile(input, JSON.stringify(data));
  return { input, directory };
}

test('import CLI default mode does not read credentials, connect, or create artifacts', async (t) => {
  const value = empty(); value.kv.editors = '["private@example.test"]';
  const { input, directory } = await fixture(t, value);
  const values = new Proxy({}, { get() { throw new Error('Credentials must not be read'); } });
  const report = await runMysqlImport(['--input', input], { values });
  assert.equal(report.databaseConnected, false); assert.equal(report.imported, false);
  assert.equal(JSON.stringify(report).includes('private@example.test'), false);
  assert.deepEqual(await readdir(directory), ['source.json']);
});

test('CLI rejects unknown, duplicate and incomplete flags rather than implicitly applying', async (t) => {
  const { input } = await fixture(t);
  for (const args of [[], ['--input'], ['--input', input, '--yes'], ['--input', input, '--input', input],
    ['--input', input, '--database', 'target'], ['--input', input, '--apply'], ['--input', input, '--apply', '--apply']]) {
    await assert.rejects(runMysqlImport(args, { poolFactory: () => { throw new Error('must not connect'); } }));
  }
});

test('snapshot reader rejects special files, symlinks, malformed UTF8 and oversized input', async (t) => {
  const { input, directory } = await fixture(t);
  const link = join(directory, 'link'); await symlink(input, link);
  await assert.rejects(readImportSnapshot(link));
  await assert.rejects(readImportSnapshot(directory), /regular file/);
  await assert.rejects(readImportSnapshot(input, 1), /budget/);
  await writeFile(input, Buffer.from([0xc3, 0x28])); await assert.rejects(readImportSnapshot(input), /UTF-8 JSON/);
  const fifo = join(directory, 'fifo'); const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0); await assert.rejects(readImportSnapshot(fifo), /regular file/);
});

test('remote import verifies both certificate trust and hostname, and rejects unverified remote IP targets', () => {
  const values = { MYSQL_HOST: 'mysql.example.test', MYSQL_USER: 'fixture', MYSQL_PASSWORD: 'test-only-password' };
  const options = mysqlImportConnectionOptions(values, 'fresh_target');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(options.host, 'mysql.example.test'); assert.equal(options.database, 'fresh_target');
  assert.equal(options.multipleStatements, false);
  for (const host of ['192.0.2.1', '2001:db8::1', '[2001:db8::1]', 'hostname with spaces', '-invalid.example']) {
    assert.throws(() => mysqlImportConnectionOptions({ ...values, MYSQL_HOST: host }, 'fresh_target'), /DNS hostname/);
  }
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    assert.equal(mysqlImportConnectionOptions({ ...values, MYSQL_HOST: host }, 'fresh_target').ssl, undefined);
  }
});

test('import socket connections require an explicit absolute path and never resolve relative to the worktree', () => {
  const values = { MYSQL_HOST: 'localhost', MYSQL_USER: 'fixture', MYSQL_PASSWORD: 'test-only-password' };
  for (const path of ['mysql.sock', '../mysql.sock', '', '/tmp/mysql\0.sock', null]) {
    assert.throws(() => mysqlImportConnectionOptions({ ...values, MYSQL_SOCKET_PATH: path }, 'fresh_target'), /absolute socket path/);
  }
  const options = mysqlImportConnectionOptions({ ...values, MYSQL_SOCKET_PATH: '/private/mysql.sock' }, 'fresh_target');
  assert.equal(options.socketPath, '/private/mysql.sock'); assert.equal(options.ssl, undefined);
});

test('real MySQL CLI requires matching reviewed hashes and applies only to a fresh explicit target', { skip: !mysqlEnabled }, async (t) => {
  const value = empty(); value.kv.editors = '[ "private@example.test" ]\n';
  const { input } = await fixture(t, value), dry = await runMysqlImport(['--input', input]);
  await withMysqlDatabase(async ({ pool, config, database }) => {
    const values = { MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_USER: config.user, MYSQL_PASSWORD: config.password };
    const flags = ['--input', input, '--apply', '--initialize-schema', '--isolated-target', '--database', database,
      '--source-sha256', dry.sourceSha256, '--schema-sha256', dry.schemaSha256];
    const report = await runMysqlImport(flags, { values });
    assert.equal(report.imported, true); assert.equal(report.verification.tables.editors_kv.count, 1);
    const [rows] = await pool.query('SELECT value FROM editors_kv'); assert.equal(rows[0].value, value.kv.editors);
  }, { schema: false });
});
