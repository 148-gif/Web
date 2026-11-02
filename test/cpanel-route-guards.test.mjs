import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardOffset, routePrefix, seedRoute, statusState, verifyRoute } from '../scripts/cpanel-route-guards.mjs';
import { guardedTransitions, measuredDrainer, proveStoppedRoute, routeSnapshots } from '../scripts/deploy-cpanel-guarded.mjs';

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
  assert.equal(routePrefix('cms-api'), marker);
  assert.equal(routePrefix('cms-api-rollback-aaaaaaaa'), marker);
  assert.ok(marker.includes('RewriteCond %{REQUEST_URI} !^/cms-api(?:-check-[a-f0-9]{8})?(?:/|$)\nRewriteRule ^ - [R=503,L]'));
  for (const role of ['canonical', 'candidate']) assert.ok(marker.includes('.heichal-runtime-drain-' + role + ' -f\nRewriteRule ^ - [R=503,L]'));
  assert.ok(marker.includes('!^/cms-api(?:-check-[a-f0-9]{8})?/(?:version|me)$'));
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

test('Park and promote preserve the same rules when Selector copies the whole source file and retains both paths', linux, async t => {
  const root = await fixture(t), rollback = 'cms-api-rollback-aaaaaaaa';
  const file = uri => join(root, uri, '.htaccess');
  const previous = marker + 'Old private environment reference\n';
  const candidate = marker + 'New candidate environment reference\n';
  const promoted = marker + 'New active environment reference\n';
  const routes = ['cms-api', route, rollback];
  const layouts = {
    'candidate-created': [previous, candidate, null],
    'candidate-created-off-off': [previous, candidate, null],
    'candidate-created-off-off-retained': [previous, candidate, previous],
    'previous-parked-retained': [promoted, candidate, previous],
    'previous-parked': [previous, candidate, previous],
    'candidate-promoted': [promoted, candidate, previous],
    'candidate-promoted-off-off': [promoted, candidate, previous],
  };
  const expected = state => ({ files: routes.map((uri, i) => ({ path: uri + '/.htaccess',
    entry: layouts[state][i] === null ? null : entry(layouts[state][i]) })) });
  const guard = { expected, async verify(state) {
    for (const [i, uri] of routes.entries()) {
      const bytes = await readFile(file(uri), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (bytes !== layouts[state][i]) throw Object.assign(new Error('drift'), { code: 'host-drift' });
    }
    return { verified: true };
  } };
  let oldUri = '/cms-api', newUri = '/' + route;
  const selector = { async inspect() { return { applications: [[old, oldUri], [next, newUri]].map(([commit, uri]) =>
    ({ root: 'heichal-cms/releases/' + commit + '/app', domain: 'hichal.yoterberama.com', uri, status: 'stopped' })) }; } };
  const scope = { commit: next, previousCommit: old, contract: { states: Object.fromEntries(Object.keys(layouts).map(s => [s, true])), transitions: {
    'park-candidate': { before: 'candidate-promoted', after: 'previous-parked' },
    'restore-old': { before: 'previous-parked', after: 'candidate-created' },
    'park-old': { before: 'candidate-created', after: 'previous-parked' },
    'promote-candidate': { before: 'previous-parked', after: 'candidate-promoted' },
  } } };
  for (const [uri, bytes] of [['cms-api', previous], [route, candidate]]) {
    await seedRoute(root, uri); await writeFile(file(uri), bytes);
  }
  const api = guardedTransitions({ scope, guard, selector, root });
  await api.run('park-old', async () => {
    assert.equal(await readFile(file(rollback), 'utf8'), marker);
    await copyFile(file('cms-api'), file(rollback)); oldUri = '/' + rollback;
  });
  await api.run('promote-candidate', async () => {
    await copyFile(file(route), file('cms-api'));
    assert.equal(await readFile(file('cms-api'), 'utf8'), candidate);
    await writeFile(file('cms-api'), promoted); newUri = '/cms-api';
  });
  assert.equal(await readFile(file(route), 'utf8'), candidate);
  assert.equal(await readFile(file(rollback), 'utf8'), previous);
  await api.run('park-candidate', async () => {
    await copyFile(file('cms-api'), file(route)); await writeFile(file(route), candidate); newUri = '/' + route;
  });
  await api.run('restore-old', async () => { await copyFile(file(rollback), file('cms-api')); oldUri = '/cms-api'; });
  assert.deepEqual(api.expected('candidate-created'), expected('candidate-created-off-off-retained'));
  await writeFile(file(rollback), previous + '# drift');
  await assert.rejects(api.verify('candidate-created'));
});

test('a vacant empty file needs approval of its exact mode and a new route is traversable under a private umask', linux, async t => {
  const root = await fixture(t), file = join(root, route, '.htaccess');
  await mkdir(join(root, route)); await writeFile(file, '', { mode: 0o600 });
  await assert.rejects(seedRoute(root, route)); await assert.rejects(seedRoute(root, route, 0o644));
  await seedRoute(root, route, 0o600); assert.equal(await readFile(file, 'utf8'), marker);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const before = process.umask(0o077);
  try { await seedRoute(root, 'cms-api'); } finally { process.umask(before); }
  assert.equal((await lstat(join(root, 'cms-api'))).mode & 0o777, 0o755);
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

test('only the exact generated Passenger section can precede the guard, and the physical digest survives publication', async () => {
  const provider = ['# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN',
    'PassengerAppRoot "/home/yoterber/heichal-cms/releases/' + next + '/app"', 'PassengerBaseURI "/' + route + '"',
    'PassengerNodejs "/home/yoterber/nodevenv/heichal-cms/releases/' + next + '/app/24/bin/node"',
    'PassengerAppType node', 'PassengerStartupFile passenger.cjs', '# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END', ''].join('\n');
  const env = 'SetEnv CMS_ENV_FILE /private/approved\n';
  const file = bytes => ({ path: route + '/.htaccess', runtimeCommit: next, entry: entry(bytes) });
  const expected = [file(marker + provider + env)];
  let actual = Buffer.from(provider + marker + env);
  const snapshot = routeSnapshots({ commit: next, previousCommit: old }, '/unused', async () => [file(actual)], async () => actual);
  assert.equal(guardOffset(actual, route), Buffer.byteLength(provider));
  assert.deepEqual(await snapshot.inspect(expected), expected);
  assert.deepEqual(snapshot.physicalLedger({ files: expected }).files, [file(actual)]);
  actual = Buffer.from(provider + marker + env.replace('approved', 'tampered'));
  assert.notDeepEqual(await snapshot.inspect(expected), expected);
  for (const bad of [provider.replace('passenger.cjs', 'arbitrary.cjs'), provider.replace('/24/bin/node', '/22/bin/node'), 'RewriteRule ^ - [L]\n' + provider]) {
    assert.throws(() => guardOffset(Buffer.from(bad + marker + env), route));
  }
});

test('LiteSpeed title is an exact argument while original drainer still receives the full target and admission proof', async () => {
  const prefix = 'lsnode:/home/yoterber/heichal-cms/releases/';
  const contract = { uid: 1148, lsnode: { realPath: '/pinned/node', commandLineTemplate: [prefix + '{{COMMIT31}}'] } };
  const evidence = [];
  const drainer = measuredDrainer({ contract }, ({ contract: scoped }) => ({
    inspect(options) { evidence.push([scoped, options]); }, drain(options) { evidence.push([scoped, options]); },
  }));
  for (const commit of [old, next]) {
    const options = { target: { commit }, selectorStopped: true, admissionClosed: true, expectedProcesses: [] };
    await drainer.inspect(options); await drainer.drain(options);
    const [scoped, original] = evidence.at(-1);
    assert.deepEqual(scoped.lsnode.commandLineTemplate, [prefix + commit.slice(0, 31)]);
    assert.equal(scoped.lsnode.realPath, contract.lsnode.realPath); assert.equal(scoped.uid, contract.uid);
    assert.equal(original, options); assert.equal(original.target.commit.length, 40);
  }
  assert.throws(() => drainer.drain({ target: { commit: old.slice(0, 31) } }));
  assert.throws(() => measuredDrainer({ contract: { lsnode: { commandLineTemplate: [prefix + '*'] } } }, () => {}));
});
