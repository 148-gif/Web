// Checks the built site in dist/: every internal link and image points to a file that exists,
// every in-page anchor (#id) has a matching id on its page, and no element has an inline style attribute. Run after the build: node scripts/check-links.mjs
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');
const pages = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.html')) pages.push(p); } };
walk('dist');

const errors = [];
let links = 0;
// Every path in a srcset (and every <img> with a srcset) must exist, and an <img> needs its size so the page does not jump while it loads.
const fileOf = (raw) => {
  let path = decodeURIComponent(raw.split(/[?#]/)[0]);
  if (BASE && path.startsWith(BASE + '/')) path = path.slice(BASE.length);
  return `dist${path}${path.endsWith('/') ? 'index.html' : ''}`;
};
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  // The CSP has no 'unsafe-inline' for styles, so a style attribute would be silently ignored by browsers.
  if (/<[a-z][^>]*\sstyle="/i.test(html)) errors.push(`${page}: inline style attribute (blocked by the CSP; use a class)`);
  for (const [tag] of html.matchAll(/<img\s[^>]*>/g)) {
    if (!/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag)) errors.push(`${page}: <img> without width and height: ${tag.slice(0, 80)}`);
    if (!/\salt="/.test(tag)) errors.push(`${page}: <img> without alt: ${tag.slice(0, 80)}`);
  }
  for (const [, set] of html.matchAll(/\ssrcset="([^"]*)"/g)) for (const part of set.split(',')) {
    const raw = part.trim().split(/\s+/)[0];
    if (!raw.startsWith('/')) continue;
    links++;
    if (!existsSync(fileOf(raw))) errors.push(`${page}: broken srcset image ${raw}`);
  }
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, , raw] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    if (raw.startsWith('#')) {
      links++;
      if (raw.length > 1 && !ids.has(decodeURIComponent(raw.slice(1)))) errors.push(`${page}: no element with id "${raw.slice(1)}"`);
      continue;
    }
    if (!raw.startsWith('/') || raw.startsWith('//')) continue; // external, tel:, mailto:, data:
    links++;
    let path = decodeURIComponent(raw.split(/[?#]/)[0]);
    if (BASE && path.startsWith(BASE + '/')) path = path.slice(BASE.length);
    const file = `dist${path}${path.endsWith('/') ? 'index.html' : ''}`;
    if (!existsSync(file)) errors.push(`${page}: broken link ${raw}`);
  }
}
const shown = errors.slice(0, 50);
console.log(`checked ${links} links on ${pages.length} pages: ${errors.length} problems`);
if (errors.length) { console.error(shown.join('\n') + (errors.length > shown.length ? `\n…and ${errors.length - shown.length} more` : '')); process.exit(1); }
