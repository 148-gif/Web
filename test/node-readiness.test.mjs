import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, readdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReadiness } from '../server/readiness.mjs';
import { renderRuntimeEnvironment } from '../server/runtime-env.mjs';

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), 'cms-readiness-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'private')); await mkdir(join(base, 'public')); await mkdir(join(base, 'app'));
  const values = {
    CMS_PUBLIC_ORIGIN: 'https://api.example.test', ALLOWED_ORIGIN: 'https://site.example.test',
    REPO: 'owner/repo', BRANCH: 'main', OWNERS: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'client',
    GITHUB_TOKEN: 'do-not-print-github-secret', SESSION_SECRET: 'do-not-print-session-secret-at-least32-bytes',
    MYSQL_HOST: '127.0.0.1', MYSQL_DATABASE: 'private-db', MYSQL_USER: 'private-user', MYSQL_PASSWORD: 'do-not-print-mysql-password',
    CMS_MEDIA_ROOT: join(base, 'private'), CMS_PUBLIC_ROOT: join(base, 'public'), CMS_APP_ROOT: join(base, 'app'),
  };
  return { base, values };
}

test('preflight never reveals configured secrets or claims deployment readiness', async (t) => {
  const { values, base } = await setup(t), before = await readdir(base);
  let resolutions = 0;
  const report = await inspectReadiness({ values, resolveDriver: () => { resolutions++; return '/existing-driver'; } });
  assert.equal(resolutions, 1);
  assert.equal(report.checks.some((c) => c.status === 'blocked'), false);
  assert.equal(report.deploymentReady, false);
  assert.equal(report.databaseConnected, false);
  assert.equal(report.filesCreated, false);
  for (const name of ['GITHUB_TOKEN', 'SESSION_SECRET', 'MYSQL_PASSWORD', 'MYSQL_USER', 'MYSQL_DATABASE']) assert.ok(!JSON.stringify(report).includes(values[name]));
  assert.deepEqual(await readdir(base), before);
});

test('preflight reports missing dependencies and invalid configuration without provisioning', async (t) => {
  const { values } = await setup(t);
  const report = await inspectReadiness({ values: { ...values, MYSQL_PORT: '1.5', CMS_PUBLIC_ORIGIN: 'https://user:password@example.test/path' }, nodeVersion: '22.0.0', resolveDriver: () => { throw new Error('missing'); } });
  for (const name of ['node', 'mysql_driver', 'MYSQL_PORT', 'CMS_PUBLIC_ORIGIN']) assert.equal(report.checks.find((c) => c.name === name).status, 'blocked');
});

test('symlinks cannot disguise media storage inside the public directory', async (t) => {
  const { values, base } = await setup(t);
  const hidden = join(values.CMS_PUBLIC_ROOT, 'hidden'); await mkdir(hidden);
  const link = join(base, 'media-link'); await symlink(hidden, link);
  const report = await inspectReadiness({ values: { ...values, CMS_MEDIA_ROOT: link }, resolveDriver: () => 'present' });
  assert.equal(report.checks.find((c) => c.name === 'private_media_location').status, 'blocked');
});

test('ordinary files cannot pass the directory prerequisite', async (t) => {
  const { values, base } = await setup(t), file = join(base, 'file'); await writeFile(file, 'not a directory');
  const report = await inspectReadiness({ values: { ...values, CMS_MEDIA_ROOT: file }, resolveDriver: () => 'present' });
  assert.equal(report.checks.find((c) => c.name === 'CMS_MEDIA_ROOT').status, 'blocked');
});

test('explicit local-only configuration does not require a Google client but still requires an enabled provider', async (t) => {
  const { values } = await setup(t);
  const local = { ...values, ALLOWED_ORIGIN: values.CMS_PUBLIC_ORIGIN, CMS_LOCAL_AUTH_ENABLED: 'true', CMS_GOOGLE_AUTH_ENABLED: 'false' };
  delete local.GOOGLE_CLIENT_ID;
  const report = await inspectReadiness({ values: local, resolveDriver: () => 'present' });
  assert.equal(report.checks.some((c) => c.status === 'blocked'), false);
  const unavailable = await inspectReadiness({ values: { ...local, CMS_LOCAL_AUTH_ENABLED: 'false' }, resolveDriver: () => 'present' });
  assert.equal(unavailable.checks.find((c) => c.name === 'runtime_configuration').status, 'blocked');
});

