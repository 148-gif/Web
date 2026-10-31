import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeLocalInvitationsSchema, runLocalInvitationsSetup, LocalInvitationsSetupError } from '../scripts/setup-local-invitations.mjs';

test('Local invitation setup defaults to an additive credential-free plan without opening a database connection', async () => {
  let calls = 0;
  const report = await runLocalInvitationsSetup([], { values: new Proxy({}, { get() { throw new Error('must not inspect credentials'); } }), poolFactory() { calls++; throw new Error('must not connect'); } });
  assert.equal(calls, 0);
  assert.equal(report.apply, false); assert.equal(report.databaseConnected, false); assert.equal(report.schemaInitialized, false);
  assert.equal(report.createsPasswordsOrBootstrapCredentials, false); assert.equal(report.createsInvitationsOrUsers, false);
  assert.equal(report.modifiesExistingTables, false); assert.deepEqual(report.additiveTables, ['local_auth_invitations']);
  const schema = await readFile(new URL('../server/mysql-local-invitations-store.sql', import.meta.url));
  assert.equal(report.schemaSha256, createHash('sha256').update(schema).digest('hex'));
});

test('Local invitation setup rejects invalid, duplicate, incomplete and apply-only flags without connecting', async () => {
  const plan = await initializeLocalInvitationsSchema(null); let calls = 0;
  const dependencies = { values: { MYSQL_DATABASE: 'expected' }, poolFactory() { calls++; throw new Error('must not connect'); } };
  for (const args of [
    ['--apply', '--database', 'expected', '--schema-sha256', '0'.repeat(64)],
    ['--apply', '--database', 'different', '--schema-sha256', plan.schemaSha256],
    ['--apply'], ['--apply', '--apply'], ['--force'], ['toString', 'ignored'], ['__proto__', 'ignored'], ['--database', 'expected'], ['--schema-sha256', plan.schemaSha256],
    ['--apply', '--database'], ['--apply', '--database', 'expected', '--database', 'expected'],
    ['--apply', '--schema-sha256', plan.schemaSha256, '--schema-sha256', plan.schemaSha256],
    ['--apply', '--database', 'expected;DROP', '--schema-sha256', plan.schemaSha256],
    ['--apply', '--database', 'x'.repeat(65), '--schema-sha256', plan.schemaSha256],
  ]) await assert.rejects(runLocalInvitationsSetup(args, dependencies));
  assert.equal(calls, 0);
});

test('Local invitation initializer requires the reviewed hash and explicit target before checking out a connection', async () => {
  const plan = await initializeLocalInvitationsSchema(null); let calls = 0;
  const pool = { async getConnection() { calls++; throw new Error('must not connect'); } };
  for (const options of [
    { apply: true }, { apply: true, targetDatabase: 'expected' },
    { apply: true, targetDatabase: 'expected', expectedSchemaSha256: '0'.repeat(64) },
    { apply: true, targetDatabase: '../expected', expectedSchemaSha256: plan.schemaSha256 },
  ]) await assert.rejects(initializeLocalInvitationsSchema(pool, options), (error) => error instanceof LocalInvitationsSetupError && error.state.databaseConnected === false);
  assert.equal(calls, 0);
});

test('Local invitation setup checks the target and named lock before schema work and never repeats a failed attempt', async () => {
  const plan = await initializeLocalInvitationsSchema(null);
  for (const failure of ['target', 'lock', 'schema']) {
    const calls = []; let released = 0;
    const connection = {
      async execute(sql, parameters = []) {
        calls.push({ sql, parameters });
        if (sql === 'SELECT DATABASE() AS name') return [[{ name: failure === 'target' ? 'different' : 'expected' }]];
        if (sql === 'SELECT GET_LOCK(?, 0) AS acquired') return [[{ acquired: failure === 'lock' ? 0 : 1 }]];
        if (sql === 'SELECT RELEASE_LOCK(?)') return [[{ released: 1 }]];
        throw new Error('private database error: password=do-not-disclose');
      },
      async query() { assert.fail('Schema guards must pass before any DDL'); },
      release() { released++; }, destroy() { assert.fail('The connection is healthy'); },
    };
    let checkouts = 0;
    await assert.rejects(initializeLocalInvitationsSchema({ async getConnection() { checkouts++; return connection; } }, { apply: true, targetDatabase: 'expected', expectedSchemaSha256: plan.schemaSha256 }), (error) => {
      assert.ok(error instanceof LocalInvitationsSetupError);
      assert.equal(error.state.statementsCompleted, 0); assert.equal(error.state.partialSchemaPossible, false);
      assert.equal(JSON.stringify(error).includes('do-not-disclose'), false); assert.equal(error.message.includes('do-not-disclose'), false);
      return true;
    });
    assert.equal(checkouts, 1); assert.equal(released, 1);
    const locks = calls.filter((call) => call.sql === 'SELECT GET_LOCK(?, 0) AS acquired');
    assert.equal(locks.length, failure === 'target' ? 0 : 1);
    if (locks.length) assert.deepEqual(locks[0].parameters, [`cms-invites-setup:${createHash('sha256').update('expected').digest('hex').slice(0, 40)}`]);
    assert.equal(calls.filter((call) => call.sql === 'SELECT RELEASE_LOCK(?)').length, failure === 'schema' ? 1 : 0);
  }
});

test('Local invitation setup destroys a connection when releasing its setup lock fails', async () => {
  const plan = await initializeLocalInvitationsSchema(null); let destroyed = 0, released = 0;
  const connection = {
    async execute(sql) {
      if (sql === 'SELECT DATABASE() AS name') return [[{ name: 'expected' }]];
      if (sql === 'SELECT GET_LOCK(?, 0) AS acquired') return [[{ acquired: 1 }]];
      throw new Error('private connection failure');
    },
    release() { released++; }, destroy() { destroyed++; },
  };
  await assert.rejects(initializeLocalInvitationsSchema({ async getConnection() { return connection; } }, { apply: true, targetDatabase: 'expected', expectedSchemaSha256: plan.schemaSha256 }), LocalInvitationsSetupError);
  assert.equal(destroyed, 1); assert.equal(released, 0);
});

test('Local invitation command prints safe machine-readable diagnostics without echoing rejected input', () => {
  const result = spawnSync(process.execPath, [new URL('../scripts/setup-local-invitations.mjs', import.meta.url).pathname, '--database', 'private-token-do-not-echo'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('private-token-do-not-echo'), false);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error, 'local-invitations-setup-failed');
  assert.equal(report.message.includes('no successful setup is claimed'), true);
});
