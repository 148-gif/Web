import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { packageCpanel } from '../scripts/package-cpanel.mjs';
import { readRuntimeIdentity, RUNTIME_IDENTITY_FILE } from '../server/runtime-identity.mjs';
import { runtimeManifestSha256 } from '../server/cpanel-publication.mjs';

const run = promisify(execFile);
async function fixture(t, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'cms-package-')), sourceRoot = join(base, 'repo');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(sourceRoot);
  const files = {
    'passenger.cjs': 'import("./server/start.mjs").then(({start}) => start());\n',
    'server/start.mjs': 'export {};\n', 'server/runtime.mjs': 'export {};\n', 'server/mysql-store.mjs': 'export {};\n',
    'server/mysql-kv.mjs': 'export {};\n', 'server/mysql-rate-limit.mjs': 'export {};\n',
    'cms-worker/worker.mjs': 'export {};\n', 'site/admin/image-rules.mjs': 'export {};\n',
    'scripts/setup-google-auth.mjs': 'export {};\n', 'scripts/setup-local-invitations.mjs': 'export {};\n',
    'package.json': '{"type":"module","dependencies":{"mysql2":"3.24.6"}}\n', 'package-lock.json': '{"lockfileVersion":3}\n',
    '.env': 'SECRET_EXCLUDED_FROM_RELEASE=private-fixture-value\n',
    'data/private-fixture.json': '{"notRuntimeData":true}\n',
    'scripts/build.mjs': `import {mkdirSync,writeFileSync} from 'node:fs';
mkdirSync('dist/admin',{recursive:true});
writeFileSync('dist/index.html','<!doctype html><html><head><meta name="robots" content="index,follow"></head><body>שלום</body></html>');
writeFileSync('dist/admin/index.html', '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; connect-src \\'self\\'; img-src \\'self\\'; media-src \\'self\\'"></head></html>');
writeFileSync('dist/admin/config.json', JSON.stringify({repo:'owner/repo',branch:'main',worker:'https://old.example.test',googleClientId:'test-client'}));
writeFileSync('dist/admin/build.json',JSON.stringify({sha:process.env.GITHUB_SHA}));
writeFileSync('dist/env.json',JSON.stringify({origin:process.env.SITE_ORIGIN,base:process.env.SITE_BASE,secret:process.env.FIXTURE_SECRET}));
writeFileSync('dist/robots.txt','User-agent: *\\nDisallow: /\\n');
writeFileSync('dist/file.pdf','fixture-pdf');
`,
    'scripts/check-links.mjs': 'if (!process.env.SITE_ORIGIN || !process.env.GITHUB_SHA) process.exit(1);\n',
    'scripts/audit-links.mjs': 'if (!process.argv.includes("--strict")) process.exit(1);\n',
    ...extra,
  };
  for (const [path, data] of Object.entries(files)) { await mkdir(dirname(join(sourceRoot, path)), { recursive: true }); await writeFile(join(sourceRoot, path), data); }
  const git = async (...args) => (await run('git', args, { cwd: sourceRoot })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'user.name', 'Fixture');
  await git('add', '.'); await git('commit', '-m', 'Fixture');
  const commit = await git('rev-parse', 'HEAD');
  const apacheBaseline = join(base, 'htaccess.original');
  await writeFile(apacheBaseline, '# Existing cPanel PHP handler\n<IfModule mime_module>\n  AddHandler application/x-httpd-ea-php82 .php\n</IfModule>\n');
  return { base, sourceRoot, git, options: { sourceRoot, commit, branch: 'main', output: join(base, 'release'), siteOrigin: 'https://hichal.yoterberama.com', apiOrigin: 'https://api.example.test', siteBase: '/preview', apacheBaseline } };
}

