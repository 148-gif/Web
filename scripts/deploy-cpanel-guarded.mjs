// Companion to the immutable private 5185 operator. Run privately on cPanel.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, symlink } from 'node:fs/promises';
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
  const observedLedgers = new Map();
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
      if (!result) {
        ledger = await verifySeededDestination(error, state, snapshot, ledger);
        result = { verified: true, state: key, rootHtaccessSha256: ledger.files.find(f => f.path === '.htaccess').entry.sha256 };
      }
    }
    for (const f of ledger.files) {
      if (!/^cms-api(?:-check-[a-f0-9]{8}|-rollback-[a-f0-9]{8})?\/\.htaccess$/.test(f.path)) continue;
      const route = f.path.split('/')[0];
      if (f.entry === null || empty(f.entry)) {
        if (occupied(snapshot.applications, route)) refuse();
      } else await verify(root, route);
    }
    const physical = physicalLedger(ledger);
    observedLedgers.set(state, physical);
    return { ...result, contractState: key, snapshotSha256: sha(JSON.stringify(physical) + '\n') };
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
    return { ...ledger, files };
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
  return { expected: state => observedLedgers.get(state) ?? guard.expected(state), verify: inspect, run };
}

// LiteSpeed truncates the displayed title at 74 bytes on this host. This is an
// exact argument, not a prefix match. The original drainer separately proves
// the full working directory, uid, executable, environment and PID identity.
export function measuredDrainer({ contract }, create) {
  const template = 'lsnode:/home/yoterber/heichal-cms/releases/{{COMMIT31}}';
  if (contract.lsnode.commandLineTemplate.length !== 1 || contract.lsnode.commandLineTemplate[0] !== template) refuse();
  function forTarget(options) {
    if (typeof options?.target?.commit !== 'string' || !/^[a-f0-9]{40}$/.test(options.target.commit)) refuse();
    const argument = template.replace('{{COMMIT31}}', options.target.commit.slice(0, 31));
    return create({ contract: { ...contract, lsnode: { ...contract.lsnode, commandLineTemplate: [argument] } } });
  }
  return { inspect: options => forTarget(options).inspect(options), drain: options => forTarget(options).drain(options) };
}

