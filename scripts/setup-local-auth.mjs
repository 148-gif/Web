// Explicit additive preparation only. No password/bootstrap credential is
// created here. Startup and login never execute this schema migration.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { mysqlImportConnectionOptions } from './import-mysql-migration.mjs';

const TABLES = ['local_auth_settings', 'local_auth_users', 'local_auth_sessions'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
export class LocalAuthSetupError extends Error {
  constructor(message, state) { super(message); this.name = 'LocalAuthSetupError'; this.state = state; }
}

export async function initializeLocalAuthSchema(pool, { apply = false, targetDatabase, expectedSchemaSha256 } = {}) {
  const schema = await readFile(new URL('../server/mysql-auth-schema.sql', import.meta.url), 'utf8');
  const schemaSha256 = digest(schema);
  const plan = { format: 'heichal-local-auth-setup-v1', apply, schemaSha256, additiveTables: TABLES, modifiesExistingTables: false,
    createsPasswordsOrBootstrapCredentials: false, databaseConnected: false, schemaInitialized: false,
    notice: 'Back up the existing database first. MySQL DDL commits implicitly; a partial failure requires inspection, not automatic retry or deletion.' };
  if (!apply) return plan;
  if (typeof targetDatabase !== 'string' || !/^[A-Za-z0-9_$]{1,64}$/.test(targetDatabase) || expectedSchemaSha256 !== schemaSha256) throw new LocalAuthSetupError('Explicit target database and reviewed auth schema hash are required', plan);
  if (!pool || typeof pool.getConnection !== 'function') throw new LocalAuthSetupError('An initialized MySQL pool is required', plan);
  const state = { ...plan, statementsCompleted: 0, partialSchemaPossible: false };
  let connection, locked = false;
  const lockName = `cms-auth-setup:${digest(targetDatabase).slice(0, 40)}`;
  try {
    // All existing content/schema guards still apply; no source data is imported.
    await createMysqlDataStore(pool).ensureSchema(); state.databaseConnected = true;
    connection = await pool.getConnection();
    const [databases] = await connection.query('SELECT DATABASE() AS name');
    if (databases[0]?.name !== targetDatabase) throw new Error('Wrong database');
    const [lock] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Setup is already running');
    locked = true;
    const [existing] = await connection.execute('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)', TABLES);
    if (existing.length) throw new LocalAuthSetupError('Authentication tables already exist; inspect or verify them without reinitializing', state);
    const statements = schema.replace(/^\s*--.*$/gm, '').split(';').map((line) => line.trim()).filter(Boolean);
    if (statements.length !== 4) throw new Error('Unexpected auth schema');
    for (const statement of statements) {
      state.partialSchemaPossible = true;
      await connection.query(statement); state.statementsCompleted++;
    }
    // Verify using the same exclusively held connection, with no nested pool
    // checkout (hosting can configure connectionLimit=1).
    const view = { execute: (...args) => connection.execute(...args), getConnection: async () => ({ execute: (...args) => connection.execute(...args), release() {} }) };
    await createMysqlAuthStore(view).ensureSchema();
    return { ...state, schemaInitialized: true, partialSchemaPossible: false, verified: true };
  } catch (error) {
    if (error instanceof LocalAuthSetupError) throw error;
    throw new LocalAuthSetupError('Local authentication setup failed; inspect private diagnostics and any partial auth schema before retrying', state);
  } finally {
    if (connection) {
      let releaseSafe = true;
      if (locked) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]); }
        catch { releaseSafe = false; connection.destroy(); }
      }
      if (releaseSafe) connection.release();
    }
  }
}

function argsOf(args) {
  const out = { apply: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { if (out.apply) throw new Error('Duplicate option'); out.apply = true; }
    else {
      const key = { '--database': 'targetDatabase', '--schema-sha256': 'expectedSchemaSha256' }[args[i]];
      if (!key || out[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid setup option');
      out[key] = args[++i];
    }
  }
  if (!out.apply && (out.targetDatabase || out.expectedSchemaSha256)) throw new Error('Apply-only options require --apply');
  return out;
}

export async function runLocalAuthSetup(args, { values = process.env, poolFactory } = {}) {
  const options = argsOf(args);
  if (!options.apply) return initializeLocalAuthSchema(null, options);
  // Validate the reviewed plan before reading credentials or opening a socket.
  const plan = await initializeLocalAuthSchema(null);
  if (options.expectedSchemaSha256 !== plan.schemaSha256 || typeof options.targetDatabase !== 'string' || !/^[A-Za-z0-9_$]{1,64}$/.test(options.targetDatabase) || values.MYSQL_DATABASE !== options.targetDatabase) throw new Error('Explicit configured database and reviewed schema hash must match');
  const createPool = poolFactory || (await import('mysql2/promise')).createPool;
  const pool = createInitializedMysqlPool(await createPool(mysqlImportConnectionOptions(values, options.targetDatabase)));
  try { return await initializeLocalAuthSchema(pool, options); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runLocalAuthSetup(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) {
    const message = error instanceof LocalAuthSetupError ? error.message : 'Invalid local-auth setup options or configuration; no successful setup is claimed';
    process.stderr.write(JSON.stringify({ error: 'local-auth-setup-failed', message, ...(error instanceof LocalAuthSetupError ? { state: error.state } : {}) }, null, 2) + '\n');
    process.exitCode = 1;
  }
}
