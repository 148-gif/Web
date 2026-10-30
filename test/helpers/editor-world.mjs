// The editor in a real browser, talking to the real editor server code (cms-worker/worker.mjs) over a fake GitHub and a fake D1:
// everything the editor does is real except the outside world, so nothing leaves the machine and nothing is really saved.
// Needs Playwright (not a dependency of the repository) and a built dist/. Used by the test/*.e2e.mjs scripts.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { handle, makeSession, sha256 } from '../../cms-worker/worker.mjs';
import { makeD1 } from './d1.mjs';
import { makeGithub } from './fake-github.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg' };
const walk = (d, out = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };

// The repository's own data (not the 25MB Q&A archive) is what the fake GitHub starts with.
export const repoFiles = () => Object.fromEntries(walk(join(ROOT, 'data')).filter((p) => !/shut\.json$|\/books\//.test(p)).map((p) => [relative(ROOT, p), readFileSync(p)]));

export async function startWorld({ files = repoFiles(), extra = {} } = {}) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const server = createServer((req, res) => {
    let f = join(ROOT, 'dist', decodeURIComponent(req.url.split('?')[0]));
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, r));
  const origin = `http://localhost:${server.address().port}`, WORKER = 'https://cms-test.workers.dev';
  const kv = (init) => { const m = new Map(Object.entries(init)); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
  const github = await makeGithub({ repo: 'o/r', branch: 'live', files });
  const env = { GOOGLE_CLIENT_ID: 'cid', OWNERS: await sha256('owner@gmail.com'), ALLOWED_ORIGIN: origin, REPO: 'o/r', BRANCH: 'live', GITHUB_TOKEN: 'ghp', DB: makeD1(), ...extra,
    EDITORS: kv({ people: JSON.stringify([{ email: 'editor@gmail.com', name: 'עורך', publisher: false }, { email: 'pub@gmail.com', name: 'מפרסם', publisher: true }]), 'owner-names': JSON.stringify({ [await sha256('owner@gmail.com')]: 'בעל האתר' }) }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opt = {}) => (await github.fetch(u, opt)) || realFetch(u, opt);
  const browser = await chromium.launch();
  const tokens = { owner: await makeSession('owner@gmail.com', env), editor: await makeSession('editor@gmail.com', env), publisher: await makeSession('pub@gmail.com', env) };
  const emails = { owner: 'owner@gmail.com', editor: 'editor@gmail.com', publisher: 'pub@gmail.com' };

  // A browser tab signed in as one of the three people. Calls to the editor server run the real server code in this process.
  async function open(who = 'owner', { width = 1280, height = 900, dark = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', acceptDownloads: true });
    await ctx.addInitScript(([t, e, o]) => { localStorage.setItem('cms-token', JSON.stringify({ token: t, email: e, owner: o })); }, [tokens[who], emails[who], who === 'owner']);
    const page = await ctx.newPage(), problems = [];
    if (process.env.DEBUG_WORLD) { page.on('response', (r) => console.log('  <-', r.status(), r.url().slice(0, 120))); page.on('requestfailed', (r) => console.log('  xx', r.url().slice(0, 120), r.failure()?.errorText)); page.on('console', (m) => console.log('  console', m.type(), m.text().slice(0, 200))); }
    page.on('pageerror', (e) => problems.push(`script error: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.route('**/admin/config.json', (r) => r.fulfill({ json: { repo: 'o/r', branch: 'live', worker: WORKER, googleClientId: 'x' } }));
    await page.route(`${WORKER}/**`, async (r) => {
      const q = r.request(), cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE' };
      if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      const body = q.postDataBuffer();
      const res = await handle(new Request(q.url(), { method: q.method(), headers: { ...q.headers(), origin }, body: body && q.method() !== 'GET' ? body : undefined }), env);
      r.fulfill({ status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors }, body: Buffer.from(await res.arrayBuffer()) });
    });
    await page.goto(`${origin}/admin/`);
    await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
    return { page, problems, go: async (hash, sel) => { await page.goto(`${origin}/admin/${hash}`); await page.reload(); if (sel) await page.waitForSelector(sel, { timeout: 15000 }); await page.waitForTimeout(400); } };
  }
  return { open, env, github, origin, tokens, close: async () => { await browser.close(); server.close(); globalThis.fetch = realFetch; } };
}

// A tiny PASS/FAIL reporter for the e2e scripts.
export const reporter = () => { let failed = 0; return { ok: (c, m) => { if (!c) failed++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); }, done: () => failed }; };
