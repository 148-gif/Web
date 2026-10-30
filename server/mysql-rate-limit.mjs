// Fixed-window admissions use one transaction and one row lock per scope.
// Login subjects remain a bounded map in that row, never one row per address.
import { withTransaction, safeInteger } from './mysql-core.mjs';

const HASH = /^[0-9a-f]{64}$/;
const WRITE_SCOPE = /^write:[0-9a-f]{64}$/;

function admissionOf(admission) {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) throw new TypeError('Invalid rate-limit admission');
  const { scope, windowStart, limit, subject, subjectLimit } = admission;
  if (!Number.isSafeInteger(windowStart) || windowStart < 0 || windowStart % 60000 !== 0) throw new TypeError('Invalid rate-limit window');
  const login = scope === 'login';
  if (!login && (typeof scope !== 'string' || !WRITE_SCOPE.test(scope))) throw new TypeError('Invalid rate-limit scope');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > (login ? 1000 : 5000)) throw new TypeError('Invalid rate-limit allowance');
  if (login ? typeof subject !== 'string' || !HASH.test(subject) || !Number.isSafeInteger(subjectLimit) || subjectLimit < 1 || subjectLimit > 1000 : subject !== null || subjectLimit !== null) throw new TypeError('Invalid rate-limit subject');
  return { scope, windowStart, limit, subject, subjectLimit, login };
}

function stateOf(row, login) {
  const windowStart = safeInteger(row.window_start, 'rate-limit window');
  const n = safeInteger(row.n, 'rate-limit count');
  if (windowStart < 0 || windowStart % 60000 !== 0 || n < 0 || n > (login ? 1000 : 5000) || typeof row.clients !== 'string') throw new Error('Invalid rate-limit storage result');
  let clients;
  try { clients = JSON.parse(row.clients); }
  catch { throw new Error('Invalid rate-limit storage result'); }
  if (!clients || typeof clients !== 'object' || Array.isArray(clients)) throw new Error('Invalid rate-limit storage result');
  let sum = 0;
  const entries = Object.entries(clients);
  if (entries.length > (login ? 1000 : 0)) throw new Error('Invalid rate-limit storage result');
  for (const [subject, count] of entries) {
    if (!HASH.test(subject) || !Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('Invalid rate-limit storage result');
    sum += count;
  }
  if (login && sum !== n) throw new Error('Invalid rate-limit storage result');
  return { windowStart, n, clients };
}

export function createMysqlRateLimitStore(pool) {
  if (!pool || typeof pool.getConnection !== 'function') throw new TypeError('MySQL pool is required');
  return async (admission) => {
    const next = admissionOf(admission);
    return withTransaction(pool, async (connection) => {
      // A duplicate-key UPDATE acquires an exclusive lock immediately. IGNORE
      // would retain a shared lock and deadlock concurrent locking readers.
      await connection.execute("INSERT INTO request_limits (scope, window_start, n, clients) VALUES (?, ?, 0, '{}') ON DUPLICATE KEY UPDATE scope = scope", [next.scope, next.windowStart]);
      const [rows] = await connection.execute('SELECT window_start, n, clients FROM request_limits WHERE scope = ? FOR UPDATE', [next.scope]);
      if (rows.length !== 1) throw new Error('Invalid rate-limit storage result');
      const current = stateOf(rows[0], next.login);
      if (current.windowStart > next.windowStart) return false;
      const sameWindow = current.windowStart === next.windowStart;
      const n = sameWindow ? current.n : 0;
      const clients = sameWindow ? current.clients : {};
      const subjectCount = next.login ? (clients[next.subject] || 0) : 0;
      // Neither a denied client nor a full shared bucket mutates the counters.
      if (n >= next.limit || (next.login && subjectCount >= next.subjectLimit)) return false;
      if (next.login) clients[next.subject] = subjectCount + 1;
      const [updated] = await connection.execute('UPDATE request_limits SET window_start = ?, n = ?, clients = ? WHERE scope = ?', [next.windowStart, n + 1, JSON.stringify(clients), next.scope]);
      if (updated.affectedRows !== 1) throw new Error('Invalid rate-limit storage result');
      return true;
    });
  };
}
