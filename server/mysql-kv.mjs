// Exact-text KV compatibility for the editor's three membership/name records.
// Schema installation is a separate, explicit migration step.
import { withTransaction, lockResource } from './mysql-core.mjs';

const KEYS = new Set(['people', 'editors', 'owner-names']);
const MAX_VALUE_BYTES = 16777215; // MEDIUMTEXT, measured after UTF-8 encoding.

function keyOf(key) {
  if (typeof key !== 'string' || !KEYS.has(key)) throw new TypeError('Unsupported editor KV key');
  return key;
}

function valueOf(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new TypeError('Invalid editor KV text');
  try { JSON.parse(value); }
  catch { throw new TypeError('Invalid editor KV JSON'); }
  return value;
}

function readType(options) {
  if (options === undefined) return 'text';
  const type = typeof options === 'string' ? options : options?.type;
  if (type !== 'text' && type !== 'json') throw new TypeError('Unsupported editor KV read type');
  return type;
}

export function createMysqlKv(pool) {
  if (!pool || typeof pool.execute !== 'function' || typeof pool.getConnection !== 'function') throw new TypeError('MySQL pool is required');
  return {
    async get(key, options) {
      keyOf(key);
      const type = readType(options);
      const [rows] = await pool.execute('SELECT value FROM editors_kv WHERE `key` = ?', [key]);
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error('Invalid editor KV storage result');
      const value = valueOf(rows[0].value);
      return type === 'json' ? JSON.parse(value) : value;
    },

    async put(key, value) {
      keyOf(key); valueOf(value);
      // Deliberately keep text representation, including spacing and Unicode.
      await withTransaction(pool, async (connection) => {
        await lockResource(connection, `kv:${key}`);
        await connection.execute('INSERT INTO editors_kv (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?', [key, value, value]);
      });
    },

    async update(key, updater) {
      keyOf(key);
      if (typeof updater !== 'function') throw new TypeError('Editor KV updater is required');
      return withTransaction(pool, async (connection) => {
        // A seeded lock also covers a missing key without inserting placeholder
        // user data. INSERT IGNORE followed by a locking read would upgrade
        // duplicate-key shared locks and can deadlock concurrent first updates.
        await lockResource(connection, `kv:${key}`);
        const [rows] = await connection.execute('SELECT value FROM editors_kv WHERE `key` = ? FOR UPDATE', [key]);
        if (rows.length > 1) throw new Error('Invalid editor KV storage result');
        const previous = rows.length === 0 ? null : valueOf(rows[0].value);
        const value = valueOf(await updater(previous));
        if (rows.length === 0) await connection.execute('INSERT INTO editors_kv (`key`, value) VALUES (?, ?)', [key, value]);
        else await connection.execute('UPDATE editors_kv SET value = ? WHERE `key` = ?', [value, key]);
        return value;
      });
    },
  };
}
