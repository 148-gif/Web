// A stand-in for Cloudflare D1 over node:sqlite, with the parts of the D1 API the editor server uses.
import { DatabaseSync } from 'node:sqlite';

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { for (const s of list) await s.run(); return []; },
    raw: db,
  };
}
