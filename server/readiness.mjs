// Read-only local prerequisites. These do not connect to the database and cannot
// establish that the host's imported data, proxy and publication are ready.
import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { runtimeConfiguration } from './runtime.mjs';

const require = createRequire(import.meta.url);
const origin = (value) => {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; }
  catch { return false; }
};
const isInside = (a, b) => a === b || a.startsWith(b + sep);

export async function inspectReadiness({ values = process.env, nodeVersion = process.versions.node, resolveDriver = () => require.resolve('mysql2/promise') } = {}) {
  const checks = [], add = (name, status, detail) => checks.push({ name, status, detail });
  add('node', Number(nodeVersion.split('.')[0]) >= 24 ? 'pass' : 'blocked', `Observed Node ${nodeVersion}; this preparation is tested on Node24 or newer`);
  try { resolveDriver(); add('mysql_driver', 'pass', 'mysql2/promise resolves; no connection was opened'); }
  catch { add('mysql_driver', 'blocked', 'mysql2/promise is not installed; no package installation was attempted'); }
  for (const name of ['CMS_PUBLIC_ORIGIN', 'ALLOWED_ORIGIN']) add(name, origin(values[name]) ? 'pass' : 'blocked', 'Requires an explicit HTTP(S) origin without a path or embedded credentials');
  for (const name of ['REPO', 'BRANCH', 'OWNERS', ...(values.CMS_GOOGLE_AUTH_ENABLED === 'false' ? [] : ['GOOGLE_CLIENT_ID']), 'GITHUB_TOKEN', 'SESSION_SECRET', 'MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
    add(name, typeof values[name] === 'string' && values[name].trim() ? 'configured' : 'blocked', 'Presence only; the value and its validity are not disclosed or verified');
  }
  const port = values.MYSQL_PORT === undefined ? 3306 : Number(values.MYSQL_PORT);
  add('MYSQL_PORT', Number.isSafeInteger(port) && port > 0 && port <= 65535 ? 'pass' : 'blocked', 'Must be a valid TCP port; defaults to3306');
  try {
    runtimeConfiguration(values, nodeVersion);
    add('runtime_configuration', 'pass', 'Startup value formats are valid; credentials and connection access were not tested');
  } catch { add('runtime_configuration', 'blocked', 'One or more runtime settings are missing or invalid; check owner hashes, secret length, HTTPS origins and verified database TLS configuration'); }
  const paths = {};
  for (const name of ['CMS_APP_ROOT', 'CMS_MEDIA_ROOT', 'CMS_PUBLIC_ROOT']) {
    if (typeof values[name] !== 'string' || !isAbsolute(values[name])) { add(name, 'blocked', 'Requires an existing absolute directory'); continue; }
    try {
      const canonical = await realpath(values[name]);
      if (!(await stat(canonical)).isDirectory()) throw new Error('Not a directory');
      paths[name] = canonical; add(name, 'observed', 'Canonical directory resolved without reading its files');
    }
    catch { add(name, 'blocked', 'Directory is unavailable; nothing was created'); }
  }
  if (paths.CMS_MEDIA_ROOT && paths.CMS_PUBLIC_ROOT) {
    const separated = !isInside(resolve(paths.CMS_MEDIA_ROOT), resolve(paths.CMS_PUBLIC_ROOT)) && !isInside(resolve(paths.CMS_PUBLIC_ROOT), resolve(paths.CMS_MEDIA_ROOT));
    add('private_media_location', separated ? 'pass' : 'blocked', 'Media storage and public documents must be separate directory trees');
  }
  if (paths.CMS_APP_ROOT && paths.CMS_PUBLIC_ROOT) {
    const separated = !isInside(paths.CMS_APP_ROOT, paths.CMS_PUBLIC_ROOT) && !isInside(paths.CMS_PUBLIC_ROOT, paths.CMS_APP_ROOT);
    add('private_app_location', separated ? 'pass' : 'blocked', 'Application code and public documents must be separate directory trees');
  }
  return {
    format: 'heichal-cms-node-readiness', version: 1, deploymentReady: false,
    databaseConnected: false, filesCreated: false, checks,
    outstanding: [
      'Run startup schema verification against the imported target; preflight does not connect to MySQL',
      'Rehearse the actual snapshot/media import and backup/restore in an isolated target',
      'Verify cPanel startup routing, trusted proxy identity, upload timeouts and Google/GitHub connectivity',
      'Set the admin API origin, exact CSP hosts and Google origin configuration together; preserve existing media URLs',
      'Verify X-Robots-Tag on static files, PDF/media, redirects and API errors for the public staging host',
      'Configure recurring master publication to cPanel before explicitly enabling CMS_PUBLISH_ENABLED',
    ],
  };
}
