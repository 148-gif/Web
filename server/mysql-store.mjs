// Typed MySQL implementation of cms-worker/data-store.mjs. Every SQL template
// is local and fixed; arbitrary D1 SQL is never translated or executed here.
import { execute, lockResource, normalizeRow, queryRows, safeInteger, withTransaction } from './mysql-core.mjs';

const marks = (n) => Array.from({ length: n }, () => '?').join(',');
const draftValues = (r) => [r.path, r.content, r.deleted, r.base_sha, r.created_at, r.updated_at, r.email, r.name];
// Explicit binary casts protect full snapshots even if the connection's own
// comparison collation differs. The reviewed columns additionally use NO_PAD.
const DRAFT_MATCH = '(path = ? AND BINARY content <=> BINARY ? AND deleted = ? AND BINARY base_sha <=> BINARY ? AND created_at = ? AND updated_at = ? AND BINARY email = BINARY ? AND BINARY name = BINARY ?)';
const MIN_PACKET = 16 * 1024 * 1024;
const COLUMNS = {
  drafts: ['path', 'content', 'deleted', 'base_sha', 'created_at', 'updated_at', 'email', 'name'],
  log: ['id', 'ts', 'email', 'name', 'action', 'path', 'summary', 'sha'],
  media: ['id', 'name', 'kind', 'mime', 'size', 'store', 'key', 'status', 'email', 'by_name', 'created_at'],
  media_chunks: ['id', 'n', 'data'], ai_usage: ['day', 'email', 'n'],
  editors_kv: ['key', 'value'], request_limits: ['scope', 'window_start', 'n', 'clients'], cms_locks: ['name'],
};
const PRIMARY = { drafts: ['path'], log: ['id'], media: ['id'], media_chunks: ['id', 'n'], ai_usage: ['day', 'email'], editors_kv: ['key'], request_limits: ['scope'], cms_locks: ['name'] };
const TYPES = {
  drafts: ['varchar(768)', 'mediumtext', 'tinyint unsigned', 'char(40)', 'bigint unsigned', 'bigint unsigned', 'varchar(254)', 'varchar(40)'],
  log: ['bigint unsigned', 'bigint unsigned', 'varchar(254)', 'varchar(40)', 'varchar(80)', 'mediumtext', 'mediumtext', 'char(40)'],
  media: ['varchar(128)', 'mediumtext', 'varchar(16)', 'varchar(100)', 'bigint unsigned', 'varchar(16)', 'varchar(768)', 'varchar(16)', 'varchar(254)', 'varchar(40)', 'bigint unsigned'],
  media_chunks: ['varchar(128)', 'bigint unsigned', 'mediumtext'], ai_usage: ['char(10)', 'varchar(254)', 'bigint unsigned'],
  editors_kv: ['varchar(32)', 'mediumtext'], request_limits: ['varchar(80)', 'bigint unsigned', 'bigint unsigned', 'mediumtext'], cms_locks: ['varchar(32)'],
};
const NULLABLE = new Set(['drafts.content', 'drafts.base_sha', 'log.email', 'log.name', 'log.path', 'log.summary', 'log.sha']);

