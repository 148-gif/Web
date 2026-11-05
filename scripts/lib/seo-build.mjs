// Original build-time SEO pipeline; editorial records use the existing draft/publish flow.
import { readdirSync, readFileSync } from 'node:fs';
import { validateSeo, validateSeoSettings, resolveRedirect, escapeHtml, annotateHtml, paragraphsOf, textOf } from '../../site/admin/seo-model.mjs';
const root = new URL('../../data/', import.meta.url);
export function loadSeo() {
  const records = {};
  for (const name of readdirSync(root).filter((n) => /^seo-[A-Za-z0-9_-]+\.json$/.test(n) && n !== 'seo-settings.json')) {
    const r = validateSeo(JSON.parse(readFileSync(new URL(name, root), 'utf8')), 'data/' + name);
    if (records[r.path]) throw new Error('SEO: הגדרות כפולות לעמוד ' + r.path);
    records[r.path] = r;
  }
  let settings = { version: 1, indexing: 'index', rules: [] };
  try { settings = validateSeoSettings(JSON.parse(readFileSync(new URL('seo-settings.json', root), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const path of Object.keys(records)) resolveRedirect(path, records);
  return { records, settings, rendered: new Map() };
}
export const seo = loadSeo();
function meta(html, name, content, property = false) {
  const attr = property ? 'property' : 'name', tag = '<meta ' + attr + '="' + name + '" content="' + escapeHtml(content) + '">';
  const rx = new RegExp('<meta\\b[^>]*\\b' + attr + '="' + name.replace(/\./g, '\\.') + '"[^>]*>', 'gi');
  return rx.test(html) ? html.replace(rx, tag) : html.replace(/<\/head>/i, tag + '</head>');
}
export function transformSeo(html, path, state = seo, origin = process.env.SITE_ORIGIN || '', base = (process.env.SITE_BASE || '').replace(/\/$/, '')) {
  const cfg = state.records[path] || {}, absolute = (p) => origin.replace(/\/$/, '') + base + p;
  if (cfg.title) { html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + escapeHtml(cfg.title) + '</title>'); html = meta(html, 'og:title', cfg.title, true); }
  if (cfg.description) { html = meta(html, 'description', cfg.description); html = meta(html, 'og:description', cfg.description, true); }
  if (cfg.image) html = meta(html, 'og:image', absolute(cfg.image), true);
  if (state.settings.indexing === 'noindex' || cfg.indexing === 'noindex' || cfg.redirectTo) html = meta(html, 'robots', 'noindex,follow');
  // Index preferences cannot override page-type exclusions or hosting's staging noindex guard.
  const target = cfg.redirectTo ? resolveRedirect(path, state.records) : cfg.canonical;
  if (target && origin) {
    const tag = '<link rel="canonical" href="' + escapeHtml(absolute(target)) + '">';
    html = /<link\b[^>]*rel="canonical"[^>]*>/i.test(html) ? html.replace(/<link\b[^>]*rel="canonical"[^>]*>/gi, tag) : html.replace(/<\/head>/i, tag + '</head>');
    html = meta(html, 'og:url', absolute(target), true);
  }
  const links = [...(cfg.links || [])];
  const rules = (state.settings.rules || []).filter((r) => r.enabled && r.to !== path && (!r.include?.length || r.include.some((p) => path.startsWith(p))) && !(r.exclude || []).some((p) => path.startsWith(p))).slice(0, 5);
  for (const r of rules) {
    const quote = paragraphsOf(html).find((p) => p.includes(r.anchor) && (!r.requireAny?.length || r.requireAny.some((s) => p.includes(s))));
    if (quote && !links.some((l) => l.to === r.to)) links.push({ quote, anchor: r.anchor, to: r.to });
  }
  const applied = annotateHtml(html, links); html = applied.html;
  state.rendered.set(path, { applied: applied.applied.length, stale: applied.stale.length });
  const existing = /<aside\b[^>]*class="related"[\s\S]*?<\/aside>/i.exec(html);
  const auto = cfg.relatedAuto === false ? [] : [...(existing?.[0] || '').matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ path: m[1], title: textOf(m[2]) }));
  if (cfg.related?.length || cfg.relatedAuto === false) {
    const seen = new Set(), chosen = [...(cfg.related || []), ...auto].filter((x) => !seen.has(x.path) && seen.add(x.path)).slice(0, 8);
    const block = chosen.length ? '<aside class="related" aria-labelledby="seo-related"><h2 id="seo-related">תוכן קשור</h2><ul>' + chosen.map((x) => '<li><a href="' + escapeHtml(x.path) + '">' + escapeHtml(x.title) + '</a></li>').join('') + '</ul></aside>' : '';
    html = existing ? html.replace(existing[0], block) : html.replace(/<\/main>/i, block + '</main>');
  }
  return html;
}
export function filterSeoSitemap(xml, state = seo, base = (process.env.SITE_BASE || '').replace(/\/$/, '')) {
  const seen = new Set();
  return xml.replace(/<url>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g, (entry, loc) => {
    const path = new URL(loc.replace(/&amp;/g, '&'), 'https://site.invalid').pathname.slice(base.length) || '/', cfg = state.records[path] || {};
    if (seen.has(loc) || state.settings.indexing === 'noindex' || cfg.indexing === 'noindex' || cfg.redirectTo || (cfg.canonical && cfg.canonical !== path)) return '';
    seen.add(loc); return entry;
  });
}
export function redirectRules(state = seo, base = '') {
  const lines = [];
  for (const [path, cfg] of Object.entries(state.records)) if (cfg.redirectTo) {
    const source = (base + path).replace(/^\//, '').replace(/\/$/, '');
    lines.push('RewriteRule ^' + source + '/?$ ' + base + resolveRedirect(path, state.records) + ' [R=301,L,NE]');
  }
  return lines.length ? '# BEGIN HEICHAL SEO REDIRECTS\nRewriteEngine On\n' + lines.join('\n') + '\n# END HEICHAL SEO REDIRECTS\n' : '';
}
export function assertSeoTargets(paths, state = seo) {
  const known = new Set(paths);
  for (const [path, cfg] of Object.entries(state.records)) {
    if (!known.has(path) && !cfg.redirectTo) throw new Error('SEO: העמוד אינו קיים: ' + path);
    const targets = [cfg.canonical, cfg.redirectTo && resolveRedirect(path, state.records), ...(cfg.links || []).map((x) => x.to), ...(cfg.related || []).map((x) => x.path)].filter(Boolean);
    for (const to of targets) if (!known.has(to)) throw new Error('SEO: יעד אינו קיים: ' + to);
  }
  for (const r of state.settings.rules || []) if (r.enabled && !known.has(r.to)) throw new Error('SEO: יעד הכלל אינו קיים: ' + r.to);
}