export async function proveStoppedRoute(uri, fetcher = fetch) {
  if (typeof uri !== 'string' || !uri.startsWith('/')) refuse();
  routeKind(uri.slice(1));
  const res = await fetcher(ORIGIN + uri + '/version', { method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
  try { if (res.status !== 503 || res.redirected || !/\bnoindex\b/i.test(res.headers.get('X-Robots-Tag') || '')) refuse(); }
  finally { await res.body?.cancel().catch(() => {}); }
}

// The provider's create grammar accepts a domain OR user. Other operations
// remain user scoped. The native adapter still verifies all applications.
export function selectorArguments(args) {
  if (args[0] !== 'create') return args;
  if (args.slice(1, 6).join(' ') !== '--json --interpreter nodejs --user yoterber' ||
      args.filter(value => value === '--domain').length !== 1 || args[args.indexOf('--domain') + 1] !== 'hichal.yoterberama.com') refuse();
  return [...args.slice(0, 4), ...args.slice(6)];
}

export async function capacityGate(options, inspect) {
  const result = await inspect(options);
  if (options.phase === 'download') {
    // The extracted private candidate occupies retention as well as account
    // space. Use the same worst-case archive reserve as the measured gate.
    for (const [unit, ceiling] of [['bytes', 'retentionBytes'], ['inodes', 'retentionInodes']]) {
      const peak = result.projectedManaged[unit] - result.public[unit] - result.headroom[unit];
      if (peak > options.capacity[ceiling]) throw Object.assign(new Error('Download retention budget exceeded'), { code: 'capacity' });
    }
  }
  return result;
}

// Capture stage and fixed provider error categories only. Child stdout/stderr,
// argv, runtime environment and error messages remain private.
async function stage(name, operation) {
  try { return await operation(); }
  catch (error) {
    const categories = ['host-drift','target-mismatch','command-failed','command-rejected','state-drift','unrelated-app-drift','postcondition-failed','operation-busy','invalid-baseline','configuration-drift','unsafe-dependency','installation-capacity','unverified-dependencies','toolchain-drift','process-identity','process-respawn','term-timeout','helper-failed','process-access','admission-required','unknown-state','private-state','capacity','tree','unsafe-host-file','unapproved-host-file','operation-failed','unsafe-permissions','unsafe-file','module-link-mismatch','module-target-drift','unsupported-lock','invalid-lock','unverified-toolchain','toolchain-version','installer-command','extraneous-dependency','dependency-version','installation-budget','dependency-budget','unsafe-source','installed-inventory','identity-mismatch','configuration-drift'];
    console.error('cPanel stage:', name, categories.includes(error?.code) ? error.code : 'failed');
    throw error;
  }
}
function traced(service, names) {
  const wrappers = Object.fromEntries(names.map(name => [name, (...args) => stage(name, () => service[name](...args))]));
  return { ...service, ...wrappers };
}

// The Selector CLI creates the virtual environment before it creates the app's
// node_modules link. The UI's npm action normally supplies that final layout.
export async function linkEmptyModules(appRoot, venv) {
  const uid = process.getuid();
  async function dir(path, create = false) {
    if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7022) || await realpath(path) !== path) refuse();
    return info;
  }
  const app = await dir(appRoot), env = await dir(venv), link = join(appRoot, 'node_modules');
  if ((app.mode & 0o7777) !== 0o700) refuse();
  const lib = join(venv, 'lib'), modules = join(lib, 'node_modules');
  let original;
  try { original = await lstat(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (original) {
    if (!original.isSymbolicLink() || original.uid !== uid || await readlink(link) !== modules || await realpath(link) !== modules) refuse();
    return;
  }
  await dir(lib, true); await dir(modules, true);
  if ((await readdir(modules)).length || (await dir(venv)).ino !== env.ino || (await dir(appRoot)).ino !== app.ino) refuse();
  await symlink(modules, link, 'dir');
  if (await readlink(link) !== modules || await realpath(link) !== modules) refuse();
  for (const path of [lib, venv, appRoot]) {
    const directory = await open(path, constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export async function prepareModuleLink(options, selector) {
  const commit = options?.plan?.commit;
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) refuse();
  const root = 'heichal-cms/releases/' + commit + '/app', app = '/home/yoterber/' + root, venv = '/home/yoterber/nodevenv/' + root + '/24';
  const found = (await selector.inspect()).applications.filter(a => a.root === root);
  if (options.plan.applicationRoot !== app || options.toolchain?.virtualenvRoot !== venv || options.toolchain.modulesPath !== venv + '/lib/node_modules' ||
      found.length !== 1 || found[0].uri !== '/cms-api-check-' + commit.slice(0, 8) || found[0].domain !== 'hichal.yoterberama.com' ||
      found[0].status !== 'stopped' || found[0].startup !== 'passenger.cjs' || found[0].mode !== 'production' || found[0].version !== '24.22.2') refuse();
  await linkEmptyModules(app, venv);
}

async function main(args) {
  if (args.length === 2 && args[0] === '--print-guard') { process.stdout.write(routePrefix(args[1])); return; }
  const base = '/home/yoterber/heichal-cms/operator/' + OPERATOR + '-guarded-v1';
  await checkedModuleTree(base);
  const load = path => import(pathToFileURL(join(base, path)).href);
  const { deploymentCli } = await load('scripts/deploy-cpanel.mjs');
  const { readCpanelDeploymentConfiguration, createCpanelDeploymentDriver } = await load('server/cpanel-deployment-adapter.mjs');
  const { createCloudlinuxSelector } = await load('server/cloudlinux-selector.mjs');
  const { createLsnodeDrainer } = await load('server/cpanel-process-drain.mjs');
  const { inspectDeploymentCapacity } = await load('server/deployment-capacity.mjs');
  const { createRuntimeInstaller } = await load('server/cpanel-runtime-install.mjs');
  const { probeCpanelRuntime } = await load('server/cpanel-runtime-probe.mjs');
  const { createHostContractGuard, readHostContractSnapshot } = await load('server/cpanel-host-contract.mjs');
  const result = await deploymentCli(args, { readConfiguration: readCpanelDeploymentConfiguration, driver(config) {
    if (config.documentRoot !== ROOT) refuse();
    const run = promisify(execFile);
    const raw = createCloudlinuxSelector({ uriStyle: config.selector.uriStyle, execute(file, args, options) {
      if (file !== '/usr/sbin/cloudlinux-selector') refuse();
      return run(file, selectorArguments(args), options);
    } });
    const selector = traced(raw, ['create','start','stop','setUri','setRuntimePhase']);
    const installer = createRuntimeInstaller();
    return createCpanelDeploymentDriver(config, {
      installer: traced({ ...installer, async install(options) {
        await stage('candidate-module-link', () => prepareModuleLink(options, selector));
        return installer.install(options);
      } }, ['plan','materialize','install','inspect']),
      runtimeProbe: options => stage('runtime-proof', () => probeCpanelRuntime(options)),
      capacityCheck: options => stage('capacity-' + options.phase, () => capacityGate(options, inspectDeploymentCapacity)),
      drainerFactory: options => traced(measuredDrainer(options, createLsnodeDrainer), ['inspect','drain']),
      selector: { ...selector, async stop(options) {
        const uri = options.snapshot.applications.find(a => a.root === options.target.root)?.uri;
        const stopped = await selector.stop(options);
        await proveStoppedRoute(uri);
        return stopped;
      } },
      guardFactory(scope) {
        const placement = routeSnapshots(scope, config.documentRoot, readHostContractSnapshot);
        return traced(guardedTransitions({ scope, guard: createHostContractGuard({ ...scope, readSnapshot: placement.inspect }), selector,
          root: config.documentRoot, readSnapshot: ({ files }) => placement.inspect(files), physicalLedger: placement.physicalLedger }), ['verify','run']);
      },
    });
  } });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const allowed = new Set(['baseline-drift', 'baseline-required', 'capacity', 'configuration', 'contract', 'disabled', 'locked', 'operation-failed', 'package', 'private-state', 'public-proof', 'recovery-required', 'runtime', 'selector-drift', 'source-changed', 'source-unavailable', 'host-drift', 'invalid-scope', 'unknown-state', 'account-inodes', 'filesystem-inodes', 'retention-inodes', 'account-bytes', 'filesystem-bytes', 'retention-bytes']);
    console.error('cPanel deployment stopped:', allowed.has(error?.code) ? error.code : 'inspect private configuration and journal');
    process.exitCode = 1;
  });
}