test('managed Google configuration uses the database client and requires local authentication', async (t) => {
  const { values } = await setup(t);
  const managed = { ...values, ALLOWED_ORIGIN: values.CMS_PUBLIC_ORIGIN, CMS_LOCAL_AUTH_ENABLED: 'true', CMS_GOOGLE_SETUP_ENABLED: 'true' };
  delete managed.GOOGLE_CLIENT_ID;
  const report = await inspectReadiness({ values: managed, resolveDriver: () => 'present' });
  assert.equal(report.checks.some((c) => c.status === 'blocked'), false);
  const invalid = await inspectReadiness({ values: { ...managed, CMS_LOCAL_AUTH_ENABLED: 'false' }, resolveDriver: () => 'present' });
  assert.equal(invalid.checks.find((c) => c.name === 'runtime_configuration').status, 'blocked');
});

test('private-file preflight loads the same application configuration without claiming database or identity readiness', async (t) => {
  const { values, base } = await setup(t), privateRoot = join(base, 'configuration');
  await mkdir(privateRoot, { mode: 0o700 });
  const filePath = join(privateRoot, 'runtime-private-sentinel.env');
  const record = { ...values, ALLOWED_ORIGIN: values.CMS_PUBLIC_ORIGIN, CMS_LOCAL_AUTH_ENABLED: 'true', CMS_LOCAL_INVITATIONS_ENABLED: 'true', CMS_GOOGLE_AUTH_ENABLED: 'false' };
  delete record.GOOGLE_CLIENT_ID;
  await writeFile(filePath, renderRuntimeEnvironment(record), { mode: 0o600 });
  const inherited = Object.freeze({ CMS_ENV_FILE: filePath, PORT: '41234' }); let resolved = 0;
  const report = await inspectReadiness({ values: inherited, applicationRoot: values.CMS_APP_ROOT, resolveDriver: () => { resolved++; return 'present'; } });
  assert.equal(resolved, 1); assert.equal(report.checks.some((c) => c.status === 'blocked'), false);
  assert.equal(report.checks.find((c) => c.name === 'runtime_configuration').status, 'pass');
  assert.equal(report.deploymentReady, false); assert.equal(report.databaseConnected, false); assert.equal(report.filesCreated, false);
  assert.equal(report.schemaVerified, undefined); assert.equal(report.runtimeIdentity, undefined);
  for (const value of [filePath, values.GITHUB_TOKEN, values.MYSQL_PASSWORD, values.SESSION_SECRET]) assert.equal(JSON.stringify(report).includes(value), false);
  assert.deepEqual(inherited, { CMS_ENV_FILE: filePath, PORT: '41234' });
});

test('invalid private-file preflight fails closed without inherited fallback, path leakage or resolving a driver', async (t) => {
  const { values, base } = await setup(t), privateRoot = join(base, 'configuration');
  await mkdir(privateRoot, { mode: 0o700 });
  const filePath = join(privateRoot, 'runtime-private-sentinel.env');
  await writeFile(filePath, renderRuntimeEnvironment(values), { mode: 0o600 });
  let resolutions = 0;
  const check = async (inherited) => {
    const report = await inspectReadiness({ values: inherited, applicationRoot: values.CMS_APP_ROOT, resolveDriver: () => { resolutions++; return 'present'; } });
    assert.equal(report.databaseConnected, false); assert.equal(report.deploymentReady, false); assert.equal(report.filesCreated, false);
    assert.equal(report.checks.length, 1); assert.equal(report.checks[0].name, 'runtime_environment'); assert.equal(report.checks[0].status, 'blocked');
    for (const value of [filePath, 'private-collision-sentinel', values.GITHUB_TOKEN, values.MYSQL_PASSWORD]) assert.equal(JSON.stringify(report).includes(value), false);
  };
  await check({ CMS_ENV_FILE: filePath, MYSQL_PASSWORD: 'private-collision-sentinel' });
  await check({ CMS_ENV_FILE: filePath, CMS_LOCAL_INVITATIONS_ENABLED: 'true' });
  await chmod(filePath, 0o644);
  await check({ ...values, CMS_ENV_FILE: filePath });
  await chmod(filePath, 0o600); await writeFile(filePath, 'NODE_OPTIONS=private-collision-sentinel\n');
  await check({ ...values, CMS_ENV_FILE: filePath });
  assert.equal(resolutions, 0);
});
