// Internal-link audit of the built site (see .claude/skills/internal-links/SKILL.md).
// Pure functions over { path -> html }, so they are testable without a build; scripts/audit-links.mjs reads dist/ and prints the report.

export const MAX_DEPTH = 3;
// One click more is fine for the items of a paginated list (home > list > numbered page > item).
export const isListItem = (path) => /^\/(shut|letters|halacha)\/\d+\/$/.test(path);
// Pages that only exist because a list is cut into parts (items and numbered list pages): no suggestions or link-score findings for them.
export const isMinor = (path) => isListItem(path) || /\/page\/\d+\/$/.test(path);
export const MAX_LINKS = 100;
// Anchors that say nothing about the target (Google's "link best practices"); compared after trimming punctuation.
export const GENERIC = new Set(['כאן', 'לחצו כאן', 'לחץ כאן', 'קראו עוד', 'קרא עוד', 'עוד', 'המשך', 'להמשך', 'לכאן', 'לחצו', 'קישור', 'אתר', 'מאמר', 'עמוד', 'לעמוד', 'click here', 'here', 'read more', 'more', 'link']);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const textOf = (html) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i')); return m ? decode(m[1] ?? m[2]) : null; };

// "/a/b/index.html" -> "/a/b/"; null when the file is not a page.
export function pagePath(file) {
  if (!file.endsWith('.html')) return null;
  return '/' + file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '');
}

// Which links of a page are navigation and which are in the content: nav, header and footer are chrome, everything else is content (the pager of a list counts as content).
function regions(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const chrome = [];
  const content = body.replace(/<(nav|header|footer|aside)\b(?![^>]*\bclass="pager")[\s\S]*?<\/\1>/gi, (m) => { chrome.push(m); return ' '; });
  return { chrome: chrome.join(' '), content };
}

// Resolves a raw href against the page path; null for external, mailto, tel, in-page and other schemes.
export function resolve(raw, from, base = '') {
  if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  let p = raw.split(/[?#]/)[0];
  if (!p) return null;
  if (!p.startsWith('/')) p = new URL(p, 'http://x' + from).pathname;
  if (base && p.startsWith(base + '/')) p = p.slice(base.length);
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  return p;
}

export function extractPage(file, html, base = '') {
  const path = pagePath(file);
  const robots = (html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i) || [])[1] || '';
  const title = textOf((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([\s\S]*?)<\/title>/i) || ['', ''])[1]);
  const { chrome, content } = regions(html);
  const links = [];
  const problems = [];
  for (const [region, part] of [['chrome', chrome], ['content', content]]) {
    for (const m of part.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attr(m[1], 'href');
      const inner = m[2];
      const anchor = textOf(inner);
      const img = inner.match(/<img\b[^>]*>/i);
      const label = attr(m[1], 'aria-label');
      if (href === null) {
        if (/\sonclick=|\sroutelink=/i.test(m[1])) problems.push({ code: 'not-crawlable', path, detail: 'a link without href' });
        continue;
      }
      const to = resolve(href, path, base);
      const alt = img ? attr(img[0], 'alt') : null;
      const name = anchor || label || (img ? alt : '') || '';
      if (to === null) {
        if (/^javascript:/i.test(href)) problems.push({ code: 'not-crawlable', path, detail: href });
        continue;
      }
      if (!name) problems.push({ code: 'empty-anchor', path, detail: href });
      links.push({ to, anchor: name, region, href });
    }
  }
  const text = textOf(content.replace(/<a\b[\s\S]*?<\/a>/gi, ' '));
  return { path, title, noindex: /noindex/i.test(robots), links, problems, text };
}

