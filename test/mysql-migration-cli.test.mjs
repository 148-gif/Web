import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMigration } from '../scripts/prepare-mysql-migration.mjs';

const snapshot = () => ({ format: 'heichal-cms-snapshot', version: 1, tables: { drafts: [], log: [], media: [], media_chunks: [], ai_usage: [] }, kv: {} });
async function fixture(t, value = snapshot()) {
  const dir = await mkdtemp(join(tmpdir(), 'cms-migrate-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.json'); await writeFile(input, JSON.stringify(value));
  return { dir, input, output: join(dir, 'plan') };
}

test('migration dry run never writes or prints private row values', async (t) => {
  const value = snapshot(); value.kv.people = '[{"email":"private@example.test","name":"שם פרטי","publisher":false}]';
  const { dir, input } = await fixture(t, value), original = await readFile(input);
  const report = await prepareMigration({ input });
  assert.equal(report.databaseConnected, false); assert.equal(report.databaseModified, false);
  assert.ok(!JSON.stringify(report).includes('private@example.test'));
  assert.deepEqual(await readdir(dir), ['source.json']); assert.deepEqual(await readFile(input), original);
});

test('review artifacts are private, checksummed, and never overwrite an existing export', async (t) => {
  const { input, output } = await fixture(t), report = await prepareMigration({ input, output });
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  for (const name of ['manifest.json', 'plan.json', 'schema.sql']) assert.equal((await stat(join(output, name))).mode & 0o777, 0o600);
  const plan = await readFile(join(output, 'plan.json')), schema = await readFile(join(output, 'schema.sql'));
  assert.equal(report.planSha256, createHash('sha256').update(plan).digest('hex'));
  assert.equal(report.schemaSha256, createHash('sha256').update(schema).digest('hex'));
  await assert.rejects(prepareMigration({ input, output }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(output, 'plan.json')), plan);
});

test('invalid, incomplete, and oversized input cannot produce an import artifact', async (t) => {
  const { input, output, dir } = await fixture(t);
  await assert.rejects(prepareMigration({ input, output, maxInputBytes: 4 }), /budget/);
  await writeFile(input, Buffer.from([0xc3, 0x28]));
  await assert.rejects(prepareMigration({ input, output }), /UTF-8 JSON/);
  await writeFile(input, '{}'); await assert.rejects(prepareMigration({ input, output }), /Invalid migration snapshot/);
  assert.deepEqual(await readdir(dir), ['source.json']);
});

test('a symlink cannot place private artifacts into the public source repository', async (t) => {
  const { input, dir } = await fixture(t), link = join(dir, 'public-link');
  await symlink(new URL('../site/', import.meta.url).pathname, link);
  await assert.rejects(prepareMigration({ input, output: join(link, 'must-not-create-migration-data') }), /outside the repository/);
});

test('an explicitly configured external public root is also excluded', async (t) => {
  const { input, dir } = await fixture(t), publicRoot = join(dir, 'public'); await mkdir(publicRoot);
  await assert.rejects(prepareMigration({ input, output: join(publicRoot, 'private-data'), publicRoot }), /configured public site/);
  assert.deepEqual(await readdir(publicRoot), []);
});
