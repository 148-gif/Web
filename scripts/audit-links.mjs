// Internal-link audit of the built site in dist/ (run after the build): node scripts/audit-links.mjs [--out report.md] [--json report.json] [--strict]
// --config file (default data/link-audit.json: ignore, ignorePairs, aliases) and --previous report.json (marks what is new) are optional.
// --strict exits 1 on errors (broken links, orphans); warnings and suggestions never fail. Rules: .claude/skills/internal-links/SKILL.md
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { auditSite, formatReport, reportKeys, needsAttention, validateAuditConfig } from './lib/linkaudit.mjs';
import { readDist } from './lib/auditdist.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');

const { files, sitemap } = readDist();

const cfgFile = opt('--config') || 'data/link-audit.json';
const config = existsSync(cfgFile) ? validateAuditConfig(JSON.parse(readFileSync(cfgFile, 'utf8'))) : {};
const prevFile = opt('--previous');
const previous = prevFile && existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')).keys : null;

const res = auditSite(files, { base: BASE, sitemap, config });
const keys = reportKeys(res);
const fresh = previous ? keys.filter((k) => !new Set(previous).has(k)).length : keys.length;
const report = formatReport(res, { date: new Date().toISOString().slice(0, 10), previous });
// The keys ride along in the report as a comment, so the next run can read them back from the issue.
if (opt('--out')) writeFileSync(opt('--out'), `${report}\n<!-- audit-keys:${Buffer.from(JSON.stringify(keys.slice(0, 400))).toString('base64')} -->\n`);
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ ...res, keys, fresh, attention: needsAttention(res) }, null, 1));
console.log(report.split('\n').slice(0, 40).join('\n'));
if (args.includes('--strict') && res.stats.errors) process.exit(1);