// Index of `title` in `text` as a whole phrase (not inside a longer word or number, so "סעיף י" does not match "סעיף יב"); a one-letter Hebrew prefix (ה, ב, ל…) before it is allowed. -1 if absent.
const WORD = /[\p{L}\p{N}]/u;
export function mention(text, title) {
  for (let at = text.indexOf(title); at >= 0; at = text.indexOf(title, at + 1)) {
    const after = text[at + title.length];
    const before = text[at - 1];
    const before2 = text[at - 2];
    if ((after && WORD.test(after)) || (before && WORD.test(before) && !(/[הובכלמש]/.test(before) && !(before2 && WORD.test(before2))))) continue;
    return at;
  }
  return -1;
}

// Internal PageRank (what Screaming Frog calls Link Score and Sitebulb URL Rank): a page is worth more when pages that are worth more link to it, and a page with many links gives each one less.
// Returns Map(path -> 0..100), scaled on a log axis so that the weakest page is 0 and the strongest 100.
export function linkScores(paths, out, { damping = 0.85, rounds = 40 } = {}) {
  const n = paths.length;
  if (!n) return new Map();
  const set = new Set(paths);
  let rank = new Map(paths.map((x) => [x, 1 / n]));
  for (let r = 0; r < rounds; r++) {
    const next = new Map(paths.map((x) => [x, (1 - damping) / n]));
    let lost = 0;
    for (const x of paths) {
      const to = [...(out.get(x) || [])].filter((t) => set.has(t));
      if (!to.length) { lost += rank.get(x); continue; }
      const share = (damping * rank.get(x)) / to.length;
      for (const t of to) next.set(t, next.get(t) + share);
    }
    for (const x of paths) next.set(x, next.get(x) + (damping * lost) / n);
    rank = next;
  }
  const vals = [...rank.values()];
  const lo = Math.log(Math.min(...vals)), hi = Math.log(Math.max(...vals));
  return new Map(paths.map((x) => [x, hi === lo ? 100 : Math.round(((Math.log(rank.get(x)) - lo) / (hi - lo)) * 100)]));
}

// data/link-audit.json: what the editor's links screen saves. Fails the build on a shape the audit cannot read.
export function validateAuditConfig(c) {
  const bad = (m) => { throw new Error('data/link-audit.json: ' + m); };
  if (!c || typeof c !== 'object' || Array.isArray(c)) bad('must be an object');
  const path = (x) => typeof x === 'string' && /^\/[^\s]*$/.test(x);
  for (const x of c.ignore || []) if (!x || typeof x.code !== 'string' || !(x.path === '' || path(x.path))) bad('ignore needs { code, path }');
  for (const x of c.ignorePairs || []) if (!Array.isArray(x) || x.length !== 2 || !x.every(path)) bad('ignorePairs needs [from, to] paths');
  for (const [k, v] of Object.entries(c.aliases || {})) if (!path(k) || !Array.isArray(v) || !v.every((t) => typeof t === 'string' && t.trim().length >= 3)) bad(`aliases["${k}"] needs a list of phrases of 3 letters or more`);
  const n = c.related?.count;
  if (n !== undefined && !(Number.isInteger(n) && n >= 0 && n <= 8)) bad('related.count must be a whole number from 0 to 8');
  if (c.related?.exclude !== undefined && !(Array.isArray(c.related.exclude) && c.related.exclude.every((x) => /^[\w-]+$/.test(String(x))))) bad('related.exclude must be a list of question ids');
  return c;
}

