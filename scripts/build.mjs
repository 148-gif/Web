// Static site generator: data/*.json -> dist/
// Shared code lives in scripts/lib/ (core, layout, parts); each file in scripts/lib/sections/ builds one part of the site.
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { shut, letters, halacha, font } from './lib/core.mjs';

const SITE_DIR = new URL('../site/', import.meta.url), CSS_DIR = new URL('css/', SITE_DIR);
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync(SITE_DIR, 'dist', { recursive: true, filter: (f) => !f.startsWith(CSS_DIR.pathname.replace(/\/$/, '')) });
// Styles: site/css/ holds the stylesheet in parts, joined in file-name order into one dist/style.css.
// Order matters (later rules win), so the parts are numbered. Font URLs get their content hash (see core.mjs).
const css = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).sort().map((f) => readFileSync(new URL(f, CSS_DIR), 'utf8')).join('\n');
writeFileSync('dist/style.css', css.replace(/url\(fonts\/([\w.-]+\.woff2)\)/g, (m, f) => `url(${font(f)})`));

// Sections write their pages when imported, so they are loaded only after dist/ is reset.
const { pages } = await import('./lib/sections/qa.mjs');
await import('./lib/sections/yeshiva.mjs');
await import('./lib/sections/yavniel.mjs');
await import('./lib/sections/moharash.mjs');
await import('./lib/sections/library.mjs');
await import('./lib/sections/rabbi-nachman.mjs');
await import('./lib/sections/print.mjs');
await import('./lib/sections/pages.mjs');
await import('./lib/sections/admin.mjs');
await import('./lib/sections/search.mjs');
await import('./lib/sections/home.mjs');
await import('./lib/sections/info.mjs');
await import('./lib/sections/offline.mjs');
await import('./lib/sections/meta.mjs');
await import('./lib/sections/links-audit.mjs'); // last: it reads the finished dist/
console.log(`built ${shut.length} Q&A pages, ${letters.length} letters, ${halacha.length} halacha, ${pages} list pages`);
