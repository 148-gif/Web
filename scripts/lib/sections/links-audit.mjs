// The local content/link index of this build; it never calls a model or a remote crawler.
import { write, BASE, ORIGIN, linkAudit } from '../core.mjs';
import { layout } from '../layout.mjs';
import { readDist } from '../auditdist.mjs';
import { auditSite, pagePath } from '../linkaudit.mjs';
import { seo, assertSeoTargets, redirectRules } from '../seo-build.mjs';
import { cleanPath, seoFile, shardFor, escapeHtml } from '../../../site/admin/seo-model.mjs';
let built = readDist();
const existed = new Set(Object.keys(built.files).map(pagePath));
for (const [path, cfg] of Object.entries(seo.records)) if (cfg.redirectTo && !existed.has(path)) write(path.slice(1) + 'index.html', layout('העמוד הועבר', '<h1>העמוד הועבר</h1><p><a href="' + escapeHtml(cfg.redirectTo) + '">מעבר לכתובת החדשה</a></p>', { path, index: false }));
built = readDist();
assertSeoTargets(Object.keys(built.files).map(pagePath));
write('seo-redirects.conf', redirectRules(seo, BASE));
const res = auditSite(built.files, { base: BASE, sitemap: built.sitemap, config: linkAudit, seoChecks: true });
const info = res.findings.filter((f) => f.severity === 'info');
write('admin/links.json', JSON.stringify({ generated: new Date().toISOString(), sha: process.env.GITHUB_SHA || '', stats: res.stats, findings: [...res.findings.filter((f) => f.severity !== 'info'), ...info.slice(0, 150)], infoTotal: info.length, suggestions: res.suggestions.slice(0, 300) }));
const pages = res.seo.pages.filter((p) => cleanPath(p.path)), lookup = new Map(pages.map((p) => [p.path, p]));
const incoming = new Map(pages.map((p) => [p.path, []])), navCount = new Map();
for (const p of pages) for (const l of p.links) if (l.to !== p.path && lookup.has(l.to)) {
  if (l.region === 'content') incoming.get(l.to).push({ from: p.path, title: p.title, anchor: l.anchor, related: !!l.related });
  else navCount.set(l.to, (navCount.get(l.to) || 0) + 1);
}
const shards = Array.from({ length: 16 }, () => ({})), rows = [];
for (const p of pages) {
  const cfg = seo.records[p.path] || {}, problems = res.findings.filter((f) => f.path === p.path), saved = seo.rendered.get(p.path) || { applied: 0, stale: 0 };
  if (saved.stale && !problems.some((x) => x.code === 'stale-annotation')) problems.push({ severity: 'warn', code: 'stale-annotation', path: p.path, detail: saved.stale + ' קישורים שאושרו לא הוחלו כי קטע המקור השתנה או אינו חד-משמעי' });
  const inbound = incoming.get(p.path), out = p.links.filter((l) => l.region === 'content');
  const detail = { path: p.path, title: p.title, searchTitle: p.searchTitle, description: p.description, canonical: p.canonical, noindex: p.noindex, redirectTo: cfg.redirectTo || '', file: seoFile(p.path), incoming: inbound.slice(0, 200), incomingTotal: inbound.length, navigationIncoming: navCount.get(p.path) || 0, outgoing: out, suggestions: res.suggestions.filter((s) => s.from === p.path), related: res.seo.related[p.path] || [], paragraphs: p.paragraphs.slice(0, 60), findings: problems, annotations: saved };
  shards[shardFor(p.path)][p.path] = detail;
  rows.push({ path: p.path, title: p.title, description: p.description.slice(0, 200), noindex: p.noindex, redirectTo: cfg.redirectTo || '', incoming: inbound.length, outgoing: out.length, issues: problems.filter((f) => f.severity !== 'info').length, suggestions: detail.suggestions.length, shard: shardFor(p.path), configured: !!seo.records[p.path] });
}
for (let i = 0; i < shards.length; i++) write('admin/seo/' + i + '.json', JSON.stringify(shards[i]));
write('admin/seo/index.json', JSON.stringify({ version: 1, sha: process.env.GITHUB_SHA || '', generated: new Date().toISOString(), pages: rows, stats: res.stats, suggestions: res.suggestions, settings: seo.settings, configured: Object.keys(seo.records), provider: 'local-lexical', extensions: { recommendationProvider: 'optional' } }));
write('admin/seo/environment.json', JSON.stringify({ staging: false, origin: ORIGIN, sha: process.env.GITHUB_SHA || '' }));
