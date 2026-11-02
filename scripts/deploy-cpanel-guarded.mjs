// Companion to the immutable private 5185 operator. Run privately on cPanel.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardOffset, readRoute, routeKind, routePrefix, seedRoute, statusState, verifyRoute } from './cpanel-route-guards.mjs';

const OPERATOR = '5185c67ff426d3983534ccd3de654ed9f53ffcc2';
const MANIFEST = '3266126c135e1e4e8c992b1d919b61ae23aead2cfb689044cacfa7751cf44e6f';
// Reproducible from the verified 5185 manifest and cpanel-operator-5185.patch.
const patched = new Map([
  ['server/cpanel-host-contract.mjs', { bytes: 21004, sha256: '010812d399b384fa35c4d9b21c9e93f6480118a3dd88535d6a49cece3f7c48db' }],
  ['server/cpanel-deployment-adapter.mjs', { bytes: 60874, sha256: 'e3b810032f3e24b7b8c8d0d09ae061c5f1be95c90e130961ece0c16f09c924ab' }],
  ['server/deployment-capacity.mjs', { bytes: 9761, sha256: '4a12be29c26a2f1f8552d087b1ae579661bc5af9fd52839bb9bed2d9b2b39490' }],
]);
const ROOT = '/home/yoterber/hichal.yoterberama.com';
const ORIGIN = 'https://hichal.yoterberama.com';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => { throw new Error('cPanel operator contract mismatch'); };
const empty = entry => entry?.bytes === 0 && entry.sha256 === sha('');
function occupied(apps, route) {
  const uri = '/' + route;
  return apps.some(a => a.domain === 'hichal.yoterberama.com' &&
    (a.uri === '/' || a.uri === uri || a.uri.startsWith(uri + '/') || uri.startsWith(a.uri + '/')));
}

async function checkedModuleTree(base) {
  const uid = BigInt(process.getuid());
  async function bytes(relative) {
    const path = join(base, relative);
    if (await realpath(path) !== path) refuse();
    for (let dir = path.slice(0, path.lastIndexOf('/')); dir.startsWith('/home/yoterber/heichal-cms'); dir = dir.slice(0, dir.lastIndexOf('/'))) {
      const s = await lstat(dir, { bigint: true });
      if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o7777n) !== 0o700n) refuse();
    }
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat({ bigint: true });
      if (!s.isFile() || s.nlink !== 1n || s.uid !== uid || (s.mode & 0o7777n) !== 0o600n || s.size > 1048576n) refuse();
      const data = await h.readFile();
      const named = await lstat(path, { bigint: true });
      if (s.ino !== named.ino || s.dev !== named.dev || s.ctimeNs !== named.ctimeNs || BigInt(data.length) !== s.size) refuse();
      return data;
    } finally { await h.close(); }
  }
  const raw = await bytes('operator-manifest.json');
  if (sha(raw) !== MANIFEST) refuse();
  for (const file of JSON.parse(raw).files) {
    const actual = await bytes(file.path);
    const pin = patched.get(file.path) ?? file;
    if (actual.length !== pin.bytes || sha(actual) !== pin.sha256) refuse();
  }
}

