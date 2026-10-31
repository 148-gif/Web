// Optional Node-only Google configuration persistence. Fixed SQL, no DDL and
// no authorization decisions: callers retain the local owner/session checks.
import { queryRows, safeInteger } from './mysql-core.mjs';

export const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]{6,32}-[A-Za-z0-9_-]{10,160}\.apps\.googleusercontent\.com$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const COLUMNS = ['id', 'revision', 'active_version', 'active_client_id', 'pending_client_id', 'pending_nonce_hash', 'pending_session_hash', 'pending_user_id', 'pending_user_version', 'pending_owner_hash', 'pending_issued_at', 'pending_expires_at', 'verified_until'];
const TYPES = ['tinyint unsigned', 'bigint unsigned', 'bigint unsigned', 'varchar(255)', 'varchar(255)', 'char(64)', 'char(64)', 'char(32)', 'bigint unsigned', 'char(64)', 'bigint unsigned', 'bigint unsigned', 'bigint unsigned'];
const NULLABLE = new Set(['active_client_id', 'pending_client_id', 'pending_nonce_hash', 'pending_session_hash', 'pending_user_id', 'pending_owner_hash']);
const invalid = () => { throw new Error('Invalid Google authentication configuration'); };
function number(value, positive = false) {
  let result;
  try { result = safeInteger(value); } catch { return invalid(); }
  if (positive && result === 0) invalid();
  return result;
}
function nullable(value, pattern, maximum = Infinity) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}

export function normalizeGoogleConfig(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Reflect.ownKeys(row).length !== COLUMNS.length || COLUMNS.some((key) => !Object.hasOwn(row, key)) || number(row.id) !== 1) invalid();
  const result = {
    id: 1,
    revision: number(row.revision, true),
    active_version: number(row.active_version, true),
    active_client_id: nullable(row.active_client_id, GOOGLE_CLIENT_ID_PATTERN, 255),
    pending_client_id: nullable(row.pending_client_id, GOOGLE_CLIENT_ID_PATTERN, 255),
    pending_nonce_hash: nullable(row.pending_nonce_hash, HASH),
    pending_session_hash: nullable(row.pending_session_hash, HASH),
    pending_user_id: nullable(row.pending_user_id, ID),
    pending_user_version: number(row.pending_user_version),
    pending_owner_hash: nullable(row.pending_owner_hash, HASH),
    pending_issued_at: number(row.pending_issued_at),
    pending_expires_at: number(row.pending_expires_at),
    verified_until: number(row.verified_until),
  };
  if (result.pending_client_id === null) {
    if (result.pending_nonce_hash !== null || result.pending_session_hash !== null || result.pending_user_id !== null || result.pending_user_version !== 0 || result.pending_owner_hash !== null || result.pending_issued_at !== 0 || result.pending_expires_at !== 0 || result.verified_until !== 0) invalid();
  } else {
    if (result.pending_session_hash === null || result.pending_user_id === null || result.pending_user_version === 0 || result.pending_owner_hash === null || result.pending_issued_at === 0 || result.pending_expires_at <= result.pending_issued_at) invalid();
    if (result.pending_nonce_hash === null ? result.verified_until === 0 || result.verified_until > result.pending_expires_at : result.verified_until !== 0) invalid();
  }
  return result;
}

export async function getGoogleConfig(connection) {
  const rows = await queryRows(connection, 'SELECT * FROM google_auth_config WHERE id = 1');
  if (rows.length !== 1) invalid();
  return normalizeGoogleConfig(rows[0]);
}

export async function lockGoogleConfig(connection) {
  const rows = await queryRows(connection, 'SELECT * FROM google_auth_config WHERE id = 1 FOR UPDATE');
  if (rows.length !== 1) invalid();
  return normalizeGoogleConfig(rows[0]);
}

// The caller holds local_auth_settings followed by google_auth_config locks on
// this connection. Both tables are committed or rolled back in one transaction.
export async function saveGoogleConfig(connection, value) {
  const next = normalizeGoogleConfig(value), before = await getGoogleConfig(connection);
  const changed = COLUMNS.some((key) => next[key] !== before[key]);
  if (next.revision < before.revision || (changed && next.revision <= before.revision) || next.active_version < before.active_version || (next.active_client_id !== before.active_client_id && next.active_version <= before.active_version)) invalid();
  await connection.execute('UPDATE google_auth_config SET revision = ?, active_version = ?, active_client_id = ?, pending_client_id = ?, pending_nonce_hash = ?, pending_session_hash = ?, pending_user_id = ?, pending_user_version = ?, pending_owner_hash = ?, pending_issued_at = ?, pending_expires_at = ?, verified_until = ? WHERE id = 1', COLUMNS.slice(1).map((key) => next[key]));
}

export async function verifyGoogleAuthSchema(pool) {
  const connection = await pool.getConnection();
  try {
    const tables = await queryRows(connection, 'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['google_auth_config']);
    if (tables.length !== 1 || tables[0].engine !== 'InnoDB' || tables[0].collation !== 'utf8mb4_0900_bin') throw new Error('Invalid required Google authentication table: google_auth_config');
    const columns = await queryRows(connection, 'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', ['google_auth_config']);
    if (columns.length !== COLUMNS.length || columns.some((column, index) => column.name !== COLUMNS[index] || column.type !== TYPES[index] || (column.nullable === 'YES') !== NULLABLE.has(column.name) || (column.collation !== null && column.collation !== 'utf8mb4_0900_bin'))) throw new Error('Invalid required Google authentication columns: google_auth_config');
    const indexes = await queryRows(connection, 'SELECT INDEX_NAME AS name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', ['google_auth_config']);
    if (indexes.length !== 1 || indexes[0].name !== 'PRIMARY' || indexes[0].column_name !== 'id' || number(indexes[0].non_unique) !== 0) throw new Error('Invalid required Google authentication index: google_auth_config');
    const rows = await queryRows(connection, 'SELECT * FROM google_auth_config');
    if (rows.length !== 1) invalid();
    normalizeGoogleConfig(rows[0]);
    return { googleSchemaVerified: true };
  } finally { connection.release(); }
}
