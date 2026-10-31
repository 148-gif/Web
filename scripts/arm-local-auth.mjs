// Host-only CLI. Default invocation reports a plan without reading credentials,
// opening a database connection, or generating a bootstrap capability.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { armLocalAuth, LocalAuthBootstrapError } from '../server/local-auth-bootstrap.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { mysqlImportConnectionOptions } from './import-mysql-migration.mjs';

function argumentsOf(args) {
  const options = { arm: false };
  const names = { '--database': 'database', '--code-file': 'codeFile', '--owner-hash': 'ownerHash', '--minutes': 'minutes' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--arm' && !options.arm) options.arm = true;
    else {
      const key = names[arg];
      if (!key || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid bootstrap arming option');
      options[key] = args[++i];
    }
  }
  if (!options.arm && Object.keys(options).length !== 1) throw new Error('Arming options require explicit --arm');
  if (options.minutes !== undefined && !/^(?:[1-9]|[12][0-9]|30)$/.test(options.minutes)) throw new Error('Invalid bootstrap expiry');
  return options;
}

export async function runLocalAuthArm(args = [], { values = process.env, poolFactory } = {}) {
  const options = argumentsOf(args);
  if (!options.arm) return {
    mode: 'plan', armed: false, databaseConnected: false, capabilityCreated: false,
    operation: 'Explicit private bootstrap arming, not schema setup or password creation',
    requires: ['Installed optional auth schema', '--arm --database configured_database --code-file new_private_absolute_path', 'OWNERS and CMS_PUBLIC_ROOT configuration', 'Explicit --owner-hash if multiple owners are configured'],
    defaultMinutes: 15, maximumMinutes: 30, codeBytes: 32,
  };
  if (typeof options.database !== 'string' || !/^[A-Za-z0-9_$]{1,64}$/.test(options.database) || values.MYSQL_DATABASE !== options.database) throw new Error('The explicit database must match configured MYSQL_DATABASE');
  if (!options.codeFile) throw new Error('An explicit private code-file path is required');
  const createPool = poolFactory || (await import('mysql2/promise')).createPool;
  const pool = createInitializedMysqlPool(await createPool(mysqlImportConnectionOptions(values, options.database)));
  try {
    return await armLocalAuth({ store: createMysqlAuthStore(pool), owners: values.OWNERS, ownerHash: options.ownerHash,
      codeFile: options.codeFile, publicRoot: values.CMS_PUBLIC_ROOT,
      minutes: options.minutes === undefined ? 15 : Number(options.minutes) });
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runLocalAuthArm(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof LocalAuthBootstrapError ? error.code : 'bootstrap-arming-failed',
      message: error instanceof LocalAuthBootstrapError ? error.message : 'Invalid bootstrap options or private host configuration; no successful arming is claimed' }, null, 2) + '\n');
    process.exitCode = 1;
  }
}
