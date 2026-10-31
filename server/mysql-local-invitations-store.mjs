// Optional Node-only invitation persistence. No DDL or authority decisions.
// Mutations must share the caller's local_auth_settings FOR UPDATE transaction.
import { queryRows, safeInteger } from './mysql-core.mjs';

const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/;
const TABLE = 'local_auth_invitations';
const COLUMNS = ['owner_hash', 'token_hash', 'issuer_id', 'issuer_version', 'expires_at', 'consumed'];
const TYPES = ['char(64)', 'char(64)', 'char(32)', 'bigint unsigned', 'bigint unsigned', 'tinyint unsigned'];
const CHECKS = {
  local_auth_invitation_version: 'issuer_version between 1 and 9007199254740991',
  local_auth_invitation_expiry: 'expires_at between 1 and 9007199254740991',
  local_auth_invitation_consumed: 'consumed in (0, 1)',
};
const invalid = () => { throw new Error('Invalid local invitation state'); };
const checkedHash = (value) => { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; };
const positive = (value) => { let n; try { n = safeInteger(value); } catch { return invalid(); } if (n < 1) invalid(); return n; };
const boolean = (value) => {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return invalid();
};

export function normalizeLocalInvitation(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Reflect.ownKeys(row).length !== COLUMNS.length || COLUMNS.some((key) => !Object.hasOwn(row, key)) || typeof row.issuer_id !== 'string' || !ID.test(row.issuer_id)) invalid();
  return { owner_hash: checkedHash(row.owner_hash), token_hash: checkedHash(row.token_hash), issuer_id: row.issuer_id,
    issuer_version: positive(row.issuer_version), expires_at: positive(row.expires_at), consumed: boolean(row.consumed) };
}

export async function getLocalInvitationByHash(connection, value) {
  const rows = await queryRows(connection, 'SELECT * FROM local_auth_invitations WHERE token_hash = ?', [checkedHash(value)]);
  if (rows.length > 1) invalid();
  return rows.length ? normalizeLocalInvitation(rows[0]) : null;
}

export async function saveLocalInvitation(connection, value) {
  const next = normalizeLocalInvitation(value);
  const rows = await queryRows(connection, 'SELECT * FROM local_auth_invitations WHERE owner_hash = ?', [next.owner_hash]);
  if (rows.length > 1) invalid();
  const before = rows.length ? normalizeLocalInvitation(rows[0]) : null;
  if (!before) {
    if (next.consumed) invalid();
    // No ON DUPLICATE KEY UPDATE: a token collision with another owner's slot
    // must fail, never update that other owner through the secondary unique key.
    await connection.execute('INSERT INTO local_auth_invitations (owner_hash, token_hash, issuer_id, issuer_version, expires_at, consumed) VALUES (?, ?, ?, ?, ?, ?)', COLUMNS.map((key) => key === 'consumed' ? Number(next[key]) : next[key]));
    return;
  }
  if (before.consumed && COLUMNS.some((key) => before[key] !== next[key])) invalid();
  if (before.token_hash === next.token_hash) {
    if (COLUMNS.some((key) => key !== 'consumed' && before[key] !== next[key])) invalid();
  } else if (next.consumed) invalid();
  await connection.execute('UPDATE local_auth_invitations SET token_hash = ?, issuer_id = ?, issuer_version = ?, expires_at = ?, consumed = ? WHERE owner_hash = ?',
    [next.token_hash, next.issuer_id, next.issuer_version, next.expires_at, Number(next.consumed), next.owner_hash]);
}

export async function verifyLocalInvitationsSchema(pool) {
  const connection = await pool.getConnection();
  try {
    const tables = await queryRows(connection, 'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]);
    if (tables.length !== 1 || tables[0].engine !== 'InnoDB' || tables[0].collation !== 'utf8mb4_0900_bin') throw new Error('Invalid required local invitation table');
    const columns = await queryRows(connection, 'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [TABLE]);
    if (columns.length !== COLUMNS.length || columns.some((column, index) => column.name !== COLUMNS[index] || column.type !== TYPES[index] || column.nullable !== 'NO' || (column.collation !== null && column.collation !== 'utf8mb4_0900_bin'))) throw new Error('Invalid required local invitation columns');
    const indexes = await queryRows(connection, 'SELECT INDEX_NAME AS name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [TABLE]);
    const expected = { PRIMARY: 'owner_hash', local_auth_invitation_token: 'token_hash' };
    if (indexes.length !== 2 || indexes.some((index) => !Object.hasOwn(expected, index.name) || index.column_name !== expected[index.name] || Number(index.non_unique) !== 0) || new Set(indexes.map((index) => index.name)).size !== 2) throw new Error('Invalid required local invitation indexes');
    const constraints = await queryRows(connection, 'SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause, tc.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = ? ORDER BY tc.CONSTRAINT_NAME', [TABLE, 'CHECK']);
    const normalized = (clause) => typeof clause === 'string' ? clause.toLowerCase().replace(/[`\s()]/g, '') : '';
    if (constraints.length !== 3 || constraints.some((constraint) => !Object.hasOwn(CHECKS, constraint.name) || constraint.enforced !== 'YES' || normalized(constraint.clause) !== normalized(CHECKS[constraint.name])) || new Set(constraints.map((constraint) => constraint.name)).size !== 3) throw new Error('Invalid required local invitation constraints');
    return { localInvitationsSchemaVerified: true };
  } finally { connection.release(); }
}
