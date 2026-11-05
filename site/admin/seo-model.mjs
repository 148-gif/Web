// Original shared SEO contracts and lexical ranking. No network, provider or model dependency.
export const SEO_VERSION = 1;
const plainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
export const pageKey = (path) => btoa(String.fromCharCode(...new TextEncoder().encode(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const seoFile = (path) => 'data/seo-' + pageKey(path) + '.json';
export const cleanPath = (p) => typeof p === 'string' && p.length <= 160 && /^\/(?:[A-Za-z0-9_-]+\/)*$/.test(p) && !/^\/(?:admin|cms-api|files|media|fonts|img|idx|books|offline|zmanim)(?:\/|$)/.test(p);
export const normalize = (s) => String(s || '').normalize('NFKC').replace(/[֑-ׇ]/g, '').replace(/["'׳״]/g, '').replace(/־/g, ' ').toLowerCase();
const STOP = new Set('את של על עם אל לא כן כל גם או אם אני אתה הוא היא הם הן זה זו זאת אשר מה איך למה האם כי יש אין היה היו להיות לי לו לה לנו לכם שלו שלי שלך מאוד מאד יותר כמו אבל רק כבר כדי כאשר עד עוד בין מתוך לפני אחרי רבי הרב רבינו הקדוש השם יתברך ברוך שלום תודה שאלה תשובה ספר בספר'.split(' '));
export function terms(text) { return normalize(text).split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2 && !STOP.has(x)); }
export function validateSeo(record, file) {
  const bad = (s) => { throw new Error('SEO: ' + s); };
  if (!plainObject(record) || !cleanPath(record.path)) bad('כתובת העמוד אינה תקינה');
  if (file && file !== seoFile(record.path)) bad('כתובת העמוד אינה תואמת לקובץ');
  const allowed = new Set(['version', 'path', 'title', 'description', 'canonical', 'indexing', 'image', 'aliases', 'keywords', 'links', 'related', 'relatedAuto', 'redirectTo', 'dismissed']);
  if (Object.keys(record).some((k) => !allowed.has(k))) bad('שדה הגדרה לא מוכר');
  if (record.version !== undefined && record.version !== SEO_VERSION) bad('גרסת הגדרות לא נתמכת');
  for (const [k, max] of [['title', 180], ['description', 500], ['image', 500]]) if (record[k] !== undefined && (typeof record[k] !== 'string' || record[k].length > max || [...record[k]].some((c) => c.charCodeAt(0) < 32))) bad('ערך לא תקין: ' + k);
  if (record.image && !/^\/(?!\/)[^\s<>"'\\]+$/.test(record.image)) bad('תמונת שיתוף צריכה כתובת קבועה בתוך האתר');
  if (record.indexing !== undefined && !['inherit', 'index', 'noindex'].includes(record.indexing)) bad('מצב אינדוקס לא מוכר');
  for (const k of ['canonical', 'redirectTo']) if (record[k] && (!cleanPath(record[k]) || (k === 'redirectTo' && record[k] === record.path))) bad('כתובת לא תקינה: ' + k);
  for (const k of ['aliases', 'keywords']) if (record[k] !== undefined && (!Array.isArray(record[k]) || record[k].length > 20 || record[k].some((x) => typeof x !== 'string' || x.trim().length < 3 || x.length > 100))) bad('ביטויים צריכים להיות רשימה של 3–100 תווים');
  if (record.relatedAuto !== undefined && typeof record.relatedAuto !== 'boolean') bad('מצב תוכן קשור אינו תקין');
  if (record.related !== undefined && (!Array.isArray(record.related) || record.related.length > 8 || record.related.some((x) => !plainObject(x) || !cleanPath(x.path) || x.path === record.path || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 180))) bad('רשימת התוכן הקשור אינה תקינה');
  if (new Set((record.related || []).map((x) => x.path)).size !== (record.related || []).length) bad('תוכן קשור מופיע פעמיים');
  if (record.links !== undefined && (!Array.isArray(record.links) || record.links.length > 50)) bad('יותר מדי קישורים מוגדרים לעמוד');
  if (record.dismissed !== undefined && (!Array.isArray(record.dismissed) || record.dismissed.length > 100)) bad('רשימת הצעות שנדחו אינה תקינה');
  for (const x of [...(record.links || []), ...(record.dismissed || [])]) if (!plainObject(x) || typeof x.quote !== 'string' || !x.quote.trim() || x.quote.length > 3000 || typeof x.anchor !== 'string' || !x.anchor.trim() || x.anchor.length > 180 || !x.quote.includes(x.anchor) || (x.start !== undefined && (!Number.isInteger(x.start) || x.start < 0 || x.quote.slice(x.start, x.start + x.anchor.length) !== x.anchor)) || !cleanPath(x.to) || x.to === record.path) bad('הגדרת קישור אינה תקינה');
  return record;
}
export function validateSeoSettings(x) {
  if (!plainObject(x) || Object.keys(x).some((k) => !['version', 'indexing', 'rules'].includes(k))) throw new Error('SEO: הגדרות כלליות אינן תקינות');
  if (x.version !== undefined && x.version !== SEO_VERSION) throw new Error('SEO: גרסת הגדרות לא נתמכת');
  if (x.indexing !== undefined && !['index', 'noindex'].includes(x.indexing)) throw new Error('SEO: מצב אינדוקס כללי לא תקין');
  if (x.rules !== undefined && (!Array.isArray(x.rules) || x.rules.length > 100)) throw new Error('SEO: רשימת כללים אינה תקינה');
  for (const r of x.rules || []) {
    if (!plainObject(r) || typeof r.anchor !== 'string' || r.anchor.trim().length < 3 || r.anchor.length > 100 || !cleanPath(r.to) || typeof r.enabled !== 'boolean') throw new Error('SEO: כלל קישור אינו תקין');
    for (const k of ['include', 'exclude']) if (r[k] !== undefined && (!Array.isArray(r[k]) || r[k].length > 20 || r[k].some((p) => !cleanPath(p)))) throw new Error('SEO: תחום כלל הקישור אינו תקין');
    if (r.requireAny !== undefined && (!Array.isArray(r.requireAny) || r.requireAny.length > 12 || r.requireAny.some((s) => typeof s !== 'string' || !s.trim() || s.length > 50))) throw new Error('SEO: הקשר כלל הקישור אינו תקין');
  }
  return x;
}
export function resolveRedirect(path, records) {
  const seen = new Set(); let next = path;
  while (records[next]?.redirectTo) { if (seen.has(next)) throw new Error('SEO: לולאת הפניות ב-' + path); seen.add(next); next = records[next].redirectTo; }
  return next;
}
export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const decodeHtml = (s) => String(s).replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[\da-f]+|\d+);/gi, (m) => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
  if (named[m.toLowerCase()]) return named[m.toLowerCase()];
  const n = m[2].toLowerCase() === 'x' ? parseInt(m.slice(3), 16) : parseInt(m.slice(2), 10);
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
export const textOf = (html) => decodeHtml(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export function paragraphsOf(html) {
  const main = (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || [])[1] || html;
  const body = main.replace(/<(nav|aside|script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  return [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].filter((m) => !/<a\b/i.test(m[1])).map((m) => decodeHtml(m[1].replace(/<[^>]*>/g, '')).trim()).filter((p) => p.length >= 20 && p.length <= 3000);
}
// Approved links are annotations, never raw HTML. Ambiguous or changed excerpts stay unlinked.
export function annotateHtml(html, annotations) {
  const parts = html.split(/(<[^>]+>)/g), nodes = [], stack = []; let main = false;
  for (let i = 0; i < parts.length; i++) {
    const tag = /^<\s*(\/?)([\w-]+)/.exec(parts[i]);
    if (tag) {
      const name = tag[2].toLowerCase();
      if (name === 'main') main = !tag[1];
      if (['a', 'nav', 'header', 'footer', 'aside', 'script', 'style', 'h1', 'h2', 'h3', 'h4', 'button'].includes(name)) { if (tag[1]) { const n = stack.lastIndexOf(name); if (n >= 0) stack.splice(n, 1); } else if (!/\/\s*>$/.test(parts[i])) stack.push(name); }
    } else if (main && !stack.length && parts[i].trim()) nodes.push({ i, text: decodeHtml(parts[i]), ranges: [] });
  }
  const applied = [], stale = [];
  for (const link of annotations || []) {
    if (!cleanPath(link.to)) { stale.push(link); continue; }
    const candidates = nodes.flatMap((n) => { const at = n.text.indexOf(link.quote); if (at < 0 || at !== n.text.lastIndexOf(link.quote)) return []; return [{ node: n, start: at + (link.start === undefined ? link.quote.indexOf(link.anchor) : link.start) }]; });
    if (candidates.length !== 1) { stale.push(link); continue; }
    const c = candidates[0], end = c.start + link.anchor.length;
    if (/[\p{L}\p{N}]/u.test(c.node.text[end] || '') || /[\p{L}\p{N}]{2}$/u.test(c.node.text.slice(Math.max(0, c.start - 2), c.start))) { stale.push(link); continue; }
    if (c.node.ranges.some((r) => c.start < r.end && end > r.start)) { stale.push(link); continue; }
    c.node.ranges.push({ start: c.start, end, to: link.to }); applied.push(link);
  }
  for (const n of nodes.filter((n) => n.ranges.length)) { let at = 0, result = ''; for (const r of n.ranges.sort((a, b) => a.start - b.start)) { result += escapeHtml(n.text.slice(at, r.start)) + '<a href="' + escapeHtml(r.to) + '">' + escapeHtml(n.text.slice(r.start, r.end)) + '</a>'; at = r.end; } parts[n.i] = result + escapeHtml(n.text.slice(at)); }
  return { html: parts.join(''), applied, stale };
}
// Preserve offsets in the original Hebrew text while comparing without niqqud and quote variants.
export function findPhrase(text, phrase) {
  let value = ''; const offsets = [];
  for (let i = 0; i < text.length; i++) for (const c of normalize(text[i])) { const ch = /\s/.test(c) ? ' ' : c; if (ch === ' ' && value.endsWith(' ')) continue; value += ch; offsets.push(i); }
  const wanted = normalize(phrase).replace(/\s+/g, ' ').trim(); if (!wanted) return null;
  for (let at = value.indexOf(wanted); at >= 0; at = value.indexOf(wanted, at + 1)) {
    if (/[\p{L}\p{N}]/u.test(value[at + wanted.length] || '') || /[\p{L}\p{N}]{2}$/u.test(value.slice(Math.max(0, at - 2), at))) continue;
    let end = offsets[at + wanted.length - 1] + 1; while (/[֑-ׇ]/.test(text[end] || '')) end++;
    return { start: offsets[at], end, anchor: text.slice(offsets[at], end) };
  }
  return null;
}
export function shardFor(path) { let n = 0; for (const c of path) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n % 16; }
// BM25 over a local inverted index. Corpus statistics and explicit editorial metadata are the only inputs.
export function contentRecommendations(pages, { records = {}, aliases = {}, ignorePairs = [] } = {}) {
  const docs = pages.filter((p) => !p.noindex && !/^\/(?:admin|search|privacy|accessibility|contact)(?:\/|$)/.test(p.path));
  const post = new Map(), vectors = [], lengths = []; let total = 0;
  docs.forEach((p, i) => {
    const cfg = records[p.path] || {}, counts = new Map();
    for (const [text, weight] of [[p.title, 3], [(cfg.keywords || []).join(' '), 4], [(cfg.aliases || []).join(' '), 3], [p.text, 1]]) for (const t of terms(text)) counts.set(t, (counts.get(t) || 0) + weight);
    const len = [...counts.values()].reduce((a, b) => a + b, 0) || 1; lengths.push(len); total += len; vectors.push(counts);
    for (const [t, tf] of counts) { if (!post.has(t)) post.set(t, []); post.get(t).push([i, tf]); }
  });
  const average = total / Math.max(1, docs.length), ignored = new Set(ignorePairs.map((p) => p.join('|'))), inline = [], related = {};
  const entityTargets = docs.filter((x) => !/^\/(?:shut|letters|halacha)\/\d+\/$/.test(x.path) && !/\/page\/\d+\/$/.test(x.path));
  docs.forEach((p, i) => {
    const normalizedText = normalize(p.text);
    const query = [...vectors[i]].filter(([t]) => post.get(t).length <= Math.max(2, docs.length * 0.15)).sort((a, b) => b[1] - a[1]).slice(0, 16);
    const scores = new Map(), shared = new Map();
    for (const [t, w] of query) { const rows = post.get(t), idf = Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5)); for (const [j, tf] of rows) { if (i === j) continue; const value = idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * lengths[j] / average)); scores.set(j, (scores.get(j) || 0) + value * (1 + Math.log(w))); if (!shared.has(j)) shared.set(j, []); shared.get(j).push(t); } }
    const ranked = [...scores].filter(([j]) => shared.get(j).length >= 2 && !ignored.has(p.path + '|' + docs[j].path)).sort((a, b) => b[1] - a[1] || docs[a[0]].path.localeCompare(docs[b[0]].path)).slice(0, 30);
    related[p.path] = ranked.filter(([j]) => !(p.links || []).some((l) => l.to === docs[j].path && l.region === 'content')).slice(0, 5).map(([j, score]) => ({ to: docs[j].path, title: docs[j].title, score: Math.round(score * 100) / 100, terms: shared.get(j).slice(0, 6), reason: 'מילים משמעותיות משותפות בתוכן' }));
    const candidates = new Map(ranked.map(([j, s]) => [docs[j].path, { page: docs[j], score: s }]));
    // Exact named entities remain eligible even when a short page has too few statistical terms.
    for (const t of entityTargets) { const names = [t.title, ...(records[t.path]?.aliases || []), ...(aliases[t.path] || [])]; if (names.some((n) => n.length >= 4 && normalizedText.includes(normalize(n)))) if (!candidates.has(t.path)) candidates.set(t.path, { page: t, score: 0 }); }
    const paras = p.paragraphs || [];
    for (const { page: t, score } of candidates.values()) {
      if (t.path === p.path || t.path === '/' || ignored.has(p.path + '|' + t.path)) continue;
      if ((p.links || []).some((l) => l.to === t.path && l.region === 'content' && !l.related)) continue;
      const names = [...new Set([...(records[t.path]?.aliases || []), ...(aliases[t.path] || []), t.title])].filter((n) => n && n.length >= 4).sort((a, b) => b.length - a.length);
      let found;
      for (const quote of paras) {
        for (const anchor of names) {
          const match = findPhrase(quote, anchor); if (!match) continue; const at = match.start;
          const context = quote.slice(Math.max(0, at - 50), at + anchor.length + 50);
          if (/^\/library\/[^/]+\/$/.test(t.path) && !/(?:ספר|פירוש|קונטרס|כרך|כרכי|בהקדמ)/.test(context)) continue;
          found = { from: p.path, to: t.path, anchor: match.anchor, start: match.start, quote, context, score: Math.round(score * 100) / 100, reason: /^\/library\//.test(t.path) ? 'אזכור ספר בהקשר מפורש' : 'ביטוי יעד בתוך הפסקה' }; break;
        }
        if (found) break;
      }
      if (found && !(records[p.path]?.dismissed || []).some((x) => x.to === found.to && x.quote === found.quote && x.anchor === found.anchor)) inline.push(found);
    }
  });
  inline.sort((a, b) => b.score - a.score || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { inline, related };
}