const isGeneric = (a) => GENERIC.has(a.toLowerCase().replace(/[\s.,:;!?…«»"'״׳()\-–—>←→»]+/g, ' ').trim());

export function auditSite(files, { base = '', sitemap = [], home = '/', minTitle = 4, minSuggest = 8, config = {}, suggestFor = (p) => !isMinor(p.path) } = {}) {
  // config (data/link-audit.json): ignore = [{ code, path }] silences one finding; ignorePairs = [[from, to]] silences a suggestion; aliases = { path: [phrases] } are other names of a page, matched like its title.
  const ignored = new Set((config.ignore || []).map((x) => `${x.code}|${x.path}`));
  const ignoredPairs = new Set((config.ignorePairs || []).map((x) => x.join('|')));
  const aliases = config.aliases || {};
  const pages = new Map();
  for (const [file, html] of Object.entries(files)) {
    const p = extractPage(file, html, base);
    if (p.path !== null) pages.set(p.path, p);
  }
  const indexable = [...pages.values()].filter((p) => !p.noindex && p.path !== '/404' && !p.path.startsWith('/admin/'));
  const known = new Set(pages.keys());
  const findings = [];
  const add = (severity, code, path, detail) => findings.push({ severity, code, path, detail });

  // Inbound links, from other indexable pages only (a page linking to itself does not make it findable).
  const inAll = new Map(indexable.map((p) => [p.path, new Set()]));
  const inContent = new Map(indexable.map((p) => [p.path, new Set()]));
  const out = new Map();
  for (const p of indexable) {
    const targets = new Set();
    for (const l of p.links) {
      if (l.to === p.path) continue;
      targets.add(l.to);
      if (!known.has(l.to) && !known.has(l.to.replace(/\/?$/, '/')) && !/\.[a-z0-9]{2,5}$/i.test(l.to)) add('error', 'broken-link', p.path, l.href);
      inAll.get(l.to)?.add(p.path);
      if (l.region === 'content') inContent.get(l.to)?.add(p.path);
    }
    out.set(p.path, targets);
    for (const pr of p.problems) add('error', pr.code, p.path, pr.detail);
  }

  // Click depth from the home page.
  const depth = new Map([[home, 0]]);
  const queue = [home];
  while (queue.length) {
    const cur = queue.shift();
    for (const t of out.get(cur) || []) if (!depth.has(t) && inAll.has(t)) { depth.set(t, depth.get(cur) + 1); queue.push(t); }
  }

  for (const p of indexable) {
    if (p.path === home) continue;
    if (inAll.get(p.path).size === 0) add('error', 'orphan', p.path, p.title);
    else if (inContent.get(p.path).size === 0) add('info', 'nav-only', p.path, p.title);
    if (!depth.has(p.path)) { if (inAll.get(p.path).size) add('warn', 'unreachable', p.path, p.title); }
    else if (depth.get(p.path) > MAX_DEPTH + (isListItem(p.path) ? 1 : 0)) add('warn', 'too-deep', p.path, `${depth.get(p.path)} clicks: ${p.title}`);
    if (out.get(p.path).size > MAX_LINKS) add('warn', 'many-links', p.path, `${out.get(p.path).size} links`);
    const seen = new Set();
    for (const l of p.links) {
      if (l.region === 'content' && l.anchor && isGeneric(l.anchor) && !seen.has(l.href)) { seen.add(l.href); add('warn', 'generic-anchor', p.path, `"${l.anchor}" → ${l.to}`); }
    }
    const hasTitle = (p.title || '').length >= minTitle;
    if (!hasTitle) add('warn', 'no-title', p.path, '');
  }

  // The same anchor text pointing at different pages confuses readers and crawlers.
  const byAnchor = new Map();
  for (const p of indexable) for (const l of p.links) {
    if (l.region !== 'content' || !l.anchor || isGeneric(l.anchor) || l.anchor.length < minTitle || /[←→]|PDF|\.pdf$/i.test(l.anchor + l.to)) continue;
    if (!byAnchor.has(l.anchor)) byAnchor.set(l.anchor, new Map());
    const m = byAnchor.get(l.anchor);
    m.set(l.to, (m.get(l.to) || 0) + 1);
  }
  for (const [a, m] of byAnchor) if (m.size > 1) add('info', 'ambiguous-anchor', '', `"${a}" → ${[...m.keys()].slice(0, 4).join(', ')}`);

  // Link score and weakly linked pages (hubs only: the items of a list get their links from the list).
  const score = linkScores(indexable.map((p) => p.path), out);
  const dup = new Map();
  for (const p of indexable) if (suggestFor(p) && p.title) dup.set(p.title, [...(dup.get(p.title) || []), p.path]);
  for (const p of indexable) {
    if (p.path === home || !suggestFor(p)) continue;
    if (inAll.get(p.path).size === 1) add('info', 'single-inlink', p.path, `${[...inAll.get(p.path)][0]} → ${p.title}`);
  }
  for (const [title, paths] of dup) if (paths.length > 1) add('warn', 'duplicate-title', paths[0], `"${title}" ב-${paths.join(', ')}`);
  // One anchor on nearly every link to a page looks forced; a few different natural phrasings are better (Linkilo, InLinks).
  const anchorsTo = new Map();
  for (const p of indexable) for (const l of p.links) {
    if (l.region !== 'content' || !l.anchor || l.to === p.path || !suggestFor({ path: l.to }) || !suggestFor(p) || /^\d+$/.test(l.anchor)) continue;
    if (!anchorsTo.has(l.to)) anchorsTo.set(l.to, new Map());
    const m = anchorsTo.get(l.to);
    m.set(l.anchor, (m.get(l.anchor) || 0) + 1);
  }
  for (const [to, m] of anchorsTo) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    if (total >= 8 && n / total > 0.9) add('info', 'one-anchor', to, `"${top}" ב-${n} מתוך ${total} קישורים`);
  }

  // Sitemap against the pages that really exist.
  if (sitemap.length) {
    const inMap = new Set(sitemap.map((u) => resolve(u, '/', base) || u));
    for (const u of inMap) if (!known.has(u) && !known.has(u.replace(/\/?$/, '/'))) add('error', 'sitemap-missing-page', u, '');
    for (const p of indexable) if (!inMap.has(p.path) && !/^\/shut\/\d+\/?$/.test(p.path)) add('info', 'not-in-sitemap', p.path, p.title);
  }

  // Suggestions: a page whose title (or alias) is written in another page's text without a link to it; the best phrase per pair, and a page that gets many suggestions is listed by its strongest sources first.
  const targets = indexable.filter((p) => suggestFor(p) && p.path !== home && (p.title || '').length >= minSuggest && p.title.split(' ').length >= 2 && p.title.split(' ').length <= 6);
  const names = (t) => [t.title, ...(aliases[t.path] || [])];
  const titleCount = new Map();
  for (const t of targets) titleCount.set(t.title, (titleCount.get(t.title) || 0) + 1);
  const suggestions = [];
  for (const p of indexable) {
    const linked = out.get(p.path);
    for (const t of targets) {
      if (t.path === p.path || linked.has(t.path) || titleCount.get(t.title) > 1 || ignoredPairs.has(`${p.path}|${t.path}`)) continue;
      for (const name of names(t)) {
        const at = mention(p.text, name);
        if (at < 0) continue;
        suggestions.push({ from: p.path, to: t.path, anchor: name, context: p.text.slice(Math.max(0, at - 30), at + name.length + 30), score: score.get(p.path) });
        break;
      }
    }
  }
  suggestions.sort((a, b) => b.score - a.score);

  const kept = findings.filter((f) => !ignored.has(`${f.code}|${f.path}`));
  findings.length = 0;
  findings.push(...kept);
  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  const stats = {
    pages: indexable.length,
    links: indexable.reduce((n, p) => n + p.links.length, 0),
    maxDepth: Math.max(0, ...depth.values()),
    top: [...score].filter(([x]) => suggestFor({ path: x })).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, sc]) => ({ path, score: sc })),
    weakest: [...score].filter(([x]) => suggestFor({ path: x }) && x !== home).sort((a, b) => a[1] - b[1]).slice(0, 10).map(([path, sc]) => ({ path, score: sc })),
    errors: count('error'), warnings: count('warn'), info: count('info'), suggestions: suggestions.length,
  };
  return { stats, findings, suggestions };
}

