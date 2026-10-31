// Optional Node-only auth persistence. Fixed SQL, explicit transactions, no DDL.
// All credential/session/settings mutations lock settings before reading, then
// the Google configuration singleton when that optional addon is enabled.
import { queryRows, safeInteger, withTransaction } from './mysql-core.mjs';
import { getGoogleConfig, lockGoogleConfig, saveGoogleConfig, verifyGoogleAuthSchema } from './mysql-google-auth-store.mjs';
import { getLocalInvitationByHash, saveLocalInvitation, verifyLocalInvitationsSchema } from './mysql-local-invitations-store.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const ROLES = new Set(['owner', 'editor', 'publisher']);
const COLUMNS = {
  local_auth_settings: ['id', 'local_enabled', 'google_enabled', 'local_verified', 'google_verified_until', 'bootstrap_hash', 'bootstrap_expires', 'bootstrap_owner_hash', 'bootstrap_consumed'],
  local_auth_users: ['id', 'username', 'display_name', 'password_hash', 'owner_hash', 'role', 'version', 'disabled'],
  local_auth_sessions: ['token_hash', 'csrf_hash', 'user_id', 'version', 'expires_at'],
};
const TYPES = {
  local_auth_settings: ['tinyint unsigned', 'tinyint unsigned', 'tinyint unsigned', 'tinyint unsigned', 'bigint unsigned', 'char(64)', 'bigint unsigned', 'char(64)', 'tinyint unsigned'],
  local_auth_users: ['char(32)', 'varchar(64)', 'varchar(40)', 'varchar(256)', 'char(64)', 'varchar(16)', 'bigint unsigned', 'tinyint unsigned'],
  local_auth_sessions: ['char(64)', 'char(64)', 'char(32)', 'bigint unsigned', 'bigint unsigned'],
};
const NULLABLE = new Set(['local_auth_settings.bootstrap_hash', 'local_auth_settings.bootstrap_owner_hash']);
const INDEXES = {
  local_auth_settings: { PRIMARY: ['id'] },
  local_auth_users: { PRIMARY: ['id'], local_auth_username: ['username'] },
  local_auth_sessions: { PRIMARY: ['token_hash'], local_auth_session_user: ['user_id'], local_auth_session_expiry: ['expires_at'] },
};
const invalid = () => { throw new Error('Invalid local authentication state'); };
function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function username(value) { if (typeof value !== 'string' || !USERNAME.test(value)) invalid(); return value; }
function number(value, positive = false) { const n = safeInteger(value, 'local authentication number'); if (positive && n < 1) invalid(); return n; }
function bool(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return invalid();
}
function settingsRow(row) {
  if (!row || number(row.id) !== 1) invalid();
  const out = {
    id: 1, local_enabled: bool(row.local_enabled), google_enabled: bool(row.google_enabled), local_verified: bool(row.local_verified),
    google_verified_until: number(row.google_verified_until), bootstrap_hash: row.bootstrap_hash === null ? null : hash(row.bootstrap_hash),
    bootstrap_expires: number(row.bootstrap_expires), bootstrap_owner_hash: row.bootstrap_owner_hash === null ? null : hash(row.bootstrap_owner_hash), bootstrap_consumed: bool(row.bootstrap_consumed),
  };
  if (!out.local_enabled && !out.google_enabled) invalid();
  if (out.bootstrap_hash === null ? out.bootstrap_owner_hash !== null || out.bootstrap_expires !== 0 : out.bootstrap_owner_hash === null || out.bootstrap_expires === 0) invalid();
  if (out.bootstrap_consumed && out.bootstrap_hash !== null) invalid();
  return out;
}
function userRow(row) {
  if (!row) return null;
  const out = { id: id(row.id), username: username(row.username), display_name: row.display_name, password_hash: row.password_hash,
    owner_hash: hash(row.owner_hash), role: row.role, version: number(row.version, true), disabled: bool(row.disabled) };
  if (typeof out.display_name !== 'string' || [...out.display_name].length > 40 || /[\p{Cc}<>]/u.test(out.display_name) ||
      typeof out.password_hash !== 'string' || out.password_hash.length < 1 || out.password_hash.length > 256 || /[\p{Cc}]/u.test(out.password_hash) || !ROLES.has(out.role)) invalid();
  return out;
}
function sessionRow(row) {
  if (!row) return null;
  return { token_hash: hash(row.token_hash), csrf_hash: hash(row.csrf_hash), user_id: id(row.user_id), version: number(row.version, true), expires_at: number(row.expires_at, true) };
}

