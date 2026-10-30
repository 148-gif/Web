// A fresh-target importer, deliberately separate from the running API. The
// default validates a snapshot without obtaining a database connection. MySQL
// DDL commits implicitly; failed initialization is retained for investigation.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { planMigration } from './migration.mjs';

const COLUMNS = Object.freeze({
  drafts: ['path', 'content', 'deleted', 'base_sha', 'created_at', 'updated_at', 'email', 'name'],
  log: ['id', 'ts', 'email', 'name', 'action', 'path', 'summary', 'sha'],
  media: ['id', 'name', 'kind', 'mime', 'size', 'store', 'key', 'status', 'email', 'by_name', 'created_at'],
  media_chunks: ['id', 'n', 'data'], ai_usage: ['day', 'email', 'n'], editors_kv: ['key', 'value'],
});
const NUMBERS = Object.freeze({
  drafts: ['deleted', 'created_at', 'updated_at'], log: ['id', 'ts'],
  media: ['size', 'created_at'], media_chunks: ['n'], ai_usage: ['n'], editors_kv: [],
});
const SCHEMA_TABLES = [...Object.keys(COLUMNS), 'request_limits', 'cms_locks'];
const MAX_INPUT = 64 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new MysqlImportError(code, message); };
const safeNumber = (value) => {
  if ((typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') ||
      (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)$/.test(value))) fail('readback-number', 'The target returned an invalid numeric value');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0) || (typeof value === 'bigint' && BigInt(number) !== value)) fail('readback-number', 'The target returned an inexact numeric value');
  return number;
};

export class MysqlImportError extends Error {
  constructor(code, message, state = {}) {
    super(message); this.name = 'MysqlImportError'; this.code = code; this.state = state;
  }
}

function canonicalRows(table, rows) {
  return rows.map((row) => JSON.stringify(COLUMNS[table].map((column) => {
    if (!Object.hasOwn(row, column)) fail('readback-column', 'The target omitted a required column');
    const value = row[column];
    if (NUMBERS[table].includes(column)) return safeNumber(value);
    if (value !== null && typeof value !== 'string') fail('readback-text', 'The target did not return exact text or null');
    return value;
  }))).sort();
}

function tableFingerprint(table, rows) {
  const canonical = canonicalRows(table, rows), hash = createHash('sha256');
  for (const row of canonical) hash.update(row).update('\n');
  return { count: rows.length, sha256: hash.digest('hex'), canonical };
}

