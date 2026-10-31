// mysql2's connection event does not await async listeners, and its pool-level
// query/execute methods bypass an overridden PromisePool.getConnection(). Keep
// all three entry points behind the same awaited checkout initialization.
const INITIALIZE_SESSION = "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION')";

export class MysqlSessionInitializationError extends Error {
  constructor() {
    super('MySQL session initialization failed');
    this.name = 'MysqlSessionInitializationError';
  }
}

export function createInitializedMysqlPool(pool) {
  if (!pool || typeof pool.getConnection !== 'function' || typeof pool.end !== 'function') throw new TypeError('A MySQL promise pool is required');
  async function getConnection() {
    const connection = await pool.getConnection();
    try {
      // Reapply on every checkout, including reused or replacement connections.
      // Preserve existing modes rather than weakening the server's defaults.
      await connection.query(INITIALIZE_SESSION);
      return connection;
    } catch {
      // Never return a connection whose initialization failed to the free pool.
      // Driver exceptions can contain connection details; do not retain them.
      try { connection.destroy(); } catch { /* Keep it checked out if disposal fails. */ }
      throw new MysqlSessionInitializationError();
    }
  }
  async function run(method, args) {
    const connection = await getConnection();
    let discard = false;
    try { return await connection[method](...args); }
    catch (error) {
      // Preserve mysql2 pool.query/execute eviction of connections to a server
      // that became read-only. Do not retry a potentially mutating statement.
      if ([1290, 1792, 1836].includes(error?.errno)) {
        discard = true;
        try { connection.destroy(); } catch { /* Never release a discarded lease. */ }
      }
      throw error;
    } finally { if (!discard) connection.release(); }
  }
  return {
    getConnection,
    query: (...args) => run('query', args),
    execute: (...args) => run('execute', args),
    end: () => pool.end(),
  };
}