const LABEL = {
  'broken-link': 'קישור פנימי שבור', orphan: 'עמוד יתום (אין קישור נכנס)', 'nav-only': 'מקושר רק מתפריט או תחתית', unreachable: 'לא מגיעים אליו מדף הבית',
  'too-deep': `עמוק מ-${MAX_DEPTH} לחיצות`, 'many-links': `מעל ${MAX_LINKS} קישורים`, 'generic-anchor': 'עוגן גנרי', 'empty-anchor': 'קישור בלי טקסט', 'not-crawlable': 'קישור שאינו a href',
  'ambiguous-anchor': 'אותו עוגן ליעדים שונים', 'no-title': 'עמוד בלי כותרת', 'sitemap-missing-page': 'ב-sitemap אך אין עמוד', 'single-inlink': 'קישור נכנס אחד בלבד', 'duplicate-title': 'שני עמודים באותה כותרת', 'one-anchor': 'עוגן אחד כמעט בכל הקישורים', 'not-in-sitemap': 'עמוד שאינו ב-sitemap',
};

// Stable keys of everything a report lists, to tell what is new since the previous run.
export const reportKeys = (res) => [
  ...res.findings.filter((f) => f.severity !== 'info').map((f) => `${f.code}|${f.path}|${f.detail}`),
  ...res.suggestions.map((x) => `suggest|${x.from}|${x.to}`),
];
// What needs a person: errors, warnings and suggestions ("info" lines are only shown).
export const needsAttention = (res) => res.stats.errors + res.stats.warnings + res.stats.suggestions > 0;