// Compare either measured placement of the same Passenger block. The physical
// bytes, modes and hashes are kept for the durable ledger and recovery.
export function routeSnapshots(scope, root, snapshot, read = readRoute) {
  const placements = new Map();
  const managed = new Set(['cms-api', ...[scope.commit, scope.previousCommit].flatMap(commit =>
    ['cms-api-check-', 'cms-api-rollback-'].map(prefix => prefix + commit.slice(0, 8)))]);
  const key = files => sha(JSON.stringify(files));
  async function inspect(expected) {
    const physical = await snapshot({ files: expected });
    if (physical.length !== expected.length) refuse();
    const compared = [];
    for (const [i, actual] of physical.entries()) {
      const wanted = expected[i];
      if (actual.path !== wanted.path || actual.runtimeCommit !== wanted.runtimeCommit) refuse();
      const route = actual.path.split('/')[0];
      if (!managed.has(route) || actual.path !== route + '/.htaccess' || !wanted.entry || !actual.entry ||
          actual.entry.bytes !== wanted.entry.bytes || actual.entry.mode !== wanted.entry.mode || actual.entry.sha256 === wanted.entry.sha256) {
        compared.push(actual); continue;
      }
      const bytes = await read(root, route);
      if (sha(bytes) !== actual.entry.sha256) refuse();
      let offset;
      try { offset = guardOffset(bytes, route); } catch { compared.push(actual); continue; }
      const n = Buffer.byteLength(routePrefix(route));
      const canonical = Buffer.concat([bytes.subarray(offset, offset + n), bytes.subarray(0, offset), bytes.subarray(offset + n)]);
      compared.push(offset > 0 && sha(canonical) === wanted.entry.sha256 ? wanted : actual);
    }
    if (JSON.stringify(compared) === JSON.stringify(expected)) placements.set(key(expected), physical);
    return compared;
  }
  function physicalLedger(ledger) {
    const files = placements.get(key(ledger.files));
    return files ? { ...ledger, files } : ledger;
  }
  return { inspect, physicalLedger };
}

// Before/after states and all retained files are still pinned by the private
// contract. Selector status selects an explicitly approved stopped variant.
export function guardedTransitions({ scope, guard, selector, root, readSnapshot, physicalLedger = ledger => ledger, verify = verifyRoute, seed = seedRoute }) {
  const next = scope.commit.slice(0, 8), old = scope.previousCommit.slice(0, 8);
  const destination = {
    'create-candidate': 'cms-api-check-' + next, 'park-old': 'cms-api-rollback-' + old,
    'promote-candidate': 'cms-api', 'park-candidate': 'cms-api-check-' + next, 'restore-old': 'cms-api',
  };
  const pending = { baseline: destination['create-candidate'], 'candidate-created': destination['park-old'] };
  const observedStates = new Map();
  let busy = false;
  async function inspect(state) {
    const snapshot = await selector.inspect();
    const status = commit => snapshot.applications.find(a => a.root === 'heichal-cms/releases/' + commit + '/app')?.status ?? null;
    const primary = statusState(state, status(scope.previousCommit), status(scope.commit));
    const retained = primary + '-retained';
    let key = primary, result;
    let ledger = guard.expected(key);
    try { result = await guard.verify(key); }
    catch (error) {
      if (error.code !== 'host-drift') throw error;
      // After a reverse URI move Selector retains the former source file. The
      // only alternative is a separately pinned, exact, whole-ledger snapshot.
      if (scope.contract.states?.[retained]) {
        try { result = await guard.verify(retained); }
        catch (other) { if (other.code !== 'host-drift') throw other; }
        if (result) { key = retained; ledger = guard.expected(key); }
      }
      if (!result) result = await verifySeededDestination(error, state, snapshot, ledger);
    }
    for (const f of ledger.files) {
      if (!/^cms-api(?:-check-[a-f0-9]{8}|-rollback-[a-f0-9]{8})?\/\.htaccess$/.test(f.path)) continue;
      const route = f.path.split('/')[0];
      if (f.entry === null || empty(f.entry)) {
        if (occupied(snapshot.applications, route)) refuse();
      } else await verify(root, route);
    }
    observedStates.set(state, key);
    const physical = physicalLedger(ledger);
    if (physical !== ledger) result = { ...result, snapshotSha256: sha(JSON.stringify(physical) + '\n') };
    return { ...result, contractState: key };
  }
  async function verifySeededDestination(error, state, snapshot, ledger) {
    // A crash after exclusive route creation and before Selector may leave
    // precisely our harmless prefix in a path pinned as absent. Admit that
    // one intermediate state only after rechecking the entire raw ledger.
    const route = pending[state];
    const slot = ledger.files.find(f => f.path === route + '/.htaccess');
    if (error.code !== 'host-drift' || !route || !slot || occupied(snapshot.applications, route) || !(slot.entry === null || empty(slot.entry))) throw error;
    const prefix = Buffer.from(routePrefix(route));
    const files = ledger.files.map(f => f === slot ? { ...f, entry: { bytes: prefix.length, sha256: sha(prefix), mode: slot.entry?.mode ?? 0o644 } } : f);
    if (JSON.stringify(await readSnapshot({ files })) !== JSON.stringify(files)) throw error;
    await verify(root, route);
    return { verified: true, state, snapshotSha256: sha(JSON.stringify({ ...ledger, files }) + '\n'), rootHtaccessSha256: files.find(f => f.path === '.htaccess').entry.sha256 };
  }
  async function run(action, operation) {
    const t = scope.contract.transitions[action];
    if (busy || !t || typeof operation !== 'function') refuse();
    busy = true;
    try {
      const proof = await inspect(t.before);
      const route = destination[action];
      if (route) {
        if (!guard.expected(t.after).files.some(f => f.path === route + '/.htaccess' && f.entry)) refuse();
        const before = guard.expected(proof.contractState).files.find(f => f.path === route + '/.htaccess');
        if (!before) refuse();
        await seed(root, route, empty(before.entry) ? before.entry.mode : null);
      }
      let value;
      try { value = await operation(); } finally { await inspect(t.after); }
      return { value };
    } finally { busy = false; }
  }
  return { expected: state => physicalLedger(guard.expected(observedStates.get(state) ?? state)), verify: inspect, run };
}

