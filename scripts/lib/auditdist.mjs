// Reads the built site for the link audit: every page of dist/ and the paths in its sitemap.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export function readDist(dir = 'dist') {
  const files = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.html')) files[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'utf8'); } };
  walk(dir);
  const sm = existsSync(join(dir, 'sitemap.xml')) ? readFileSync(join(dir, 'sitemap.xml'), 'utf8') : '';
  const sitemap = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''));
  return { files, sitemap };
}
