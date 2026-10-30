// Shared MySQL primitives. SQL and row data stay out of diagnostic messages.
// Callers own pool configuration and explicit schema creation; these helpers
// never connect on import, retry callbacks, or modify an application's schema.
export function safeInteger(value, label = 'database integer') {
  const number = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0)) throw new RangeError(`Invalid ${label}`);
  return number;
}

const NUMBERS = ['ts', 'deleted', 'created_at', 'updated_at', 'size', 'n', 'c', 'len', 'window_start'];
export function normalizeRow(row, columns = NUMBERS) {
  if (row === null || row === undefined) return null;
  const result = { ...row };
  for (const column of columns) if (Object.hasOwn(result, column) && result[column] !== null) result[column] = safeInteger(result[column], `database ${column}`);
  return result;
}

export async function queryRows(connection, sql, values = []) {
  const [rows] = await connection.execute(sql, values);
  if (!Array.isArray(rows)) throw new Error('Expected a database row result');
  return rows;
}

export async function execute(connection, sql, values = []) {
  const [result] = await connection.execute(sql, values);
  if (!result || Array.isArray(result)) throw new Error('Expected a database mutation result');
  return result;
}

export async function withTransaction(pool, fn) {
  const connection = await pool.getConnection();
  let begun = false, destroyed = false;
  try {
    // Aggregate reads after acquiring a shared resource lock must see preceding
    // committed reservations, not an older repeatable-read snapshot.
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction(); begun = true;
    const result = await fn(connection);
    await connection.commit(); begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { await connection.rollback(); }
      catch { destroyed = true; connection.destroy(); }
    }
    throw error;
  } finally {
    if (!destroyed) connection.release();
  }
}

export async function lockResource(connection, name) {
  if (!['media', 'ai', 'kv:people', 'kv:editors', 'kv:owner-names'].includes(name)) throw new TypeError('Unknown database lock');
  const rows = await queryRows(connection, 'SELECT name FROM cms_locks WHERE name = ? FOR UPDATE', [name]);
  if (rows.length !== 1) throw new Error('Required database lock is missing');
}