test('staging artifact preserves exact source SHA, contains only public/runtime files and changes no source', async (t) => {
  const { options, sourceRoot, git } = await fixture(t);
  const prior = process.env.FIXTURE_SECRET; process.env.FIXTURE_SECRET = 'private-fixture-value';
  t.after(() => { if (prior === undefined) delete process.env.FIXTURE_SECRET; else process.env.FIXTURE_SECRET = prior; });
  const result = await packageCpanel(options), manifest = JSON.parse(await readFile(join(options.output, 'manifest.json'), 'utf8'));
  assert.equal(result.deploymentPerformed, false); assert.equal(result.deploymentReady, false);
  assert.equal(result.commit, options.commit); assert.equal(manifest.staging, true);
  assert.equal(manifest.runtime.entrypoint, 'server/start.mjs');
  assert.equal(manifest.runtime.passengerEntrypoint, 'passenger.cjs');
  assert.ok(manifest.files.some((file) => file.path === 'app/passenger.cjs'));
  assert.ok(manifest.files.some((file) => file.path === 'app/scripts/setup-google-auth.mjs'));
  assert.ok(manifest.files.some((file) => file.path === 'app/scripts/setup-local-invitations.mjs'));
  assert.ok(manifest.files.some((file) => file.path === `app/${RUNTIME_IDENTITY_FILE}`));
  const installed = await readRuntimeIdentity({ applicationRoot: join(options.output, 'app') });
  assert.equal(installed.commit, options.commit);
  assert.equal(installed.runtimeManifestSha256, runtimeManifestSha256(manifest));
  assert.equal(installed.verified, true);
  const identity = JSON.parse(await readFile(join(options.output, 'app', RUNTIME_IDENTITY_FILE), 'utf8'));
  assert.equal(identity.files.some((file) => file.path === RUNTIME_IDENTITY_FILE), false);
  assert.equal(identity.files.length + 1, manifest.files.filter((file) => file.path.startsWith('app/')).length);
  assert.equal((await stat(options.output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(options.output, 'manifest.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(options.output)).sort(), ['app', 'manifest.json', 'public']);
  assert.equal(manifest.files.some((file) => /(?:\.env|node_modules|\.git|data\/private)/.test(file.path)), false);
  for (const file of manifest.files) {
    const bytes = await readFile(join(options.output, file.path));
    assert.equal(file.bytes, bytes.length); assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(!bytes.includes('private-fixture-value'));
  }
  const config = JSON.parse(await readFile(join(options.output, 'public/admin/config.json'), 'utf8'));
  assert.equal(config.worker, options.apiOrigin); assert.equal(config.branch, 'main');
  assert.deepEqual(config.deployment, { target: 'cpanel', workflow: 'cpanel-release.yml', statusPath: 'deployment.json' });
  const index = await readFile(join(options.output, 'public/index.html'), 'utf8');
  assert.match(index, /name="robots" content="noindex,nofollow"/); assert.doesNotMatch(index, /content="index,follow"/);
  const admin = await readFile(join(options.output, 'public/admin/index.html'), 'utf8');
  for (const directive of ['connect-src', 'img-src', 'media-src']) assert.ok(admin.includes(`${directive} 'self' ${options.apiOrigin}`));
  const headers = await readFile(join(options.output, 'public/.htaccess'), 'utf8');
  assert.match(headers, /Header always set X-Robots-Tag "noindex, nofollow"/);
  assert.ok(headers.startsWith(await readFile(options.apacheBaseline, 'utf8')));
  assert.match(headers, /AddHandler application\/x-httpd-ea-php82/);
  assert.deepEqual(manifest.preserveHostPaths, ['.well-known', 'cgi-bin', 'php.ini', '.user.ini']);
  assert.doesNotMatch(await readFile(join(options.output, 'public/robots.txt'), 'utf8'), /Disallow/);
  assert.deepEqual(JSON.parse(await readFile(join(options.output, 'public/env.json'), 'utf8')), { origin: options.siteOrigin, base: '/preview' });
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal(await readFile(join(sourceRoot, '.env'), 'utf8'), 'SECRET_EXCLUDED_FROM_RELEASE=private-fixture-value\n');
});

test('release packaging refuses dirty, stale and ambiguous source selections', async (t) => {
  const { options, sourceRoot } = await fixture(t);
  await assert.rejects(packageCpanel({ ...options, commit: 'HEAD' }), /exact40-character/);
  await assert.rejects(packageCpanel({ ...options, commit: 'a'.repeat(40) }), /branch head/);
  await writeFile(join(sourceRoot, 'uncommitted.txt'), 'uncommitted');
  await assert.rejects(packageCpanel(options), /must be clean/);
  await assert.rejects(stat(options.output), { code: 'ENOENT' });
});

test('artifact destination cannot overwrite existing data or enter public/repository trees through a symlink', async (t) => {
  const { options, base, sourceRoot } = await fixture(t);
  await mkdir(options.output); await writeFile(join(options.output, 'keep.txt'), 'keep');
  await assert.rejects(packageCpanel(options), /new directory/);
  assert.equal(await readFile(join(options.output, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(packageCpanel({ ...options, output: join(sourceRoot, 'release') }), /outside the repository/);
  const publicRoot = join(base, 'public'); await mkdir(publicRoot);
  const alias = join(base, 'public-alias'); await symlink(publicRoot, alias);
  await assert.rejects(packageCpanel({ ...options, output: join(alias, 'release'), publicRoot }), /public document root/);
});

test('failed build validation produces no completed release', async (t) => {
  const { options } = await fixture(t, { 'scripts/check-links.mjs': 'process.exit(1);\n' });
  await assert.rejects(packageCpanel(options), /validation failed at scripts\/check-links/);
  await assert.rejects(stat(options.output), { code: 'ENOENT' });
});

test('API/public origins and base path must be explicit safe deployment coordinates', async (t) => {
  const { options } = await fixture(t);
  for (const apiOrigin of ['http://api.example.test', 'https://user:password@api.example.test', 'https://api.example.test/api?secret=bad', options.siteOrigin]) {
    await assert.rejects(packageCpanel({ ...options, apiOrigin }), /origin|apiOrigin/);
  }
  for (const siteBase of ['/../private', '//nested', '/path/', '/path?token=private']) await assert.rejects(packageCpanel({ ...options, siteBase }), /siteBase/);
});

test('same-origin API package preserves its path in config while CSP uses the exact origin', async (t) => {
  const { options } = await fixture(t);
  const apiUrl = options.siteOrigin + '/cms-api';
  await packageCpanel({ ...options, apiOrigin: apiUrl, siteBase: '' });
  const config = JSON.parse(await readFile(join(options.output, 'public/admin/config.json'), 'utf8'));
  assert.equal(config.worker, apiUrl);
  const manifest = JSON.parse(await readFile(join(options.output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.apiBasePath, '/cms-api'); assert.equal(manifest.apiOrigin, options.siteOrigin);
  const admin = await readFile(join(options.output, 'public/admin/index.html'), 'utf8');
  assert.ok(admin.includes(`connect-src 'self' ${options.siteOrigin}`));
  assert.ok(!admin.includes(`connect-src 'self' ${apiUrl}`));
});

test('a source commit without the Passenger bootstrap cannot become a completed release', async (t) => {
  const { options, git } = await fixture(t);
  await git('rm', 'passenger.cjs'); await git('commit', '-m', 'Fixture missing hosting entrypoint');
  await assert.rejects(packageCpanel({ ...options, commit: await git('rev-parse', 'HEAD') }), /required Node runtime file/);
  await assert.rejects(stat(options.output), { code: 'ENOENT' });
});
