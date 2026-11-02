// Companion to the immutable private 5185 operator. Run privately on cPanel.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeKind, routePrefix, seedRoute, statusState, verifyRoute } from './cpanel-route-guards.mjs';

const OPERATOR = '5185c67ff426d3983534ccd3de654ed9f53ffcc2';
const MANIFEST = '3266126c135e1e4e8c992b1d919b61ae23aead2cfb689044cacfa7751cf44e6f';
const ROOT = '/home/yoterber/hichal.yoterberama.com';
const ORIGIN = 'https://hichal.yoterberama.com';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => { throw new Error('cPanel operator contract mismatch'); };

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
    if (actual.length !== file.bytes || sha(actual) !== file.sha256) refuse();
  }
}

// Before/after states and all retained files are still pinned by the private
// contract. Selector status selects an explicitly approved stopped variant.
export function guardedTransitions({ scope, guard, selector, root, readSnapshot, verify = verifyRoute, seed = seedRoute }) {
  const next = scope.commit.slice(0, 8), old = scope.previousCommit.slice(0, 8);
  const destination = {
    'create-candidate': 'cms-api-check-' + next, 'park-old': 'cms-api-rollback-' + old,
    'promote-candidate': 'cms-api', 'park-candidate': 'cms-api-check-' + next, 'restore-old': 'cms-api',
  };
  const pending = { baseline: destination['create-candidate'], 'candidate-created': destination['park-old'] };
  let busy = false;
  async function inspect(state) {
    const snapshot = await selector.inspect();
    const status = commit => snapshot.applications.find(a => a.root === 'heichal-cms/releases/' + commit + '/app')?.status ?? null;
    const key = statusState(state, status(scope.previousCommit), status(scope.commit));
    const ledger = guard.expected(key);
    let result;
    try { result = await guard.verify(key); }
    catch (error) {
      // A crash after exclusive route creation and before Selector may leave
      // precisely our harmless prefix in a path pinned as absent. Admit that
      // one intermediate state only after rechecking the entire raw ledger.
      const route = pending[state];
      if (error.code !== 'host-drift' || !route || !ledger.files.some(f => f.path === route + '/.htaccess' && f.entry === null)) throw error;
      const prefix = Buffer.from(routePrefix(route));
      const files = ledger.files.map(f => f.path === route + '/.htaccess' ? { ...f, entry: { bytes: prefix.length, sha256: sha(prefix), mode: 0o644 } } : f);
      if (JSON.stringify(await readSnapshot({ files })) !== JSON.stringify(files)) throw error;
      await verify(root, route);
      result = { verified: true, state: key, snapshotSha256: sha(JSON.stringify({ ...ledger, files }) + '\n'), rootHtaccessSha256: files.find(f => f.path === '.htaccess').entry.sha256 };
    }
    for (const f of ledger.files) {
      if (f.entry && /^cms-api(?:-check-[a-f0-9]{8}|-rollback-[a-f0-9]{8})?\/\.htaccess$/.test(f.path)) await verify(root, f.path.split('/')[0]);
    }
    return result;
  }
  async function run(action, operation) {
    const t = scope.contract.transitions[action];
    if (busy || !t || typeof operation !== 'function') refuse();
    busy = true;
    try {
      await inspect(t.before);
      const route = destination[action];
      if (route) {
        if (!guard.expected(t.after).files.some(f => f.path === route + '/.htaccess' && f.entry)) refuse();
        await seed(root, route);
      }
      let value;
      try { value = await operation(); } finally { await inspect(t.after); }
      return { value };
    } finally { busy = false; }
  }
  return { expected: guard.expected, verify: inspect, run };
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
  const base = '/home/yoterber/heichal-cms/operator/' + OPERATOR;
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
      guardFactory: scope => guardedTransitions({ scope, guard: createHostContractGuard(scope), selector,
        root: config.documentRoot, readSnapshot: readHostContractSnapshot }),
    });
  } });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('cPanel deployment stopped; inspect the private configuration and journal.'); process.exitCode = 1; });
}
