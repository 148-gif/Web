import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { RuntimeEnvError, RUNTIME_ENV_KEYS, parseRuntimeEnvironment, renderRuntimeEnvironment,
  readRuntimeEnvironmentFile, loadRuntimeEnvironment } from '../server/runtime-env.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { runtimeIdentityDocument, RUNTIME_IDENTITY_FILE, RuntimeIdentityError } from '../server/runtime-identity.mjs';

const SECRET = 'runtime-env-private-sentinel';
const denied = (error) => {
  assert.ok(error instanceof RuntimeEnvError);
  assert.equal(error.message, 'Invalid private runtime environment configuration');
  assert.equal(error.cause, undefined);
  assert.equal(String(error.stack).includes(SECRET), false);
  return true;
};

async function fixture(t) {
  const base = await fs.mkdtemp(join(tmpdir(), 'runtime-env-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const app = join(base, 'app'), publicRoot = join(base, 'public'), privateRoot = join(base, 'private'), media = join(base, 'media');
  for (const path of [app, publicRoot, privateRoot, media]) await fs.mkdir(path, { mode: 0o700 });
  const filePath = join(privateRoot, 'runtime.env');
  const values = { CMS_APP_ROOT: app, CMS_PUBLIC_ROOT: publicRoot, MYSQL_PASSWORD: SECRET };
  const save = async (record = values) => { await fs.writeFile(filePath, renderRuntimeEnvironment(record), { mode: 0o600 }); return record; };
  await save();
  return { base, app, publicRoot, privateRoot, media, filePath, values, save,
    read: () => readRuntimeEnvironmentFile({ filePath, applicationRoot: app }) };
}

test('private runtime syntax preserves quoted passwords and literal shell characters without evaluation', () => {
  const values = { MYSQL_PASSWORD: ' spaces # = \\ $()`text` "quoted" ', SESSION_SECRET: 'סוד ארוך לבדיקה בלבד', CMS_READ_ONLY: 'true', CMS_DEPLOYMENT_CANDIDATE: 'true' };
  const text = renderRuntimeEnvironment(values);
  assert.deepEqual({ ...parseRuntimeEnvironment(text) }, values);
  assert.equal(renderRuntimeEnvironment({ SESSION_SECRET: values.SESSION_SECRET, CMS_READ_ONLY: 'true', MYSQL_PASSWORD: values.MYSQL_PASSWORD, CMS_DEPLOYMENT_CANDIDATE: 'true' }), text);
  assert.equal(parseRuntimeEnvironment('# private file\r\nMYSQL_PASSWORD=a # b=c\r\n').MYSQL_PASSWORD, 'a # b=c');
  assert.equal(parseRuntimeEnvironment('MYSQL_PASSWORD=$(must-stay-literal)\n').MYSQL_PASSWORD, '$(must-stay-literal)');
  assert.equal(Object.getPrototypeOf(parseRuntimeEnvironment(text)), null);
});

test('runtime allowlist rejects system injection, redirects, unknown app flags and duplicate keys', () => {
  for (const key of ['PORT', 'NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'HOME', 'SHELL', 'NODE_PATH', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NPM_CONFIG_IGNORE_SCRIPTS', 'PASSENGER_APP_ENV', 'CMS_ENV_FILE', 'CMS_UNREVIEWED_AUTH_FLAG', '__proto__']) {
    assert.equal(RUNTIME_ENV_KEYS.includes(key), false);
    assert.throws(() => parseRuntimeEnvironment(`${key}=${SECRET}\n`), denied);
    assert.throws(() => renderRuntimeEnvironment({ [key]: SECRET }), denied);
  }
  assert.throws(() => parseRuntimeEnvironment(`MYSQL_PASSWORD="${SECRET}"\nMYSQL_PASSWORD="same"\n`), denied);
});

test('local invitation opt-in is accepted explicitly without allowing inherited auth drift', async (t) => {
  const f = await fixture(t);
  assert.equal(RUNTIME_ENV_KEYS.includes('CMS_LOCAL_INVITATIONS_ENABLED'), true);
  await f.save({ ...f.values, CMS_LOCAL_AUTH_ENABLED: 'true', CMS_LOCAL_INVITATIONS_ENABLED: 'true' });
  const loaded = await loadRuntimeEnvironment({ inherited: { CMS_ENV_FILE: f.filePath, PORT: '41234' }, applicationRoot: f.app });
  assert.equal(loaded.CMS_LOCAL_AUTH_ENABLED, 'true'); assert.equal(loaded.CMS_LOCAL_INVITATIONS_ENABLED, 'true');
  assert.equal(loaded.PORT, '41234');
  await assert.rejects(loadRuntimeEnvironment({ inherited: { CMS_ENV_FILE: f.filePath, CMS_LOCAL_INVITATIONS_ENABLED: 'false' }, applicationRoot: f.app }), denied);
  await f.save();
  await assert.rejects(loadRuntimeEnvironment({ inherited: { CMS_ENV_FILE: f.filePath, CMS_LOCAL_INVITATIONS_ENABLED: 'true' }, applicationRoot: f.app }), denied);
});

test('runtime file grammar rejects malformed, multiline, control, oversized and ambiguous inputs', () => {
  const inputs = [
    'export MYSQL_PASSWORD=value', ' MYSQL_PASSWORD=value', 'MYSQL_PASSWORD =value',
    "MYSQL_PASSWORD='single quoted'", 'MYSQL_PASSWORD=raw"quote', 'MYSQL_PASSWORD="value" # comment',
    'MYSQL_PASSWORD="first\nsecond"', 'MYSQL_PASSWORD="escaped\\nnewline"', 'MYSQL_PASSWORD=value\0',
    'MYSQL_PASSWORD="\\u0000"', 'MYSQL_PASSWORD="\\uD800"', '\ufeffMYSQL_PASSWORD=value',
    'MYSQL_PASSWORD=one\rtwo', 'MYSQL_PASSWORD=\tvalue', 'MYSQL_PASSWORD="\\u2028"',
    'MYSQL_PASSWORD=' + 'x'.repeat(8193), '#'.repeat(65537),
  ];
  for (const input of inputs) assert.throws(() => parseRuntimeEnvironment(input), denied);
  for (const input of [null, [], { MYSQL_PASSWORD: undefined }, { MYSQL_PASSWORD: 123 }, { MYSQL_PASSWORD: 'a\nb' }]) assert.throws(() => renderRuntimeEnvironment(input), denied);
});

test('env-only startup remains unchanged and private file mode preserves Passenger and process environment', async (t) => {
  const f = await fixture(t), before = JSON.stringify({ ...process.env });
  const plain = { PORT: '41234', CMS_READ_ONLY: 'true' };
  assert.equal(await loadRuntimeEnvironment({ inherited: plain, applicationRoot: f.app }), plain);
  const inherited = Object.freeze({ CMS_ENV_FILE: f.filePath, PORT: '41234', PASSENGER_APP_ENV: 'production', PATH: '/verified/host/path', MYSQL_PASSWORD: SECRET });
  const loaded = await loadRuntimeEnvironment({ inherited, applicationRoot: f.app });
  assert.equal(loaded.PORT, inherited.PORT);
  assert.equal(loaded.PASSENGER_APP_ENV, inherited.PASSENGER_APP_ENV);
  assert.equal(loaded.PATH, inherited.PATH);
  assert.equal(loaded.MYSQL_PASSWORD, SECRET);
  assert.equal(loaded.CMS_APP_ROOT, f.app);
  assert.notEqual(loaded, inherited);
  assert.ok(JSON.stringify({ ...process.env }) === before, 'Process environment must remain unchanged');
});

test('file mode rejects conflicting or omitted inherited application settings without partial mutation', async (t) => {
  const f = await fixture(t);
  for (const extra of [{ MYSQL_PASSWORD: 'another-private-value' }, { CMS_GOOGLE_AUTH_ENABLED: 'true' }, { CMS_LOCAL_AUTH_ENABLED: 'true' }]) {
    const inherited = Object.freeze({ CMS_ENV_FILE: f.filePath, PORT: '41234', ...extra });
    const before = { ...inherited };
    await assert.rejects(loadRuntimeEnvironment({ inherited, applicationRoot: f.app }), denied);
    assert.deepEqual(inherited, before);
  }
});

test('private runtime file requires exact file and parent permissions', async (t) => {
  const f = await fixture(t);
  for (const mode of [0o644, 0o400, 0o700, 0o660]) {
    await fs.chmod(f.filePath, mode); await assert.rejects(f.read(), denied);
  }
  await fs.chmod(f.filePath, 0o600);
  for (const mode of [0o755, 0o750, 0o770]) {
    await fs.chmod(f.privateRoot, mode); await assert.rejects(f.read(), denied);
  }
  await fs.chmod(f.privateRoot, 0o700);
  assert.equal((await f.read()).MYSQL_PASSWORD, SECRET);
});

test('private runtime file rejects a different owner before opening it', async (t) => {
  const f = await fixture(t), original = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args) => {
    const info = await original(...args);
    return args[0] === f.filePath ? Object.assign(Object.create(info), { uid: info.uid + 1n }) : info;
  });
  const open = t.mock.method(fs, 'open');
  await assert.rejects(f.read(), denied);
  assert.equal(open.mock.callCount(), 0);
});

