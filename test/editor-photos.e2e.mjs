// Checks the editor's photo rules in a real browser: node test/editor-photos.e2e.mjs   (after: node scripts/build.mjs)
// Not part of `npm test`: it needs Playwright and a browser, which the repository does not depend on. It serves dist/ itself and
// stands in for GitHub (the editor's token mode), so nothing leaves the machine and nothing is really saved.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = new URL('..', import.meta.url).pathname, MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer((req, res) => {
  let f = join(ROOT, 'dist', decodeURIComponent(req.url.split('?')[0]));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/admin/`;

const puts = [];
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const browser = await chromium.launch(), ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('cms-token', JSON.stringify({ token: 't' })));
const p = await ctx.newPage(), errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.route('**/admin/config.json', (r) => r.fulfill({ json: { repo: '148-gif/Web', branch: 'x' } }));
let pending = null; // a photo shown as "not approved yet" in the chooser, for the test that needs one
await p.route('**/admin/photos/index.json', async (r) => { const j = JSON.parse(readFileSync(join(ROOT, 'dist/admin/photos/index.json'), 'utf8')); if (pending) j.find((x) => x.id === pending).rights = 'pending'; r.fulfill({ json: j }); });
await p.route('https://api.github.com/**', async (r) => {
  const m = /\/repos\/148-gif\/Web(?:\/contents\/(.*))?$/.exec(new URL(r.request().url()).pathname);
  if (!m) return r.fulfill({ status: 404, json: { message: 'nf' } });
  if (!m[1]) return r.fulfill({ json: { permissions: { push: true } } });
  const rel = decodeURIComponent(m[1]), f = join(ROOT, rel);
  if (r.request().method() === 'PUT') { puts.push({ path: rel, data: JSON.parse(Buffer.from(JSON.parse(r.request().postData()).content, 'base64').toString()) }); return r.fulfill({ json: { content: { sha: `new${puts.length}` }, commit: { sha: 'c' } } }); }
  if (existsSync(f) && statSync(f).isFile()) return r.fulfill({ json: { type: 'file', path: rel, sha: `sha-${rel}`, content: readFileSync(f).toString('base64') } });
  if (existsSync(f)) return r.fulfill({ json: readdirSync(f).map((n) => ({ type: 'file', name: n, path: `${rel}/${n}`, sha: 's' })) });
  return r.fulfill({ status: 404, json: { message: 'nf' } });
});
const toast = async () => (await p.locator('#msg').innerText()).trim();
const save = async () => { await p.locator('#savebtn').click(); await p.waitForTimeout(600); return toast(); };
const open = async (hash, wait) => { await p.goto(`${base}#/${hash}`); await p.reload(); await p.waitForSelector(wait, { timeout: 15000 }); await p.waitForTimeout(500); };

// ---- the photo library (data/images.json) ----
await open('file/images.json', 'details.item');
ok(await p.locator('.card > .lst > button.add').count() === 0 && await p.locator('details.item > summary .ib').count() === 0, 'the photo list cannot grow or shrink here');
const first = p.locator('details.item').first(); await first.locator('summary').click();
const alt = first.getByLabel('תיאור לקוראי מסך (alt)'), n0 = puts.length;
await alt.fill(''); let t = await save(); ok(/alt/.test(t) && puts.length === n0, `no description: blocked (${t})`);
await alt.fill('תמונה של הרב'); t = await save(); ok(/לא מתחיל/.test(t) && puts.length === n0, `"תמונה של…": blocked (${t})`);
await alt.fill('הרב בשטריימל, מחייך');
await first.getByLabel('אנשים נוספים בתמונה').selectOption('children'); t = await save(); ok(/consent/.test(t) && puts.length === n0, `children without a written approval: blocked (${t})`);
await first.getByLabel(/צלם או בעלים/).fill(''); await first.getByLabel(/מי אישר לפרסם/).fill('בעל האתר'); t = await save(); ok(/קרדיט/.test(t) && puts.length === n0, `no credit: blocked (${t})`);
await first.getByLabel(/צלם או בעלים/).fill('לא ידוע'); t = await save();
ok(puts.length === n0 + 1 && puts.at(-1).path === 'data/images.json' && puts.at(-1).data[0].consent === 'בעל האתר', 'a complete entry is saved');

// ---- photos in a page ----
await open('page/chy', '.insbtn');
const add = async (name) => { await p.locator('.insbtn').last().click(); await p.locator('.insmenu:not([hidden]) button', { hasText: name }).first().click(); await p.waitForTimeout(300); };
const pick = (n) => p.locator('dialog .mcard').nth(n).click();
let before = puts.length;
await add('תמונה'); t = await save(); ok(/בחרו תמונה/.test(t) && puts.length === before, `an image block with no photo: blocked (${t})`);
await p.getByRole('button', { name: 'בחירת תמונה' }).click(); await p.waitForSelector('dialog .mcard');
ok(await p.locator('dialog .mcard').count() === 26 && await p.locator('dialog .mcard:disabled').count() === 0, 'the chooser lists every photo; all are approved');
await pick(2); await p.waitForTimeout(300); t = await save();
const img = puts.at(-1).data.blocks?.find((b) => b.type === 'image');
ok(puts.length === before + 1 && img && Object.keys(img).sort().join() === 'id,size,type', `the saved image block has only the photo's id (${JSON.stringify(img)})`);
await add('תמונה'); await p.getByRole('button', { name: 'בחירת תמונה' }).click(); await p.waitForSelector('dialog .mcard'); await pick(2); await p.waitForTimeout(300);
t = await save(); ok(/יותר מפעם/.test(t) && puts.length === before + 1, `the same photo twice on a page: blocked (${t})`);
await add('גלריית תמונות'); await p.getByRole('button', { name: 'בחירת תמונות' }).click(); await p.waitForSelector('dialog .mcard');
for (let i = 5; i < 17; i++) await pick(i);
await pick(20); t = await toast(); ok(/עד 12/.test(t), `a 13th photo in a gallery: refused (${t})`);
await p.getByRole('button', { name: 'אישור' }).click();

// ---- a photo that is not approved cannot be placed ----
pending = 'shtreimel-smile';
await open('page/good-day', '.insbtn');
await add('תמונה'); await p.getByRole('button', { name: 'בחירת תמונה' }).click(); await p.waitForSelector('dialog .mcard');
ok(await p.locator('dialog .mcard:disabled').count() === 1, 'a photo that is not approved is shown but cannot be chosen');

ok(errs.length === 0, `no script errors ${JSON.stringify(errs)}`);
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
