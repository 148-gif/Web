import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeLocalAuthSchema, runLocalAuthSetup } from '../scripts/setup-local-auth.mjs';

test('local auth setup defaults to a credential-free dry plan with no database connection', async () => {
  let calls = 0;
  const report = await runLocalAuthSetup([], { values: new Proxy({}, { get() { throw new Error('must not inspect credentials'); } }), poolFactory() { calls++; throw new Error('must not connect'); } });
  assert.equal(calls, 0); assert.equal(report.apply, false); assert.equal(report.databaseConnected, false); assert.equal(report.schemaInitialized, false);
  assert.equal(report.createsPasswordsOrBootstrapCredentials, false);
  assert.equal(report.modifiesExistingTables, false); assert.equal(report.additiveTables.length, 3);
  assert.match(report.schemaSha256, /^[a-f0-9]{64}$/);
});

test('local auth setup rejects unreviewed hash, mismatched target and unknown flags before connection', async () => {
  const plan = await initializeLocalAuthSchema(null); let calls = 0;
  const dependencies = { values: { MYSQL_DATABASE: 'expected' }, poolFactory() { calls++; throw new Error('must not connect'); } };
  for (const args of [
    ['--apply', '--database', 'expected', '--schema-sha256', '0'.repeat(64)],
    ['--apply', '--database', 'different', '--schema-sha256', plan.schemaSha256],
    ['--apply', '--apply'], ['--force'], ['--database', 'expected'],
  ]) await assert.rejects(runLocalAuthSetup(args, dependencies));
  assert.equal(calls, 0);
});