async function verifySchema(pool) {
  const c = await pool.getConnection();
  try {
    const [runtime] = await queryRows(c, 'SELECT VERSION() AS version, @@SESSION.sql_mode AS mode');
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(runtime?.version || '');
    if (!version || /mariadb/i.test(runtime.version) || Number(version[1]) < 8 || (Number(version[1]) === 8 && Number(version[2]) < 4)) throw new Error('MySQL 8.4 or newer is required for local authentication');
    if (!String(runtime.mode).split(',').some((m) => ['STRICT_ALL_TABLES', 'STRICT_TRANS_TABLES'].includes(m))) throw new Error('MySQL strict SQL mode is required');
    const tables = await queryRows(c, 'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    const columns = await queryRows(c, 'SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION');
    const indexes = await queryRows(c, 'SELECT TABLE_NAME AS table_name, INDEX_NAME AS name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY INDEX_NAME, SEQ_IN_INDEX');
    for (const [table, expected] of Object.entries(COLUMNS)) {
      const meta = tables.find((r) => r.name === table), actual = columns.filter((r) => r.table_name === table);
      if (!meta || meta.engine !== 'InnoDB' || meta.collation !== 'utf8mb4_0900_bin') throw new Error(`Invalid required local authentication table: ${table}`);
      if (actual.map((r) => r.name).join(',') !== expected.join(',') || actual.some((r, i) => r.type !== TYPES[table][i] ||
        (r.nullable === 'YES') !== NULLABLE.has(`${table}.${r.name}`) || (r.collation !== null && r.collation !== 'utf8mb4_0900_bin'))) throw new Error(`Invalid required local authentication columns: ${table}`);
      for (const [name, keys] of Object.entries(INDEXES[table])) {
        const keyRows = indexes.filter((r) => r.table_name === table && r.name === name);
        const unique = name === 'PRIMARY' || name === 'local_auth_username';
        if (keyRows.map((r) => r.column_name).join(',') !== keys.join(',') || keyRows.some((r) => number(r.non_unique) !== Number(!unique))) throw new Error(`Invalid required local authentication index: ${table}`);
      }
    }
    const settings = await queryRows(c, 'SELECT * FROM local_auth_settings');
    if (settings.length !== 1) invalid();
    settingsRow(settings[0]);
    return { schemaVerified: true, version: runtime.version };
  } finally { c.release(); }
}

export function createMysqlAuthStore(pool, { googleSetup = false, localInvitations = false } = {}) {
  if (!pool || typeof pool.execute !== 'function' || typeof pool.getConnection !== 'function') throw new TypeError('A MySQL pool is required');
  if (typeof googleSetup !== 'boolean') throw new TypeError('Google setup option must be boolean');
  if (typeof localInvitations !== 'boolean') throw new TypeError('Local invitation option must be boolean');
  let ready;
  const first = async (connection, sql, values = []) => (await queryRows(connection, sql, values))[0] || null;
  const reads = (c, guard = () => {}) => ({
    async getSettings() { guard(); return settingsRow(await first(c, 'SELECT * FROM local_auth_settings WHERE id = 1')); },
    async getUserByUsername(value) { guard(); return userRow(await first(c, 'SELECT * FROM local_auth_users WHERE username = ?', [username(value)])); },
    async getUserById(value) { guard(); return userRow(await first(c, 'SELECT * FROM local_auth_users WHERE id = ?', [id(value)])); },
    async getSession(value) { guard(); return sessionRow(await first(c, 'SELECT * FROM local_auth_sessions WHERE token_hash = ?', [hash(value)])); },
    async countUsers() { guard(); return number((await first(c, 'SELECT COUNT(*) AS n FROM local_auth_users')).n); },
    ...(googleSetup ? { async getGoogleConfig() { guard(); return getGoogleConfig(c); } } : {}),
    ...(localInvitations ? {
      async getInvitationByHash(value) { guard(); return getLocalInvitationByHash(c, value); },
      async getUserByOwnerHash(value) {
        guard(); const rows = await queryRows(c, 'SELECT * FROM local_auth_users WHERE owner_hash = ? LIMIT 2', [hash(value)]);
        if (rows.length > 1) invalid();
        return rows.length ? userRow(rows[0]) : null;
      },
    } : {}),
  });
  return {
    ensureSchema() { return ready ||= verifySchema(pool).then(async (base) => ({ ...base,
      ...(googleSetup ? await verifyGoogleAuthSchema(pool) : {}),
      ...(localInvitations ? await verifyLocalInvitationsSchema(pool) : {}),
    })).catch((error) => { ready = undefined; throw error; }); },
    ...reads(pool),
    atomic(fn) {
      if (typeof fn !== 'function') throw new TypeError('An authentication transaction callback is required');
      return withTransaction(pool, async (c) => {
        const locked = await queryRows(c, 'SELECT * FROM local_auth_settings WHERE id = 1 FOR UPDATE');
        if (locked.length !== 1) invalid();
        settingsRow(locked[0]);
        if (googleSetup) await lockGoogleConfig(c);
        let active = true;
        const guard = () => { if (!active) throw new Error('Authentication transaction has ended'); };
        const tx = {
          ...reads(c, guard),
          ...(googleSetup ? { async saveGoogleConfig(value) { guard(); await saveGoogleConfig(c, value); } } : {}),
          ...(localInvitations ? { async saveInvitation(value) { guard(); await saveLocalInvitation(c, value); } } : {}),
          async saveSettings(value) {
            guard(); const s = settingsRow(value);
            if ((await tx.getSettings()).bootstrap_consumed && !s.bootstrap_consumed) invalid();
            await c.execute('UPDATE local_auth_settings SET local_enabled = ?, google_enabled = ?, local_verified = ?, google_verified_until = ?, bootstrap_hash = ?, bootstrap_expires = ?, bootstrap_owner_hash = ?, bootstrap_consumed = ? WHERE id = 1', [Number(s.local_enabled), Number(s.google_enabled), Number(s.local_verified), s.google_verified_until, s.bootstrap_hash, s.bootstrap_expires, s.bootstrap_owner_hash, Number(s.bootstrap_consumed)]);
          },
          async insertUser(value) {
            guard(); const u = userRow(value); if (!u) invalid();
            await c.execute('INSERT INTO local_auth_users (id, username, display_name, password_hash, owner_hash, role, version, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [u.id, u.username, u.display_name, u.password_hash, u.owner_hash, u.role, u.version, Number(u.disabled)]);
          },
          async saveUser(value) {
            guard(); const u = userRow(value); if (!u) invalid();
            const before = await tx.getUserById(u.id);
            if (!before || before.username !== u.username || before.owner_hash !== u.owner_hash || before.role !== u.role || u.version < before.version) invalid();
            if ((before.password_hash !== u.password_hash || before.disabled !== u.disabled) && u.version <= before.version) invalid();
            await c.execute('UPDATE local_auth_users SET display_name = ?, password_hash = ?, version = ?, disabled = ? WHERE id = ?', [u.display_name, u.password_hash, u.version, Number(u.disabled), u.id]);
          },
          async insertSession(value) {
            guard(); const s = sessionRow(value); if (!s) invalid();
            const user = await tx.getUserById(s.user_id);
            if (!user || user.disabled || user.version !== s.version) invalid();
            await c.execute('INSERT INTO local_auth_sessions (token_hash, csrf_hash, user_id, version, expires_at) VALUES (?, ?, ?, ?, ?)', [s.token_hash, s.csrf_hash, s.user_id, s.version, s.expires_at]);
          },
          async deleteSession(value) { guard(); await c.execute('DELETE FROM local_auth_sessions WHERE token_hash = ?', [hash(value)]); },
          async deleteUserSessions(value) { guard(); await c.execute('DELETE FROM local_auth_sessions WHERE user_id = ?', [id(value)]); },
          async deleteAllSessions() { guard(); await c.execute('DELETE FROM local_auth_sessions'); },
          async pruneSessions(userId, now, maximum = 8) {
            guard(); id(userId); number(now);
            if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) invalid();
            await c.execute('DELETE FROM local_auth_sessions WHERE expires_at <= ?', [now]);
            const count = number((await first(c, 'SELECT COUNT(*) AS n FROM local_auth_sessions WHERE user_id = ?', [userId])).n);
            const excess = count - maximum + 1;
            if (excess > 0) await c.execute('DELETE FROM local_auth_sessions WHERE user_id = ? ORDER BY expires_at, token_hash LIMIT ?', [userId, excess]);
          },
        };
        try { return await fn(tx); }
        finally { active = false; }
      });
    },
  };
}
