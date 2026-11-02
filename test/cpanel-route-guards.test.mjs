import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routePrefix, seedRoute, statusState, verifyRoute } from '../scripts/cpanel-route-guards.mjs';
import { guardedTransitions, proveStoppedRoute } from '../scripts/deploy-cpanel-guarded.mjs';

const linux = { skip: typeof process.getuid !== 'function' };
const old = 'a'.repeat(40), next = 'b'.repeat(40), route = 'cms-api-check-bbbbbbbb';
const marker = routePrefix(route);
const entry = text => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), mode: 0o644 });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'heichal-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('role markers close health probes too, maintenance admits only the exact GET/HEAD health paths', () => {
  assert.match(marker, /candidate -f\nRewriteRule \^ - \[R=503,L\]/);
  assert.ok(marker.includes('!^/cms-api-check-bbbbbbbb/(version|me)$'));
  assert.ok(routePrefix('cms-api').includes('.heichal-runtime-drain-canonical -f'));
  const parked = routePrefix('cms-api-rollback-aaaaaaaa');
  assert.ok(parked.includes('RewriteRule ^ - [R=503,L]')); assert.ok(!parked.includes('RewriteCond'));
  for (const path of ['other', '../cms-api', 'cms-api-check-short', '/cms-api', 'cms-api-rollback-aaaaaaaa/extra']) assert.throws(() => routePrefix(path));
});

test('only a safe, empty destination can be claimed', linux, async t => {
  const root = await fixture(t), other = join(root, 'unrelated');
  await mkdir(other); await writeFile(join(other, 'keep'), 'unchanged');
  await symlink(other, join(root, route));
  await assert.rejects(seedRoute(root, route));
  assert.equal(await readFile(join(other, 'keep'), 'utf8'), 'unchanged');
  const canonical = join(root, 'cms-api'); await mkdir(canonical);
  await writeFile(join(canonical, '.htaccess'), 'private provider configuration\n');
  await assert.rejects(seedRoute(root, 'cms-api'));
  assert.equal(await readFile(join(canonical, '.htaccess'), 'utf8'), 'private provider configuration\n');
});

for (const interrupted of [false, true]) test('create checks the route before Selector and pins both Passenger states; preseed=' + interrupted, linux, async t => {
  const root = await fixture(t), path = join(root, route, '.htaccess');
  const started = marker + '# Passenger mapping\nPrivateEnv reference\n', stopped = marker + 'PrivateEnv reference\n';
  const states = { baseline: null, 'candidate-created-on-on': started, 'candidate-created': stopped };
  let status = null;
  const selector = { async inspect() { return { applications: [
    { root: 'heichal-cms/releases/' + old + '/app', status: 'started' },
    ...(status ? [{ root: 'heichal-cms/releases/' + next + '/app', status }] : []),
  ] }; } };
  const expected = key => {
    assert.ok(Object.hasOwn(states, key));
    return { files: [{ path: '.htaccess', entry: entry('fixed') },
      { path: route + '/.htaccess', entry: states[key] === null ? null : entry(states[key]) }] };
  };
  async function readSnapshot({ files }) {
    let actual = null;
    try { actual = entry(await readFile(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return [files[0], { ...files[1], entry: actual }];
  }
  const guard = { expected, async verify(key) {
    const wanted = expected(key);
    if (JSON.stringify(await readSnapshot(wanted)) !== JSON.stringify(wanted.files)) throw Object.assign(new Error('drift'), { code: 'host-drift' });
    return { verified: true };
  } };
  const scope = { commit: next, previousCommit: old, contract: { transitions: {
    'create-candidate': { before: 'baseline', after: 'candidate-created' },
  } } };
  const api = guardedTransitions({ root, scope, selector, guard, readSnapshot });
  if (interrupted) {
    await seedRoute(root, route); await api.verify('baseline');
    await writeFile(path, marker + 'unexpected'); await assert.rejects(api.verify('baseline'));
    await writeFile(path, marker);
  }
  await api.run('create-candidate', async () => {
    assert.equal(await readFile(path, 'utf8'), marker);
    await writeFile(path, started); status = 'started';
  });
  await writeFile(path, stopped); status = 'stopped'; await api.verify('candidate-created');
  await writeFile(path, stopped.replace('PrivateEnv', 'changed')); await assert.rejects(api.verify('candidate-created'));
  await writeFile(path, 'PrivateEnv reference\n'); await assert.rejects(verifyRoute(root, route));
});

test('stop proof requires 503 and noindex on that route after Selector returns', async () => {
  const uri = '/' + route;
  await proveStoppedRoute(uri, async (url, options) => {
    assert.equal(url, 'https://hichal.yoterberama.com' + uri + '/version');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return new Response(null, { status: 503, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
  });
  for (const status of [200, 403, 503]) await assert.rejects(proveStoppedRoute(uri, async () => new Response(null, { status })));
  assert.equal(statusState('candidate-promoted', 'stopped', 'started'), 'candidate-promoted');
  assert.equal(statusState('candidate-promoted', 'stopped', 'stopped'), 'candidate-promoted-off-off');
  assert.throws(() => statusState('baseline', 'started', 'started'));
});
