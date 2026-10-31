// Explicit additive preparation only. Runtime and HTTP handlers never run DDL.
// This creates an empty configuration singleton; it never activates Google or
// changes existing credentials, sessions, authentication settings or content.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { mysqlImportConnectionOptions } from './import-mysql-migration.mjs';

const TABLES = ['google_auth_config'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const validDatabase = (value) => typeof value === 'string' && /^[A-Za-z0-9_$]{1,64}$/.test(value);
export class GoogleAuthSetupError extends Error {
  constructor(message, state) { super(message); this.name = 'GoogleAuthSetupError'; this.state = state; }
}

export async function initializeGoogleAuthSchema(pool, { apply = false, targetDatabase, expectedSchemaSha256 } = {}) {
  const schema = await readFile(new URL('../server/mysql-google-auth-schema.sql', import.meta.url), 'utf8');
  const schemaSha256 = digest(schema);
  const plan = { format: 'heichal-google-auth-setup-v1', apply, schemaSha256, additiveTables: [...TABLES], modifiesExistingTables: false,
    createsPasswordsOrBootstrapCredentials: false, activatesGoogle: false, databaseConnected: false, schemaInitialized: false,
    notice: 'Back up the existing database first. MySQL DDL commits implicitly; a partial failure requires inspection, not automatic retry or deletion.' };
  if (!apply) return plan;
  if (!validDatabase(targetDatabase) || expectedSchemaSha256 !== schemaSha256) throw new GoogleAuthSetupError('Explicit target database and reviewed Google auth schema hash are required', plan);
  if (!pool || typeof pool.getConnection !== 'function') throw new GoogleAuthSetupError('An initialized MySQL pool is required', plan);
  const state = { ...plan, statementsCompleted: 0, partialSchemaPossible: false };
  let connection, locked = false;
  const lockName = `cms-google-auth-setup:${digest(targetDatabase).slice(0, 40)}`;
  try {
    connection = await pool.getConnection(); state.databaseConnected = true;
    const [databases] = await connection.execute('SELECT DATABASE() AS name');
    if (databases[0]?.name !== targetDatabase) throw new Error('Wrong database');
    const [lock] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Setup is already running');
    locked = true;
    // Schema guards and verification share the exclusive connection. This also
    // permits hosting pools configured with a single available connection.
    const view = { execute: (...args) => connection.execute(...args), getConnection: async () => ({ execute: (...args) => connection.execute(...args), release() {} }) };
    await createMysqlDataStore(view).ensureSchema();
    await createMysqlAuthStore(view).ensureSchema();
    const [existing] = await connection.execute('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', TABLES);
    if (existing.length) throw new GoogleAuthSetupError('Google authentication configuration already exists; inspect or verify it without reinitializing', state);
    const statements = schema.replace(/^\s*--.*$/gm, '').split(';').map((line) => line.trim()).filter(Boolean);
    if (statements.length !== 2 || !/^CREATE TABLE google_auth_config\s*\(/.test(statements[0]) || !/^INSERT INTO google_auth_config\s*\(/.test(statements[1])) throw new Error('Unexpected Google auth schema');
    for (const statement of statements) {
      state.partialSchemaPossible = true;
      await connection.query(statement); state.statementsCompleted++;
    }
    await createMysqlAuthStore(view, { googleSetup: true }).ensureSchema();
    return { ...state, schemaInitialized: true, partialSchemaPossible: false, verified: true };
  } catch (error) {
    if (error instanceof GoogleAuthSetupError) throw error;
    throw new GoogleAuthSetupError('Google authentication setup failed; inspect private diagnostics and any partial configuration schema before retrying', state);
  } finally {
    if (connection) {
      let releaseSafe = true;
      if (locked) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]); }
        catch {
          releaseSafe = false;
          try { connection.destroy(); } catch { /* Never return a possibly locked connection to the pool. */ }
        }
      }
      if (releaseSafe) connection.release();
    }
  }
}

function argsOf(args) {
  const out = { apply: false };
  const options = { '--database': 'targetDatabase', '--schema-sha256': 'expectedSchemaSha256' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { if (out.apply) throw new Error('Duplicate option'); out.apply = true; }
    else {
      const key = Object.hasOwn(options, args[i]) ? options[args[i]] : null;
      if (!key || out[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid setup option');
      out[key] = args[++i];
    }
  }
  if (!out.apply && (out.targetDatabase || out.expectedSchemaSha256)) throw new Error('Apply-only options require --apply');
  return out;
}

export async function runGoogleAuthSetup(args, { values = process.env, poolFactory } = {}) {
  const options = argsOf(args);
  if (!options.apply) return initializeGoogleAuthSchema(null, options);
  // Validate the reviewed plan before inspecting credentials or opening a socket.
  const plan = await initializeGoogleAuthSchema(null);
  if (options.expectedSchemaSha256 !== plan.schemaSha256 || !validDatabase(options.targetDatabase) || values.MYSQL_DATABASE !== options.targetDatabase) throw new Error('Explicit configured database and reviewed schema hash must match');
  const createPool = poolFactory || (await import('mysql2/promise')).createPool;
  const pool = createInitializedMysqlPool(await createPool(mysqlImportConnectionOptions(values, options.targetDatabase)));
  try { return await initializeGoogleAuthSchema(pool, options); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runGoogleAuthSetup(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) {
    const message = error instanceof GoogleAuthSetupError ? error.message : 'Invalid Google-auth setup options or configuration; no successful setup is claimed';
    process.stderr.write(JSON.stringify({ error: 'google-auth-setup-failed', message, ...(error instanceof GoogleAuthSetupError ? { state: error.state } : {}) }, null, 2) + '\n');
    process.exitCode = 1;
  }
}