async function verifySchema(pool) {
  const connection = await pool.getConnection();
  try {
    const [settings] = await queryRows(connection, 'SELECT DATABASE() AS db, @@version AS version, @@session.sql_mode AS mode, @@max_allowed_packet AS packet');
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(settings?.version || '');
    if (!settings?.db || !version || /mariadb/i.test(settings.version) || Number(version[1]) < 8 || (Number(version[1]) === 8 && Number(version[2]) < 4)) throw new Error('MySQL 8.4 or newer is required');
    if (!settings.mode.split(',').some((mode) => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(mode))) throw new Error('MySQL strict SQL mode is required');
    if (safeInteger(settings.packet, 'MySQL packet limit') < MIN_PACKET) throw new Error('MySQL max_allowed_packet must be at least 16 MiB');
    const tables = await queryRows(connection, 'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    for (const name of Object.keys(COLUMNS)) {
      const table = tables.find((row) => row.name === name);
      if (!table || table.engine !== 'InnoDB' || table.collation !== 'utf8mb4_0900_bin') throw new Error(`Invalid required MySQL table: ${name}`);
    }
    const columns = await queryRows(connection, 'SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLLATION_NAME AS collation, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION');
    for (const [table, expected] of Object.entries(COLUMNS)) {
      const actual = columns.filter((row) => row.table_name === table);
      if (actual.map((row) => row.name).join(',') !== expected.join(',') || actual.some((row, i) =>
        row.type !== TYPES[table][i] || (row.nullable === 'YES') !== NULLABLE.has(`${table}.${row.name}`) ||
        (row.collation !== null && row.collation !== 'utf8mb4_0900_bin'))) throw new Error(`Invalid required MySQL columns: ${table}`);
    }
    if (!columns.find((row) => row.table_name === 'log' && row.name === 'id')?.extra.includes('auto_increment')) throw new Error('The activity log requires AUTO_INCREMENT');
    const keys = await queryRows(connection, "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION");
    for (const [table, expected] of Object.entries(PRIMARY)) {
      if (keys.filter((row) => row.table_name === table).map((row) => row.name).join(',') !== expected.join(',')) throw new Error(`Invalid required MySQL primary key: ${table}`);
    }
    const locks = await queryRows(connection, 'SELECT name FROM cms_locks ORDER BY name');
    if (locks.map((row) => row.name).join(',') !== 'ai,kv:editors,kv:owner-names,kv:people,media') throw new Error('Required MySQL coordination locks are missing');
    return { version: settings.version, maxAllowedPacket: safeInteger(settings.packet), schemaVerified: true };
  } finally { connection.release(); }
}

