// The default mode reads and validates one private snapshot only. Production
// apply is explicit and is never part of server startup or a deploy workflow.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { importMysqlSnapshot, MysqlImportError } from '../server/mysql-import.mjs';
import { MigrationValidationError } from '../server/migration.mjs';

const MAX_INPUT = 64 * 1024 * 1024;

export async function readImportSnapshot(input, maxInputBytes = MAX_INPUT) {
  if (typeof input !== 'string' || !input || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('An explicit snapshot file and valid input budget are required');
  // One descriptor for metadata and bytes. O_NOFOLLOW prevents a replaced input
  // path from resolving into another file; O_NONBLOCK avoids FIFO/device hangs.
  const file = await open(resolve(input), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxInputBytes) throw new Error('Snapshot is not a regular file within the input budget');
    const chunks = []; let size = 0;
    const stream = file.createReadStream({ autoClose: false, start: 0, end: maxInputBytes });
    for await (const chunk of stream) { size += chunk.length; if (size > maxInputBytes) throw new Error('Snapshot exceeds the input budget'); chunks.push(chunk); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error('Snapshot must contain valid UTF-8 JSON'); }
  } finally { await file.close(); }
}

function parseArgs(args) {
  const options = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--apply') { if (options.apply) throw new Error('Duplicate option'); options.apply = true; }
    else if (flag === '--initialize-schema' || flag === '--isolated-target') {
      const name = flag === '--initialize-schema' ? 'initializeSchema' : 'targetIsIsolated';
      if (options[name]) throw new Error('Duplicate option'); options[name] = true;
    } else {
      const names = { '--input': 'input', '--database': 'targetDatabase', '--source-sha256': 'expectedSourceSha256', '--schema-sha256': 'expectedSchemaSha256' };
      const name = names[flag];
      if (!name || Object.hasOwn(options, name) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Unknown, duplicate, or incomplete import option');
      options[name] = args[++i];
    }
  }
  if (!options.input) throw new Error('Usage: --input private-snapshot.json [--apply --initialize-schema --isolated-target --database new_database --source-sha256 reviewed_hash --schema-sha256 reviewed_hash]');
  if (!options.apply && Object.keys(options).some((key) => !['input', 'apply'].includes(key))) throw new Error('Apply-only options require --apply');
  return options;
}

export function mysqlImportConnectionOptions(values, targetDatabase) {
  for (const name of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD']) if (typeof values[name] !== 'string' || !values[name]) throw new Error('Required database connection configuration is missing');
  if (typeof targetDatabase !== 'string' || !/^[A-Za-z0-9_$]{1,64}$/.test(targetDatabase)) throw new Error('An explicit valid target database is required');
  const port = values.MYSQL_PORT === undefined ? 3306 : Number(values.MYSQL_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid database port');
  const socketPath = values.MYSQL_SOCKET_PATH;
  if (socketPath !== undefined && (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0'))) throw new Error('MYSQL_SOCKET_PATH must be an absolute socket path');
  const host = values.MYSQL_HOST, local = Boolean(socketPath) || ['localhost', '127.0.0.1', '::1'].includes(host);
  // mysql2 omits the TLS servername for numeric IPs. Until IP-SAN verification
  // is explicitly exercised, remote imports require a DNS hostname instead.
  if (!local && (isIP(host) || host.length > 253 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(host) || host.split('.').some((label) => label.length > 63))) throw new Error('Remote MySQL requires a valid DNS hostname for verified TLS');
  return { host, port, user: values.MYSQL_USER, password: values.MYSQL_PASSWORD,
    database: targetDatabase, charset: 'utf8mb4_bin', supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectionLimit: 1, connectTimeout: 10000, enableKeepAlive: true,
    ...(socketPath ? { socketPath } : {}),
    // mysql2's identity check is independently opt-in: checking only the CA
    // chain would accept a valid certificate issued for a different hostname.
    ...(!local ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
  };
}

export async function runMysqlImport(args, { values = process.env, poolFactory } = {}) {
  const options = parseArgs(args), snapshot = await readImportSnapshot(options.input);
  // This function is not invoked until all apply flags and reviewed hashes have
  // passed. No credentials are accessed during dry-run or invalid apply input.
  const createPool = poolFactory || (async () => {
    const connectionOptions = mysqlImportConnectionOptions(values, options.targetDatabase);
    const { createPool: connect } = await import('mysql2/promise');
    return connect(connectionOptions);
  });
  return importMysqlSnapshot({ ...options, snapshot, createPool });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runMysqlImport(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.readyToImport ? 0 : 2;
  } catch (error) {
    const report = error instanceof MysqlImportError
      ? { error: error.code, message: error.message, state: error.state }
      : error instanceof MigrationValidationError
        ? { error: 'invalid-snapshot', issues: error.errors }
        : { error: 'invalid-import-input', message: 'Import input or options are invalid; no successful import is claimed' };
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = 1;
  }
}
