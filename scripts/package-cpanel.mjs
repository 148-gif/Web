// Build a private, immutable release artifact. This command never uploads files,
// contacts a hosting panel, updates Git refs or changes a database.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, mkdir, mkdtemp, rm, readdir, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../', import.meta.url));
const inside = (a, b) => a === b || a.startsWith(b + sep);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forbidden = (path) => path.split('/').some((part) => part === '.git' || part === 'node_modules' || part === '.env' || part.startsWith('.env.') || part.endsWith('.pem') || part.endsWith('.key'));
const safePath = (path) => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..') && !/[\p{Cc}]/u.test(path);
const checkedOrigin = (value, name) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} requires an explicit HTTPS origin`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} requires an HTTPS origin without credentials, path, query or fragment`);
  return url.origin;
};
const checkedBase = (value) => {
  if (value === '' || value === '/') return '';
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value)) throw new Error('siteBase must be empty or a canonical URL path without a trailing slash');
  return value;
};

async function treeFiles(root) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = prefix + entry.name;
      if (!safePath(path) || forbidden(path)) throw new Error('Artifact input contains a prohibited path');
      if (entry.isSymbolicLink()) throw new Error('Artifact input must not contain symbolic links');
      if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/');
      else if (entry.isFile()) files.push(path);
      else throw new Error('Artifact input must contain only regular files');
    }
  }
  await visit(root);
  return files;
}

async function copyFiles(source, target, files) {
  for (const path of files) {
    if (!safePath(path) || forbidden(path) || !(await lstat(join(source, path))).isFile()) throw new Error('Invalid artifact file');
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readFile(join(source, path)), { flag: 'wx', mode: 0o600 });
  }
}

const headerRules = (staging) => [
  '# Generated release settings. Verify mod_headers on the actual host before activation.',
  'Options -Indexes',
  '<IfModule mod_headers.c>',
  '  Header always set X-Content-Type-Options "nosniff"',
  ...(staging ? ['  Header always set X-Robots-Tag "noindex, nofollow"'] : []),
  '</IfModule>',
  '',
].join('\n');