export function createMysqlDataStore(pool) {
  if (!pool || typeof pool.execute !== 'function' || typeof pool.getConnection !== 'function') throw new TypeError('A MySQL pool is required');
  let ready;
  const rows = async (sql, values = [], connection = pool) => (await queryRows(connection, sql, values)).map((row) => normalizeRow(row));
  const first = async (sql, values = [], connection = pool) => (await rows(sql, values, connection))[0] || null;
  const mediaTransaction = (fn) => withTransaction(pool, async (connection) => { await lockResource(connection, 'media'); return fn(connection); });
  const transition = (id, expected, next, match = {}) => mediaTransaction(async (connection) => {
    const row = await first('SELECT * FROM media WHERE id = ? FOR UPDATE', [id], connection);
    if (!row || row.status !== expected || (match.email !== undefined && row.email !== match.email) || (match.store !== undefined && row.store !== match.store)) return false;
    await execute(connection, 'UPDATE media SET status = ? WHERE id = ?', [next, id]);
    return true;
  });
  return {
    ensureSchema() {
      if (!ready) ready = verifySchema(pool).catch((error) => { ready = undefined; throw error; });
      return ready;
    },
    appendLog(row) {
      safeInteger(row.ts, 'activity timestamp');
      return withTransaction(pool, async (connection) => {
        const result = await execute(connection, 'INSERT INTO log (ts, email, name, action, path, summary, sha) VALUES (?, ?, ?, ?, ?, ?, ?)', [row.ts, row.email, row.name, row.action, row.path, row.summary, row.sha]);
        return { id: safeInteger(result.insertId, 'activity ID') };
      });
    },
    getDraft: (path) => first('SELECT * FROM drafts WHERE path = ?', [path]),
    consumeAiQuota({ day, email, perUser, perDay }) {
      if (!Number.isSafeInteger(perUser) || perUser < 1 || perUser > 10000 || !Number.isSafeInteger(perDay) || perDay < 1 || perDay > 10000) return Promise.resolve(false);
      return withTransaction(pool, async (connection) => {
        await lockResource(connection, 'ai');
        const usage = await first('SELECT COALESCE(SUM(n), 0) AS n FROM ai_usage WHERE day = ?', [day], connection);
        const user = await first('SELECT n FROM ai_usage WHERE day = ? AND email = ?', [day, email], connection);
        if (usage.n >= perDay || (user?.n || 0) >= perUser) return false;
        if (user) await execute(connection, 'UPDATE ai_usage SET n = n + 1 WHERE day = ? AND email = ?', [day, email]);
        else await execute(connection, 'INSERT INTO ai_usage (day, email, n) VALUES (?, ?, 1)', [day, email]);
        return true;
      });
    },
    mediaUsage: () => rows("SELECT store, COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM media WHERE status != 'removing' OR store = 'r2' GROUP BY store"),
    expireMedia(before) {
      safeInteger(before, 'expiry timestamp');
      return mediaTransaction(async (connection) => {
        await execute(connection, "DELETE FROM media_chunks WHERE id IN (SELECT id FROM media WHERE status = 'uploading' AND created_at < ?)", [before]);
        await execute(connection, "DELETE FROM media WHERE status = 'uploading' AND created_at < ?", [before]);
      });
    },
    reserveMedia({ item, actor, now, limits: lim }) {
      safeInteger(item.size, 'media size'); safeInteger(now, 'media timestamp');
      if (item.size < 1 || ['ghFile', 'ghTotal', 'r2File', 'r2Total'].some((name) => !Number.isFinite(lim[name]) || lim[name] < 0 || lim[name] > Number.MAX_SAFE_INTEGER)) throw new RangeError('Invalid media capacity');
      return mediaTransaction(async (connection) => {
        const usage = await rows("SELECT store, COALESCE(SUM(size), 0) AS n FROM media WHERE status != 'removing' OR store = 'r2' GROUP BY store", [], connection);
        const github = usage.find((row) => row.store === 'github')?.n || 0, r2 = usage.find((row) => row.store === 'r2')?.n || 0;
        let store;
        if (item.kind !== 'video' && item.size <= lim.ghFile && item.size <= lim.ghTotal - github) store = 'github';
        else if (lim.r2 && item.kind !== 'photo' && item.size <= lim.r2File && item.size <= lim.r2Total - r2) store = 'r2';
        if (!store) return null;
        if (item.kind === 'photo' && await first("SELECT id FROM media WHERE `key` = ? AND status != 'removing' LIMIT 1", [item.githubKey], connection)) return null;
        await execute(connection, "INSERT INTO media (id, name, kind, mime, size, store, `key`, status, email, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)",
          [item.id, item.name, item.kind, item.mime, item.size, store, store === 'github' ? item.githubKey : item.r2Key, actor.email, actor.name, now]);
        return { id: item.id, store };
      });
    },
    hasActiveMediaKey: async (key) => !!(await first("SELECT id FROM media WHERE `key` = ? AND status != 'removing' LIMIT 1", [key])),
    getMedia: (id) => first('SELECT * FROM media WHERE id = ?', [id]),
    writeMediaChunk({ id, n, data, email }) {
      safeInteger(n, 'chunk number');
      return mediaTransaction(async (connection) => {
        const row = await first('SELECT status, email, store FROM media WHERE id = ? FOR UPDATE', [id], connection);
        if (!row || row.status !== 'uploading' || row.email !== email || row.store !== 'github') return false;
        const old = await first('SELECT data FROM media_chunks WHERE id = ? AND n = ?', [id, n], connection);
        if (old) return old.data === data;
        await execute(connection, 'INSERT INTO media_chunks (id, n, data) VALUES (?, ?, ?)', [id, n, data]);
        return true;
      });
    },
    dropUploading(id) {
      return mediaTransaction(async (connection) => {
        const removed = await execute(connection, "DELETE FROM media WHERE id = ? AND status = 'uploading'", [id]);
        if (removed.affectedRows) await execute(connection, 'DELETE FROM media_chunks WHERE id = ?', [id]);
      });
    },
    getUploadChunks: (id) => rows('SELECT n, LENGTH(data) AS len, data FROM media_chunks WHERE id = ? ORDER BY n', [id]),
    finishGithubUpload: (id, email) => transition(id, 'uploading', 'staged', { email }),
    claimR2Upload: (id, email) => transition(id, 'uploading', 'receiving', { email, store: 'r2' }),
    finishR2Upload: (id) => transition(id, 'receiving', 'published'),
    resetR2Upload: (id) => transition(id, 'receiving', 'uploading'),
    dropMedia(id) {
      return mediaTransaction(async (connection) => {
        await execute(connection, 'DELETE FROM media_chunks WHERE id = ?', [id]);
        await execute(connection, 'DELETE FROM media WHERE id = ?', [id]);
      });
    },
    listMedia: () => rows("SELECT * FROM media WHERE status IN ('staged', 'published', 'removing') AND kind != 'photo' ORDER BY created_at DESC"),
    claimMediaRemoval: (id, status) => transition(id, status, 'removing'),
    markGithubRemoval(id, actor, now) {
      safeInteger(now, 'media timestamp');
      return mediaTransaction((connection) => execute(connection, "UPDATE media SET status = 'removing', email = ?, by_name = ?, created_at = ? WHERE id = ?", [actor.email, actor.name, now, id]));
    },
    listDraftChildren: (dir) => rows('SELECT path, deleted, content FROM drafts WHERE path LIKE ?', [`${dir}/%`]),
    async clearDraftSnapshot(path, expected) {
      if (!expected) return !(await first('SELECT path FROM drafts WHERE path = ?', [path]));
      return (await execute(pool, `DELETE FROM drafts WHERE ${DRAFT_MATCH}`, draftValues(expected))).affectedRows === 1;
    },
    async writeDraftSnapshot(next, expected) {
      for (const key of ['deleted', 'created_at', 'updated_at']) safeInteger(next[key], `draft ${key}`);
      if (expected) return (await execute(pool, `UPDATE drafts SET content = ?, deleted = ?, updated_at = ?, email = ?, name = ? WHERE ${DRAFT_MATCH}`,
        [next.content, next.deleted, next.updated_at, next.email, next.name, ...draftValues(expected)])).affectedRows === 1;
      try {
        await execute(pool, 'INSERT INTO drafts (path, content, deleted, base_sha, created_at, updated_at, email, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', draftValues(next));
        return true;
      } catch (error) { if (error?.code === 'ER_DUP_ENTRY') return false; throw error; }
    },
    listDrafts: () => rows('SELECT * FROM drafts ORDER BY updated_at DESC'),
    getDrafts: (paths) => paths.length ? rows(`SELECT * FROM drafts WHERE path IN (${marks(paths.length)})`, paths) : Promise.resolve([]),
    listPendingMedia: (keys) => keys === undefined
      ? rows("SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') ORDER BY created_at DESC")
      : keys.length ? rows(`SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') AND \`key\` IN (${marks(keys.length)})`, keys) : Promise.resolve([]),
    getPublishChunks: (id) => rows('SELECT data FROM media_chunks WHERE id = ? ORDER BY n', [id]),
    cleanupPublishedDrafts(expected) {
      if (!expected.length) return Promise.resolve();
      return withTransaction(pool, async (connection) => {
        // A single snapshot per packet avoids accumulating many multi-megabyte
        // draft bodies; the complete cleanup remains one transaction.
        for (const row of [...expected].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) await execute(connection, `DELETE FROM drafts WHERE ${DRAFT_MATCH}`, draftValues(row));
      });
    },
    finishPublishedMedia(row) {
      return mediaTransaction(async (connection) => {
        await execute(connection, 'DELETE FROM media_chunks WHERE id = ?', [row.id]);
        if (row.status === 'staged') await execute(connection, "UPDATE media SET status = 'published' WHERE id = ?", [row.id]);
        else await execute(connection, 'DELETE FROM media WHERE id = ?', [row.id]);
      });
    },
    discardDrafts: (paths) => paths.length ? execute(pool, `DELETE FROM drafts WHERE path IN (${marks(paths.length)})`, paths) : Promise.resolve(),
    restorePublishedMedia: (id) => mediaTransaction((connection) => execute(connection, "UPDATE media SET status = 'published' WHERE id = ?", [id])),
    getStagedChunk: (id, n) => first("SELECT c.data FROM media_chunks c INNER JOIN media m ON m.id = c.id WHERE m.id = ? AND m.status = 'staged' AND c.n = ?", [id, n]),
    async listLog({ before, limit }) {
      safeInteger(before, 'activity cursor'); safeInteger(limit, 'activity limit');
      if (limit < 1 || limit > 200) throw new RangeError('Invalid activity limit');
      const result = await rows(`SELECT id, ts, email, name, action, path, summary, sha FROM log ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, before ? [before, limit] : [limit]);
      return result.map((row) => ({ ...row, id: safeInteger(row.id, 'activity ID') }));
    },
    listDraftPaths: async () => (await rows('SELECT path FROM drafts')).map((row) => row.path),
    listPendingMediaKeys: async () => (await rows("SELECT `key` FROM media WHERE store = 'github' AND status IN ('staged', 'removing')")).map((row) => row.key),
  };
}
