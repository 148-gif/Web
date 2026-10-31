import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const run = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../passenger.cjs', import.meta.url));
const startupError = 'CMS startup failed; verify database connectivity, imported schema and hosting configuration\n';
const requireTwice = (path) => `require(${JSON.stringify(path)}); require(${JSON.stringify(path)});`;

async function fixture(t, moduleSource) {
  const root = await mkdtemp(join(tmpdir(), 'cms-passenger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['server', 'media', 'public']) await mkdir(join(root, dir), { mode: 0o700 });
  if (moduleSource !== undefined) {
    await copyFile(entrypoint, join(root, 'passenger.cjs'));
    await writeFile(join(root, 'server/start.mjs'), moduleSource);
  }
  return root;
}

test('CommonJS startup loads a top-level-await ES module and explicitly starts it exactly once', async (t) => {
  const root = await fixture(t, `
await Promise.resolve();
let starts = 0;
export async function start() {
  process.stdout.write(JSON.stringify({ starts: ++starts, directExecution: Boolean(process.argv[1]) }) + '\\n');
}
`);
  const { stdout, stderr } = await run(process.execPath, ['--input-type=commonjs', '-e', requireTwice(join(root, 'passenger.cjs'))], { cwd: tmpdir(), env: {}, timeout: 5000 });
  assert.deepEqual(stdout.trim().split('\n').map((line) => JSON.parse(line)), [{ starts: 1, directExecution: false }]);
  assert.equal(stderr, '');
});

test('Passenger startup failures exit promptly and redact underlying errors even while stdin remains open', async (t) => {
  const privateValue = 'private-fixture-driver-error';
  const root = await fixture(t, `export async function start() { throw new Error(${JSON.stringify(privateValue)}); }\n`);
  await assert.rejects(run(process.execPath, ['--input-type=commonjs', '-e', `process.stdin.resume(); ${requireTwice(join(root, 'passenger.cjs'))}`], { cwd: tmpdir(), env: {}, timeout: 5000 }), (error) => {
    assert.equal(error.code, 1); assert.equal(error.killed, false);
    assert.equal(error.stdout, ''); assert.equal(error.stderr, startupError);
    assert.ok(!error.stderr.includes(privateValue));
    return true;
  });
});

test('the actual Passenger entrypoint fails closed without configuration and exposes no supplied secret values', async () => {
  const secret = 'private-fixture-unused-session-value-at-least-32-bytes';
  await assert.rejects(run(process.execPath, ['--input-type=commonjs', '-e', `process.stdin.resume(); ${requireTwice(entrypoint)}`], {
    cwd: tmpdir(), env: { SESSION_SECRET: secret, MYSQL_PASSWORD: secret, GITHUB_TOKEN: secret }, timeout: 5000,
  }), (error) => {
    assert.equal(error.code, 1); assert.equal(error.killed, false);
    assert.equal(error.stdout, ''); assert.equal(error.stderr, startupError);
    assert.ok(!error.stderr.includes(secret));
    return true;
  });
});

test('require() of the actual Passenger entry starts once against isolated MySQL and serves the guarded API', { skip: !mysqlEnabled, timeout: 30000 }, async (t) => {
  const root = await fixture(t);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await withMysqlDatabase(async ({ config }) => {
    const values = {
      CMS_PUBLIC_ORIGIN: 'https://preview.example.test', ALLOWED_ORIGIN: 'https://preview.example.test',
      CMS_API_BASE_PATH: '/cms-api', REPO: 'owner/repo', BRANCH: 'main', OWNERS: 'a'.repeat(64),
      GOOGLE_CLIENT_ID: 'test-client', GITHUB_TOKEN: 'private-test-github-token',
      SESSION_SECRET: 'private-test-session-secret-at-least-32-bytes',
      MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_DATABASE: config.database,
      MYSQL_USER: config.user, MYSQL_PASSWORD: config.password,
      CMS_APP_ROOT: dirname(entrypoint), CMS_MEDIA_ROOT: join(root, 'media'), CMS_PUBLIC_ROOT: join(root, 'public'),
      PORT: String(port),
    };
    // No inherited environment/credentials. The Worker must not contact Google,
    // GitHub or another provider in these unauthenticated readiness requests.
    const script = `globalThis.fetch = async () => { throw new Error('External requests are forbidden in this test'); }; ${requireTwice(entrypoint)}`;
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', script], { cwd: root, env: values, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Passenger bootstrap did not become ready')), 10000);
      const finish = (fn, value) => { clearTimeout(timeout); fn(value); };
      child.once('error', () => finish(reject, new Error('Passenger bootstrap could not be spawned')));
      child.once('close', () => finish(reject, new Error('Passenger bootstrap exited before readiness')));
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('\n')) {
          try { finish(resolve, JSON.parse(stdout.split('\n')[0])); }
          catch { finish(reject, new Error('Passenger bootstrap emitted an invalid readiness marker')); }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    });
    try {
      assert.deepEqual(await ready, {
        service: 'heichal-cms', listening: true, publicationEnabled: false,
        readOnly: false, deploymentCandidate: false, slugAiAvailable: false, slugAiProvider: 'disabled', slugAiVerified: false, schemaVerified: true,
      });
      const local = `http://127.0.0.1:${port}`;
      for (const [path, method, status] of [['/cms-api/me', 'GET', 401], ['/cms-api/publish', 'POST', 503], ['/me', 'GET', 404]]) {
        const response = await fetch(local + path, { method, headers: { Origin: values.ALLOWED_ORIGIN }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, status);
        assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      const result = await closed;
      clearTimeout(timeout);
      assert.deepEqual(result, { code: 0, signal: null });
    }
    assert.equal(stdout.trim().split('\n').length, 1, 'Only one server may start when Passenger requires the entrypoint twice');
    assert.ok(stderr.length === 0, 'The real startup must not expose errors or private configuration');
  });
});