// Markdown report in Hebrew, grouped by problem; long groups are cut to `limit` rows.
export function formatReport(res, { limit = 25, date = '', previous = null } = {}) {
  const { stats, findings, suggestions } = res;
  const out = [`# דוח קישורים פנימיים${date ? ' ' + date : ''}`, '',
    `עמודים: ${stats.pages} · קישורים: ${stats.links} · עומק מרבי: ${stats.maxDepth}`,
    `שגיאות: ${stats.errors} · אזהרות: ${stats.warnings} · לידיעה: ${stats.info} · הצעות קישור: ${stats.suggestions}`, ''];
  if (previous) {
    const before = new Set(previous);
    const fresh = reportKeys(res).filter((k) => !before.has(k));
    out.push(fresh.length ? `**חדש מאז הריצה הקודמת: ${fresh.length}**` : 'לא נוספו בעיות חדשות מאז הריצה הקודמת.', '');
  }
  const groups = new Map();
  for (const f of findings) { if (!groups.has(f.code)) groups.set(f.code, []); groups.get(f.code).push(f); }
  const order = { error: 0, warn: 1, info: 2 };
  for (const [code, list] of [...groups].sort((a, b) => order[a[1][0].severity] - order[b[1][0].severity])) {
    out.push(`## ${LABEL[code] || code} (${list.length})`, '');
    for (const f of list.slice(0, limit)) out.push(`- ${f.path ? '`' + f.path + '`' : ''}${f.detail ? ' ' + f.detail : ''}`.trim());
    if (list.length > limit) out.push(`- …ועוד ${list.length - limit}`);
    out.push('');
  }
  if (suggestions.length) {
    out.push(`## הצעות לקישורים חדשים (${suggestions.length})`, '', 'שם של עמוד שמופיע בטקסט של עמוד אחר בלי קישור. המלצה לעורך בלבד.', '');
    for (const s of suggestions.slice(0, limit)) out.push(`- \`${s.from}\` ← \`${s.to}\`: …${s.context}…`);
    if (suggestions.length > limit) out.push(`- …ועוד ${suggestions.length - limit}`);
    out.push('');
  }
  if (stats.top?.length) {
    out.push('## דירוג קישורים פנימי (0 עד 100)', '', 'חזקים: ' + stats.top.slice(0, 5).map((x) => `\`${x.path}\` ${x.score}`).join(' · '), '', 'חלשים: ' + stats.weakest.slice(0, 5).map((x) => `\`${x.path}\` ${x.score}`).join(' · '), '');
  }
  if (!findings.length && !suggestions.length) out.push('לא נמצאו בעיות.', '');
  return out.join('\n');
}
