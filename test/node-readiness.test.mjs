import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReadiness } from '../server/readiness.mjs';

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), 'cms-readiness-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'private')); await mkdir(join(base, 'public'));
  const values = {
    CMS_PUBLIC_ORIGIN: 'https://api.example.test', ALLOWED_ORIGIN: 'https://site.example.test',
    REPO: 'owner/repo', BRANCH: 'main', GOOGLE_CLIENT_ID: 'client',
    GITHUB_TOKEN: 'do-not-print-github-secret', SESSION_SECRET: 'do-not-print-session-secret',
    MYSQL_HOST: '127.0.0.1', MYSQL_DATABASE: 'private-db', MYSQL_USER: 'private-user', MYSQL_PASSWORD: 'do-not-print-mysql-password',
    CMS_MEDIA_ROOT: join(base, 'private'), CMS_PUBLIC_ROOT: join(base, 'public'),
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