export async function packageCpanel({ sourceRoot = REPO, commit, branch, output, siteOrigin, apiOrigin, siteBase = '', staging = true, publicRoot, apacheBaseline } = {}) {
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('An exact40-character source commit is required');
  if (typeof branch !== 'string' || !branch || !output) throw new Error('Explicit source branch and new private output directory are required');
  if (typeof staging !== 'boolean') throw new Error('staging must be boolean');
  if (typeof apacheBaseline !== 'string' || !apacheBaseline) throw new Error('An explicit saved Apache .htaccess baseline is required, including an explicitly saved empty file for a new root');
  const baselineInfo = await lstat(apacheBaseline);
  if (!baselineInfo.isFile() || baselineInfo.size > 1024 * 1024) throw new Error('Apache baseline must be a bounded regular file');
  const baselineBytes = await readFile(apacheBaseline);
  if (baselineBytes.length > 1024 * 1024) throw new Error('Apache baseline exceeds its size budget');
  let baseline;
  try { baseline = new TextDecoder('utf-8', { fatal: true }).decode(baselineBytes); } catch { throw new Error('Apache baseline must contain valid UTF-8'); }
  siteOrigin = checkedOrigin(siteOrigin, 'siteOrigin'); siteBase = checkedBase(siteBase);
  let api;
  try { api = new URL(apiOrigin); } catch { throw new Error('apiOrigin requires an explicit HTTPS API URL'); }
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw new Error('apiOrigin requires an HTTPS API URL without credentials, query or fragment');
  const apiBasePath = checkedBase(api.pathname);
  apiOrigin = api.origin;
  const apiUrl = apiOrigin + apiBasePath;
  if (siteOrigin === apiOrigin && (!apiBasePath || apiBasePath === siteBase)) throw new Error('A same-origin API requires its own nonempty base path');
  sourceRoot = await realpath(resolve(sourceRoot));
  const git = async (args) => (await run('git', args, { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout;
  await git(['check-ref-format', `refs/heads/${branch}`]);
  if ((await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim() !== commit) throw new Error('Source commit must match the selected local branch head; recheck remote heads separately');
  if ((await git(['status', '--porcelain', '--untracked-files=all'])).trim()) throw new Error('Source checkout must be clean before packaging');
  const entries = (await git(['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean).map((line) => {
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' || !safePath(match[4])) throw new Error('Source tree must contain only regular files and safe relative paths');
    return match[4];
  });
  const destination = resolve(output), parent = await realpath(dirname(destination));
  const canonical = resolve(parent, basename(destination));
  if (inside(canonical, sourceRoot) || (publicRoot && inside(canonical, await realpath(resolve(publicRoot))))) throw new Error('Release artifacts must remain outside the repository and public document root');
  try { await lstat(canonical); throw new Error('Release output must be a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(join(tmpdir(), 'heichal-cpanel-build-'));
  try {
    const archive = join(temporary, 'source.tar'), snapshot = join(temporary, 'source');
    await mkdir(snapshot, { mode: 0o700 });
    await git(['archive', '--format=tar', `--output=${archive}`, commit]);
    await run('tar', ['-xf', archive, '-C', snapshot, '--no-same-owner', '--no-same-permissions']);
    const buildEnv = {
      PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8',
      SITE_ORIGIN: siteOrigin, SITE_BASE: siteBase, GITHUB_SHA: commit,
    };
    for (const script of ['scripts/build.mjs', 'scripts/check-links.mjs', 'scripts/audit-links.mjs']) {
      if (!entries.includes(script)) throw new Error('Source commit lacks the required release validation scripts');
      try { await run(process.execPath, [script, ...(script.endsWith('/audit-links.mjs') ? ['--strict'] : [])], { cwd: snapshot, env: buildEnv, maxBuffer: 16 * 1024 * 1024 }); }
      catch { throw new Error(`Release build/validation failed at ${script}; no deploy was attempted`); }
    }
    const dist = join(snapshot, 'dist');
    const configFile = join(dist, 'admin/config.json'), adminFile = join(dist, 'admin/index.html');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    if (typeof config.repo !== 'string' || typeof config.googleClientId !== 'string' || !config.googleClientId) throw new Error('Built admin configuration is incomplete');
    // Only this isolated build changes; the checked-out public source retains its
    // current Pages configuration and indexing policy.
    config.branch = branch; config.worker = apiUrl;
    config.deployment = { target: 'cpanel', workflow: 'cpanel-release.yml', statusPath: 'deployment.json' };
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
    let admin = await readFile(adminFile, 'utf8');
    let policies = 0;
    admin = admin.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/g, (_match, before, policy, after) => {
      policies++;
      const directives = policy.split(';').map((part) => part.trim()).filter(Boolean);
      for (const name of ['connect-src', 'img-src', 'media-src']) {
        const i = directives.findIndex((part) => part.startsWith(name + ' '));
        if (i < 0) throw new Error('Built admin CSP lacks a required directive');
        directives[i] += ` ${apiOrigin}`;
      }
      return before + directives.join('; ') + after;
    });
    if (policies !== 1) throw new Error('Built admin must have exactly one recognized CSP');
    await writeFile(adminFile, admin);
    const marker = JSON.parse(await readFile(join(dist, 'admin/build.json'), 'utf8'));
    if (marker.sha !== commit) throw new Error('Built commit marker does not match release source');
    let publicFiles = await treeFiles(dist);
    if (staging) {
      for (const path of publicFiles.filter((file) => file.endsWith('.html'))) {
        let html = await readFile(join(dist, path), 'utf8');
        html = html.replace(/<meta\b[^>]*\bname=["'](?:robots|googlebot|bingbot)["'][^>]*>/gi, '');
        if (!/<\/head>/i.test(html)) throw new Error('Staging HTML is missing a head element');
        html = html.replace(/<\/head>/i, '<meta name="robots" content="noindex,nofollow"></head>');
        await writeFile(join(dist, path), html);
      }
      // Crawlers must be allowed to fetch the noindex response; Disallow would
      // prevent them from reading both the header and the HTML fallback.
      await writeFile(join(dist, 'robots.txt'), 'User-agent: *\nAllow: /\n');
    }
    await writeFile(join(dist, '.htaccess'), baseline + (baseline.endsWith('\n') ? '' : '\n') + '\n' + headerRules(staging));
    publicFiles = await treeFiles(dist);
    const runtimeFiles = entries.filter((path) => /^server\/[^/]+\.(?:mjs|sql)$/.test(path) || /^cms-worker\/[^/]+\.mjs$/.test(path) || [
      'site/admin/image-rules.mjs', 'package.json', 'package-lock.json', 'passenger.cjs',
      'scripts/check-cpanel-readiness.mjs', 'scripts/prepare-mysql-migration.mjs', 'scripts/import-mysql-migration.mjs', 'scripts/smoke-cpanel.mjs', 'scripts/publish-cpanel.mjs',
      'scripts/setup-local-auth.mjs', 'scripts/arm-local-auth.mjs', 'scripts/setup-google-auth.mjs',
    ].includes(path));
    for (const required of ['server/start.mjs', 'server/runtime.mjs', 'server/mysql-store.mjs', 'server/mysql-kv.mjs', 'server/mysql-rate-limit.mjs', 'package.json', 'package-lock.json', 'passenger.cjs']) if (!runtimeFiles.includes(required)) throw new Error('Source commit lacks a required Node runtime file');
    if (runtimeFiles.some(forbidden)) throw new Error('Runtime selection contains a prohibited path');
    await mkdir(canonical, { mode: 0o700 });
    await copyFiles(dist, join(canonical, 'public'), publicFiles);
    await copyFiles(snapshot, join(canonical, 'app'), runtimeFiles);
    const manifest = {
      format: 'heichal-cpanel-release', version: 1, commit, branch, siteOrigin, siteBase, apiOrigin, apiBasePath, apiUrl, staging,
      databaseIncluded: false, secretsIncluded: false, deploymentPerformed: false, deploymentReady: false,
      validation: { immutableSource: true, cleanCheckout: true, build: true, internalLinks: true, strictLinkAudit: true, servedCommit: true },
      runtime: { entrypoint: 'server/start.mjs', passengerEntrypoint: 'passenger.cjs', node: '24', mysql: '8.4+', publicationEnabledByDefault: false, stagingNoindexByDefault: true },
      apacheBaselineSha256: digest(baselineBytes),
      preserveHostPaths: ['.well-known', 'cgi-bin', 'php.ini', '.user.ini'],
      outstanding: ['Install pinned production dependencies in the private app directory', 'Import and verify the separate database/media backup before activation', 'Verify hosting routing, TLS, proxy identity, Google origins and all-file noindex headers', 'Configure and verify the gated cPanel build workflow and private Cron runner; CMS_PUBLISH_ENABLED alone does not activate them'],
      files: [],
    };
    for (const path of await treeFiles(canonical)) {
      const bytes = await readFile(join(canonical, path));
      manifest.files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
    // The manifest is the completion marker. Failed preparations have no marker
    // and must never be activated as a release.
    await writeFile(join(canonical, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(canonical, 0o700);
    return { output: canonical, commit, files: manifest.files.length, staging, deploymentPerformed: false, deploymentReady: false, manifestSha256: digest(await readFile(join(canonical, 'manifest.json'))) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function cli(args) {
  const options = {};
  const names = { '--commit': 'commit', '--source-branch': 'branch', '--out': 'output', '--site-origin': 'siteOrigin', '--api-origin': 'apiOrigin', '--api-url': 'apiOrigin', '--site-base': 'siteBase', '--public-root': 'publicRoot', '--apache-baseline': 'apacheBaseline' };
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (!key || options[key] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/package-cpanel.mjs --commit SHA --source-branch BRANCH --out /private/new-release --site-origin https://site --api-url https://site/cms-api --apache-baseline /private/htaccess.original [--site-base /path] [--public-root /public/root]');
    options[key] = args[++i];
  }
  console.log(JSON.stringify(await packageCpanel(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
