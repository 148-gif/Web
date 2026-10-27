// Static site generator: data/*.json -> dist/
// Shared code lives in scripts/lib/ (core, layout, parts); each file in scripts/lib/sections/ builds one part of the site.
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { shut, letters, halacha, font } from './lib/core.mjs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync(new URL('../site/', import.meta.url), 'dist', { recursive: true });
writeFileSync('dist/style.css', readFileSync('dist/style.css', 'utf8').replace(/url\(fonts\/([\w.-]+\.woff2)\)/g, (m, f) => `url(${font(f)})`));

// Sections write their pages when imported, so they are loaded only after dist/ is reset.
const { pages } = await import('./lib/sections/qa.mjs');
await import('./lib/sections/yeshiva.mjs');
await import('./lib/sections/yavniel.mjs');
await import('./lib/sections/moharash.mjs');
await import('./lib/sections/library.mjs');
await import('./lib/sections/rabbi-nachman.mjs');
await import('./lib/sections/print.mjs');
await import('./lib/sections/search.mjs');
await import('./lib/sections/home.mjs');
await import('./lib/sections/info.mjs');
await import('./lib/sections/meta.mjs');
console.log(`built ${shut.length} Q&A pages, ${letters.length} letters, ${halacha.length} halacha, ${pages} list pages`);