test('private runtime file rejects final and ancestor symlinks and hardlinks', async (t) => {
  const f = await fixture(t), alias = join(f.base, 'alias.env'), dirAlias = join(f.base, 'private-link');
  await fs.symlink(f.filePath, alias); await fs.symlink(f.privateRoot, dirAlias);
  for (const filePath of [alias, join(dirAlias, 'runtime.env')]) await assert.rejects(readRuntimeEnvironmentFile({ filePath, applicationRoot: f.app }), denied);
  await fs.link(f.filePath, join(f.base, 'hardlink.env'));
  await assert.rejects(f.read(), denied);
});

test('runtime configuration must belong to the exact app and remain outside both public and app trees', async (t) => {
  const f = await fixture(t);
  for (const record of [{ ...f.values, CMS_APP_ROOT: f.base }, { ...f.values, CMS_PUBLIC_ROOT: '/' }, { ...f.values, CMS_PUBLIC_ROOT: f.base }, { ...f.values, CMS_PUBLIC_ROOT: f.app }, { ...f.values, CMS_PUBLIC_ROOT: join(f.app, 'nested') }]) {
    await f.save(record); await assert.rejects(f.read(), denied);
  }
  await f.save();
  await assert.rejects(readRuntimeEnvironmentFile({ filePath: f.filePath, applicationRoot: '/' }), denied);
  for (const filePath of [join(f.app, 'runtime.env'), join(f.publicRoot, 'runtime.env')]) {
    await fs.writeFile(filePath, renderRuntimeEnvironment(f.values), { mode: 0o600 });
    await assert.rejects(readRuntimeEnvironmentFile({ filePath, applicationRoot: f.app }), denied);
  }
  const appLink = join(f.base, 'app-link'); await fs.symlink(f.app, appLink);
  await assert.rejects(readRuntimeEnvironmentFile({ filePath: f.filePath, applicationRoot: appLink }), denied);
  const publicLink = join(f.base, 'public-link'); await fs.symlink(f.publicRoot, publicLink);
  await f.save({ ...f.values, CMS_PUBLIC_ROOT: publicLink }); await assert.rejects(f.read(), denied);
});

