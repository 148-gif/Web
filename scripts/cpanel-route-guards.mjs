// Route-local Apache guards for the private cPanel deployment operator.
import { constants as F } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const HEADER = '# BEGIN HEICHAL CPANEL ROUTE v1';
const FOOTER = '# END HEICHAL CPANEL ROUTE v1';
const reject = () => { throw new Error('cPanel route protection could not be verified'); };

export function routeKind(route) {
  if (typeof route !== 'string') reject();
  if (route === 'cms-api') return 'canonical';
  if (/^cms-api-check-[a-f0-9]{8}$/.test(route)) return 'candidate';
  if (/^cms-api-rollback-[a-f0-9]{8}$/.test(route)) return 'rollback';
  return reject();
}

export function routePrefix(route) {
  routeKind(route);
  // Selector moves its source .htaccess onto the destination. Identical bytes
  // must choose the correct admission rule at both URIs, even during a move.
  return [HEADER, 'RewriteEngine On',
    'RewriteCond %{REQUEST_URI} !^/cms-api(?:-check-[a-f0-9]{8})?(?:/|$)',
    'RewriteRule ^ - [R=503,L]',
    'RewriteCond %{REQUEST_URI} ^/cms-api(?:/|$)',
    'RewriteCond %{DOCUMENT_ROOT}/.heichal-runtime-drain-canonical -f',
    'RewriteRule ^ - [R=503,L]',
    'RewriteCond %{REQUEST_URI} ^/cms-api-check-[a-f0-9]{8}(?:/|$)',
    'RewriteCond %{DOCUMENT_ROOT}/.heichal-runtime-drain-candidate -f',
    'RewriteRule ^ - [R=503,L]',
    'RewriteCond %{DOCUMENT_ROOT}/.cpanel-maintenance -f',
    'RewriteCond %{REQUEST_METHOD} !^(GET|HEAD)$ [OR]',
    'RewriteCond %{REQUEST_URI} !^/cms-api(?:-check-[a-f0-9]{8})?/(?:version|me)$',
    'RewriteRule ^ - [R=503,L]', FOOTER, '',
  ].join('\n');
}

const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
function owned(info) {
  return typeof process.getuid === 'function' && info.uid === BigInt(process.getuid()) && !(info.mode & 0o7022n);
}
async function directory(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || !owned(info) || await realpath(path) !== path) reject();
  return info;
}
async function syncDirectory(path) {
  const handle = await open(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// The private Apache contract separately pins every byte, including the
// provider-generated Passenger and environment sections. Inspect just the
// required prefix here so no private configuration enters errors or logs.
export async function verifyRoute(root, route) {
  const required = Buffer.from(routePrefix(route));
  const parent = join(root, route), path = join(parent, '.htaccess');
  const rootInfo = await directory(root), parentInfo = await directory(parent);
  if (rootInfo.dev !== parentInfo.dev) reject();
  const handle = await open(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || !owned(info) || info.nlink !== 1n || info.size < BigInt(required.length)) reject();
    const prefix = Buffer.alloc(required.length);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const named = await lstat(path, { bigint: true });
    if (bytesRead !== prefix.length || !prefix.equals(required) || !sameNode(info, named) ||
        info.size !== named.size || info.ctimeNs !== named.ctimeNs || !sameNode(parentInfo, await directory(parent))) reject();
  } finally { await handle.close(); }
}

// Only a previously absent, approved destination is initialized. This never
// rewrites an existing Passenger file. An interrupted seed retains its guard;
// recovery inspects the pinned protected-file inventory before proceeding.
export async function seedRoute(root, route, approvedEmptyMode = null) {
  const prefix = routePrefix(route);
  const parent = join(root, route), path = join(parent, '.htaccess');
  const rootInfo = await directory(root);
  let created = false;
  try { await mkdir(parent, { mode: 0o755 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) {
    const dir = await open(parent, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    try {
      if (!sameNode(await dir.stat({ bigint: true }), await directory(parent))) reject();
      await dir.chmod(0o755); // The private Cron normally uses umask 077.
    } finally { await dir.close(); }
  }
  const parentInfo = await directory(parent);
  if (parentInfo.dev !== rootInfo.dev) reject();
  const entries = await readdir(parent);
  let empty = null;
  if (entries.includes('.htaccess')) {
    const info = await lstat(path, { bigint: true });
    if (info.size !== 0n || approvedEmptyMode === null) { await verifyRoute(root, route); return; }
    if (entries.length !== 1 || !info.isFile() || !owned(info) || info.nlink !== 1n || Number(info.mode & 0o777n) !== approvedEmptyMode) reject();
    empty = info;
  } else if (entries.length) reject();
  const handle = await open(path, F.O_WRONLY | F.O_NONBLOCK | F.O_NOFOLLOW | (empty ? 0 : F.O_CREAT | F.O_EXCL), 0o644);
  try {
    if (empty) {
      const info = await handle.stat({ bigint: true });
      if (!sameNode(info, empty) || info.nlink !== 1n || info.size !== 0n || info.ctimeNs !== empty.ctimeNs) reject();
    } else await handle.chmod(0o644);
    await handle.writeFile(prefix); await handle.sync();
    if (!sameNode(await handle.stat({ bigint: true }), await lstat(path, { bigint: true }))) reject();
  } finally { await handle.close(); }
  if (!sameNode(parentInfo, await directory(parent))) reject();
  await syncDirectory(parent); await syncDirectory(root); await verifyRoute(root, route);
}

export function statusState(state, previousStatus, candidateStatus) {
  const normal = {
    baseline: ['started', null],
    'candidate-created': ['started', 'stopped'],
    'previous-parked': ['stopped', 'stopped'],
    'candidate-promoted': ['stopped', 'started'],
  };
  if (!Object.hasOwn(normal, state) || !['started', 'stopped'].includes(previousStatus) ||
      !(state === 'baseline' ? candidateStatus === null : ['started', 'stopped'].includes(candidateStatus))) reject();
  const [old, next] = normal[state];
  if (old === previousStatus && next === candidateStatus) return state;
  return state + '-' + (previousStatus === 'started' ? 'on' : 'off') + '-' +
    (candidateStatus === null ? 'none' : candidateStatus === 'started' ? 'on' : 'off');
}
