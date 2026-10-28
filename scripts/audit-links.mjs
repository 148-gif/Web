// Internal-link audit of the built site in dist/ (run after the build): node scripts/audit-links.mjs [--out report.md] [--json report.json] [--strict]
// --strict exits 1 on errors (broken links, orphans); warnings and suggestions never fail. Rules: .claude/skills/internal-links/SKILL.md
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { auditSite, formatReport } from './lib/linkaudit.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');

const files = {};
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.html')) files[relative('dist', p).split('\\').join('/')] = readFileSync(p, 'utf8'); } };
walk('dist');

const sm = existsSync('dist/sitemap.xml') ? readFileSync('dist/sitemap.xml', 'utf8') : '';
const sitemap = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''));

const res = auditSite(files, { base: BASE, sitemap });
const report = formatReport(res, { date: new Date().toISOString().slice(0, 10) });
if (opt('--out')) writeFileSync(opt('--out'), report + '\n');
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(res, null, 1));
console.log(report.split('\n').slice(0, 40).join('\n'));
if (args.includes('--strict') && res.stats.errors) process.exit(1);
