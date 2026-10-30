// Explicitly opted-in integration tests against an isolated local MySQL service.
// Never point this helper at hosting/production: only loopback is accepted and
// each callback owns a newly generated database, which is dropped in finally.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const mysqlEnabled = Boolean(process.env.MYSQL_TEST_CONFIG);

export async function withMysqlDatabase(fn, { schema = true } = {}) {
  if (!mysqlEnabled) throw new Error('MYSQL_TEST_CONFIG is required for real MySQL integration tests');
  const input = JSON.parse(await readFile(process.env.MYSQL_TEST_CONFIG, 'utf8'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(input.host) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('MySQL test service must use an explicit loopback host and port');
  }
  if (typeof input.user !== 'string' || !input.user || typeof input.password !== 'string' || !input.password) {
    throw new Error('MySQL test credentials are incomplete');
  }
  const mysql = await import('mysql2/promise');
  const base = {
    host: input.host, port: input.port, user: input.user, password: input.password,
    // mysql2's handshake charset is one byte; utf8mb4_0900_bin has ID309.
    // Table columns use the intended NO_PAD collation from the schema itself.
    connectTimeout: 10000, charset: 'utf8mb4_bin',
    supportBigNumbers: true, bigNumberStrings: true,
  };
  // The administrative connection accepts our checked-in schema only. Runtime
  // pools keep multiple statements disabled, just as the application does.
  const admin = await mysql.createConnection({ ...base, multipleStatements: true });
  const database = `cms_test_${randomBytes(12).toString('hex')}`;
  let pool, created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    created = true;
    await admin.query(`USE \`${database}\``);
    if (schema) await admin.query(await readFile(new URL('../../server/mysql-schema.sql', import.meta.url), 'utf8'));
    const config = { ...base, database, multipleStatements: false, connectionLimit: 12 };
    pool = mysql.createPool(config);
    return await fn({ pool, config, database });
  } finally {
    try { if (pool) await pool.end(); }
    finally {
      try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
      finally { await admin.end(); }
    }
  }
}