test('runtime file rejects missing, noncanonical, nonregular, oversized and invalid UTF-8 inputs', async (t) => {
  const f = await fixture(t);
  for (const filePath of ['runtime.env', f.privateRoot + '/./runtime.env', f.privateRoot, join(f.base, SECRET)]) {
    await assert.rejects(readRuntimeEnvironmentFile({ filePath, applicationRoot: f.app }), denied);
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(65537, 35), Buffer.from([0xff, 0xfe, 0xff])]) {
    await fs.writeFile(f.filePath, bytes); await assert.rejects(f.read(), denied);
  }
});

test('private runtime read rejects both in-place mutation and atomic path replacement during reading', async (t) => {
  for (const replacement of [false, true]) {
    await t.test(replacement ? 'replacement' : 'in-place', async (s) => {
      const f = await fixture(s), original = fs.open;
      let mutated = false;
      s.mock.method(fs, 'open', async (...args) => {
        const handle = await original(...args);
        if (args[0] !== f.filePath) return handle;
        return {
          stat: (...a) => handle.stat(...a), close: () => handle.close(),
          async read(...a) {
            const result = await handle.read(...a);
            if (!mutated) {
              mutated = true;
              const bytes = renderRuntimeEnvironment({ ...f.values, MYSQL_PASSWORD: SECRET + '-changed' });
              if (replacement) {
                const next = join(f.privateRoot, 'replacement.env');
                await fs.writeFile(next, bytes, { mode: 0o600 }); await fs.rename(next, f.filePath);
              } else await fs.writeFile(f.filePath, bytes);
            }
            return result;
          },
        };
      });
      await assert.rejects(f.read(), denied);
      assert.equal(mutated, true);
    });
  }
});