export async function proveStoppedRoute(uri, fetcher = fetch) {
  if (typeof uri !== 'string' || !uri.startsWith('/')) refuse();
  routeKind(uri.slice(1));
  const res = await fetcher(ORIGIN + uri + '/version', { method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
  try { if (res.status !== 503 || res.redirected || !/\bnoindex\b/i.test(res.headers.get('X-Robots-Tag') || '')) refuse(); }
  finally { await res.body?.cancel().catch(() => {}); }
}

async function main(args) {
  if (args.length === 2 && args[0] === '--print-guard') { process.stdout.write(routePrefix(args[1])); return; }
  const base = '/home/yoterber/heichal-cms/operator/' + OPERATOR + '-guarded-v1';
  await checkedModuleTree(base);
  const load = path => import(pathToFileURL(join(base, path)).href);
  const { deploymentCli } = await load('scripts/deploy-cpanel.mjs');
  const { readCpanelDeploymentConfiguration, createCpanelDeploymentDriver } = await load('server/cpanel-deployment-adapter.mjs');
  const { createCloudlinuxSelector } = await load('server/cloudlinux-selector.mjs');
  const { createHostContractGuard, readHostContractSnapshot } = await load('server/cpanel-host-contract.mjs');
  const result = await deploymentCli(args, { readConfiguration: readCpanelDeploymentConfiguration, driver(config) {
    if (config.documentRoot !== ROOT) refuse();
    const selector = createCloudlinuxSelector({ uriStyle: config.selector.uriStyle });
    return createCpanelDeploymentDriver(config, {
      selector: { ...selector, async stop(options) {
        const uri = options.snapshot.applications.find(a => a.root === options.target.root)?.uri;
        const stopped = await selector.stop(options);
        await proveStoppedRoute(uri);
        return stopped;
      } },
      guardFactory(scope) {
        const placement = routeSnapshots(scope, config.documentRoot, readHostContractSnapshot);
        return guardedTransitions({ scope, guard: createHostContractGuard({ ...scope, readSnapshot: placement.inspect }), selector,
          root: config.documentRoot, readSnapshot: readHostContractSnapshot, physicalLedger: placement.physicalLedger });
      },
    });
  } });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('cPanel deployment stopped; inspect the private configuration and journal.'); process.exitCode = 1; });
}