function schemaStatements(schema) {
  const statements = schema.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').split(';').map((sql) => sql.trim()).filter(Boolean);
  const created = [];
  for (const sql of statements) {
    const create = /^CREATE TABLE\s+`?([a-z_]+)`?\s*\(/.exec(sql);
    if (create && SCHEMA_TABLES.includes(create[1]) && !created.includes(create[1])) { created.push(create[1]); continue; }
    if (/^INSERT INTO\s+`?cms_locks`?\s*\(/.test(sql)) continue;
    fail('schema-artifact', 'The reviewed schema contains an unexpected statement');
  }
  if (created.length !== SCHEMA_TABLES.length) fail('schema-artifact', 'The reviewed schema does not define the complete target');
  return statements;
}

async function inspectTarget(connection, database, estimatedPacketBytes) {
  const [runtime] = await connection.query('SELECT DATABASE() AS database_name, VERSION() AS version, @@SESSION.max_allowed_packet AS packet_bytes');
  if (runtime[0]?.database_name !== database) fail('target-database', 'The connected database differs from the explicitly selected target');
  const version = String(runtime[0]?.version || ''), numbers = /^(\d+)\.(\d+)\./.exec(version);
  if (!numbers || /mariadb/i.test(version) || Number(numbers[1]) < 8 || (Number(numbers[1]) === 8 && Number(numbers[2]) < 4)) fail('target-version', 'The importer requires MySQL 8.4 or newer');
  const packetBytes = safeNumber(runtime[0]?.packet_bytes);
  if (packetBytes < 16 * 1024 * 1024 || estimatedPacketBytes + 65536 >= packetBytes) fail('target-packet-budget', 'The target packet limit is too small for the preserved rows and runtime');
  const [collations] = await connection.execute('SELECT PAD_ATTRIBUTE AS pad_attribute FROM information_schema.COLLATIONS WHERE COLLATION_NAME = ?', ['utf8mb4_0900_bin']);
  if (collations[0]?.pad_attribute !== 'NO PAD') fail('target-collation', 'The target lacks the required byte-exact NO PAD collation');
  // Refuse unknown objects too: the selected database is dedicated and empty,
  // never an existing application database whose tables merely appear empty.
  const [objects] = await connection.execute(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
    UNION ALL SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
    UNION ALL SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`, [database, database, database]);
  if (objects.length) fail('target-not-empty', 'The target database already contains objects; nothing may be overwritten');
  return { version, packetBytes };
}

async function verifyReadback(connection, expected) {
  const verified = {};
  for (const table of Object.keys(COLUMNS)) {
    const columns = COLUMNS[table].map((column) => `\`${column}\``).join(', ');
    const [rows] = await connection.query(`SELECT ${columns} FROM \`${table}\``);
    const actual = tableFingerprint(table, rows), wanted = tableFingerprint(table, expected[table]);
    if (actual.count !== wanted.count || actual.sha256 !== wanted.sha256 || actual.canonical.some((row, index) => row !== wanted.canonical[index])) fail('readback-mismatch', `Exact readback verification failed for ${table}`);
    verified[table] = { count: actual.count, sha256: actual.sha256 };
  }
  const [limits] = await connection.query('SELECT COUNT(*) AS n FROM request_limits');
  if (safeNumber(limits[0]?.n) !== 0) fail('readback-runtime-state', 'Transient request limits must be empty after import');
  const [locks] = await connection.query('SELECT name FROM cms_locks ORDER BY name');
  if (JSON.stringify(locks.map((row) => row.name)) !== JSON.stringify(['ai', 'kv:editors', 'kv:owner-names', 'kv:people', 'media'])) fail('readback-runtime-state', 'The target lock seeds differ from the reviewed schema');
  const [next] = await connection.query("SELECT AUTO_INCREMENT AS next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log'");
  const nextId = safeNumber(next[0]?.next_id), maximum = expected.log.reduce((n, row) => Math.max(n, row.id), 0);
  if (nextId <= maximum || nextId > Number.MAX_SAFE_INTEGER) fail('readback-log-sequence', 'The next activity-log ID is not safe');
  return { tables: verified, nextLogId: nextId, transientLimitsEmpty: true };
}

/**
 * createPool is deliberately a callback: dry-run and invalid input never call
 * it or read connection credentials. The callback returns an owned pool which
 * is always closed. Apply requires both hashes from a prior dry-run and an
 * explicit empty, isolated database; it cannot resume or overwrite an import.
 */
export async function importMysqlSnapshot({ snapshot, apply = false, initializeSchema = false, targetIsIsolated = false,
  targetDatabase, expectedSourceSha256, expectedSchemaSha256, createPool, maxInputBytes = MAX_INPUT, planOptions } = {}) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || typeof apply !== 'boolean') fail('options', 'Invalid import options');
  let sourceText, source;
  try {
    source = structuredClone(snapshot); sourceText = JSON.stringify(source);
  } catch { fail('snapshot-json', 'Snapshot must be serializable data'); }
  if (typeof sourceText !== 'string' || Buffer.byteLength(sourceText) > maxInputBytes) fail('snapshot-size', 'Snapshot exceeds the import input budget');
  const plan = planMigration(source, planOptions);
  const schema = await readFile(new URL('./mysql-schema.sql', import.meta.url), 'utf8');
  const sourceSha256 = digest(sourceText), schemaSha256 = digest(schema), report = {
    format: 'heichal-cms-mysql-import', version: 1, mode: apply ? 'apply' : 'dry-run',
    sourceSha256, sourceHashFormat: 'UTF-8 JSON.stringify(snapshot)', schemaSha256, counts: plan.counts, blockers: plan.blockers,
    readyToImport: plan.readyToImport, databaseConnected: false, databaseModified: false,
    imported: false, deploymentReady: false,
    externalDependenciesVerified: false,
    notice: 'Database verification does not verify source snapshot consistency, Git content, media objects, backups, or deployment readiness.',
  };
  if (!apply) return report;
  if (!plan.readyToImport) fail('snapshot-blocked', 'The validated snapshot contains unresolved import blockers');
  if (initializeSchema !== true || targetIsIsolated !== true) fail('target-confirmation', 'Apply requires explicit schema initialization and an isolated target');
  if (typeof targetDatabase !== 'string' || !/^[A-Za-z0-9_$]{1,64}$/.test(targetDatabase)) fail('target-name', 'Apply requires an explicit valid target database name');
  if (expectedSourceSha256 !== sourceSha256 || expectedSchemaSha256 !== schemaSha256) fail('reviewed-hash-mismatch', 'The source or schema differs from the explicitly reviewed dry-run hashes');
  if (typeof createPool !== 'function') fail('connection-factory', 'Apply requires an explicit connection factory');
  const statements = schemaStatements(schema), operations = plan.batches.flatMap((batch) => batch.operations);
  const packetEstimate = operations.reduce((maximum, operation) => Math.max(maximum, Buffer.byteLength(JSON.stringify(operation)) + 128), 0);
  const expected = { ...source.tables, editors_kv: Object.entries(source.kv).map(([key, value]) => ({ key, value })) };
  const state = { databaseConnected: false, schemaStatementsAttempted: 0, schemaStatementsCompleted: 0, schemaOutcomeUnknown: false, schemaInitialized: false, transactionStarted: false, rowsCommitted: false, rollbackAttempted: false, transactionRolledBack: false, commitOutcomeUnknown: false };
  let pool, connection, lockAcquired = false;
  const lockName = `cms-import:${digest(targetDatabase).slice(0, 48)}`;
  try {
    pool = await createPool(); connection = await pool.getConnection(); state.databaseConnected = true;
    const [lock] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (safeNumber(lock[0]?.acquired) !== 1) fail('target-busy', 'Another importer holds the target lock');
    lockAcquired = true;
    const target = await inspectTarget(connection, targetDatabase, packetEstimate);
    await connection.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin');
    for (const statement of statements) {
      state.schemaStatementsAttempted++; state.schemaOutcomeUnknown = true;
      await connection.query(statement); state.schemaStatementsCompleted++; state.schemaOutcomeUnknown = false;
    }
    state.schemaInitialized = true;
    // No DDL, truncate, schema cleanup, or batch commits inside this transaction.
    await connection.beginTransaction(); state.transactionStarted = true;
    for (const operation of operations) await connection.execute(operation.sql, operation.values);
    const verification = await verifyReadback(connection, expected);
    state.commitOutcomeUnknown = true;
    await connection.commit(); state.rowsCommitted = true; state.commitOutcomeUnknown = false;
    return { ...report, databaseConnected: true, databaseModified: true, imported: true, schemaInitialized: true,
      rowsCommitted: true, targetVersion: target.version, verification };
  } catch (error) {
    if (connection && state.transactionStarted && !state.rowsCommitted) {
      state.rollbackAttempted = true;
      try { await connection.rollback(); state.transactionRolledBack = !state.commitOutcomeUnknown; } catch { /* The target must be inspected before any retry. */ }
    }
    const code = error instanceof MysqlImportError ? error.code : 'database-operation-failed';
    const message = error instanceof MysqlImportError ? error.message : 'The import failed; inspect the isolated target and private database logs before any retry';
    throw new MysqlImportError(code, message, { ...state,
      databaseModified: state.schemaStatementsCompleted > 0 || state.commitOutcomeUnknown || state.schemaOutcomeUnknown || state.rowsCommitted,
      databaseMayHaveChanged: state.schemaStatementsAttempted > 0 || state.commitOutcomeUnknown || state.rowsCommitted });
  } finally {
    if (connection) {
      if (lockAcquired) { try { await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]); } catch { /* Closing the connection also releases the advisory lock. */ } }
      try { connection.release(); } catch { /* Closing the owned pool below also disposes of its connections. */ }
    }
    if (pool) { try { await pool.end(); } catch { /* Do not hide the import outcome. */ } }
  }
}