test('createRuntime loads private configuration before connecting and keeps the inherited listener port', async (t) => {
  const f = await fixture(t), state = { constructed: 0, ended: 0, verified: 0 };
  const commit = 'b'.repeat(40), digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const source = { 'server/start.mjs': 'export {};\n', 'server/runtime.mjs': 'export {};\n',
    'passenger.cjs': 'require("node:process");\n', 'package.json': '{"type":"module"}\n', 'package-lock.json': '{"lockfileVersion":3}\n' };
  const files = [];
  for (const [path, content] of Object.entries(source)) {
    await fs.mkdir(dirname(join(f.app, path)), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(f.app, path), content, { mode: 0o600 });
    files.push({ path, bytes: Buffer.byteLength(content), sha256: digest(content) });
  }
  const values = { ...f.values, CMS_MEDIA_ROOT: f.media, CMS_PUBLIC_ORIGIN: 'https://hichal.yoterberama.com', ALLOWED_ORIGIN: 'https://hichal.yoterberama.com',
    REPO: 'owner/repo', BRANCH: 'main', OWNERS: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'fixture-client',
    GITHUB_TOKEN: SECRET, SESSION_SECRET: SECRET.repeat(2), MYSQL_HOST: '127.0.0.1', MYSQL_DATABASE: 'cms_test', MYSQL_USER: 'test-user',
    CMS_READ_ONLY: 'true', CMS_PUBLISH_ENABLED: 'false', CMS_STAGING: 'true', CMS_DEPLOYMENT_CANDIDATE: 'true', CMS_API_BASE_PATH: '/cms-api-check-bbbbbbbb' };
  await f.save(values);
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const inherited = Object.freeze({ CMS_ENV_FILE: f.filePath, PORT: String(port) });
  const dependencies = {
    createPool(config) {
      state.constructed++; assert.equal(config.password, SECRET);
      return { async getConnection() { throw new Error('Unexpected database query'); }, async end() { state.ended++; } };
    },
    createDataStore() { return { async ensureSchema() { state.verified++; } }; },
    createKv() { return {}; }, createRateLimitStore() { return async () => assert.fail('Read-only runtime probes must not consume counters'); },
  };
  await assert.rejects(createRuntime({ values: inherited, applicationRoot: f.app, dependencies }), RuntimeIdentityError);
  assert.deepEqual(state, { constructed: 1, ended: 1, verified: 1 }, 'Missing identity fails closed after schema readiness and closes the pool');
  const identityBytes = JSON.stringify(runtimeIdentityDocument({ commit, files })) + '\n';
  await fs.writeFile(join(f.app, RUNTIME_IDENTITY_FILE), identityBytes, { mode: 0o600 });
  const manifestEntries = [...files.map((file) => ({ ...file, path: 'app/' + file.path })),
    { path: 'app/' + RUNTIME_IDENTITY_FILE, bytes: Buffer.byteLength(identityBytes), sha256: digest(identityBytes) }]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const runtimeManifestSha256 = digest(JSON.stringify(manifestEntries));
  const runtime = await createRuntime({ values: inherited, applicationRoot: f.app, dependencies });
  try {
    assert.equal(state.constructed, 2); assert.equal(state.verified, 2);
    assert.equal(runtime.status.readOnly, true); assert.equal(runtime.status.publicationEnabled, false);
    await runtime.listen(); assert.equal(runtime.server.address().port, port);
    const response = await fetch(`http://127.0.0.1:${port}${values.CMS_API_BASE_PATH}/version`, { headers: { Origin: values.ALLOWED_ORIGIN } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.deepEqual(await response.json(), { version: 1, commit, runtimeManifestSha256, verified: true, schemaVerified: true, deploymentCandidate: true });
    // Foundation HTTP verification deliberately has no operator/Selector
    // dependency: this release prepares identity, never automates promotion.
    const anonymous = await fetch(`http://127.0.0.1:${port}${values.CMS_API_BASE_PATH}/me`, { headers: { Origin: values.ALLOWED_ORIGIN } });
    assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('cache-control'), 'no-store'); await anonymous.arrayBuffer();
    const foreign = await fetch(`http://127.0.0.1:${port}${values.CMS_API_BASE_PATH}/version`, { headers: { Origin: 'https://deployment-probe.invalid' } });
    assert.equal(foreign.status, 403); assert.equal(foreign.headers.has('access-control-allow-origin'), false); await foreign.arrayBuffer();
  } finally { await runtime.close(); }
  assert.equal(state.ended, 2);
  await fs.chmod(f.filePath, 0o644);
  await assert.rejects(createRuntime({ values: inherited, applicationRoot: f.app, dependencies }), denied);
  assert.equal(state.constructed, 2, 'Unsafe environment is rejected before creating a database pool');
});
