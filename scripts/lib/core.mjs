// Site settings, text helpers, data files and the page writer, shared by every section.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SITE = 'היכל הקודש';
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, ''); // e.g. /Web when served from a sub-path
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, ''); // e.g. https://user.github.io; sitemap URLs must be absolute
const rebase = (h) => (BASE ? h.replace(/(href|src|action)="\//g, `$1="${BASE}/`) : h);
const PER_PAGE = 40;
const BUILD = Date.now().toString(36);
// Fonts carry a hash of their content (fonts/x.woff2?v=…), so they can be cached for a year and a changed file still reaches everyone.
// build.mjs adds it to the url()s in style.css; layout.mjs to the preloads, which must match those exactly.
const FONT_DIR = new URL('../../site/fonts/', import.meta.url);
const fileHash = (u) => createHash('sha256').update(readFileSync(u)).digest('hex').slice(0, 10);
const FONT_V = Object.fromEntries(readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).map((f) => [f, fileHash(new URL(f, FONT_DIR))]));
const font = (f) => `fonts/${f}?v=${FONT_V[f]}`;
// Text in attributes and <title> is escaped without the bidi marks: search results and share previews would show them.
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Page text: a number range (1940–2015) is isolated so it keeps its order inside Hebrew.
const esc = (s) => escAttr(String(s).replace(/(\d+)–(\d+)/g, '\u2066$1–$2\u2069'));
// Links from data/*.json must be https, tel, mailto or a site-relative path; anything else (javascript:, data:, http:) fails the build.
const url = (u, schemes = ['https:']) => {
  if (!u) return '';
  const s = String(u).trim();
  if (/^\/(?!\/)/.test(s) && !s.includes('\\')) return esc(s);
  let p;
  try { p = new URL(s); } catch { throw new Error(`Invalid URL in data: ${s}`); }
  if (!schemes.includes(p.protocol)) throw new Error(`Disallowed URL scheme in data: ${s}`);
  return esc(s);
};
const tel = (n) => { if (!/^[+\d][\d\s-]*$/.test(n)) throw new Error(`Invalid phone in data: ${n}`); return esc(n.replace(/[\s-]/g, '')); };
const nik = (s) => s.replace(/[֑-ׇ]/g, '');
// The body of an answer, for previews and descriptions: from its first full paragraph, without the date,
// the greeting with the asker's name, or the opening "לנכון קבלתי את מכתבך".
const gist = (ps) => ps.slice(Math.max(0, ps.findIndex((p) => p.length > 60))).join(' ').replace(/^לנכון קבלתי (את )?מכתבך[.,]?\s*/, '');
const read = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), 'utf8'));
// Sitemap and llms.txt: entries and lines pointing at a hidden section are dropped.
const dropHiddenLines = (c) => c
  .replace(/<url><loc>[^<]*<\/loc><\/url>/g, (m) => (isHidden(m.replace(/<[^>]+>/g, '').replace(ORIGIN + BASE, '')) ? '' : m))
  .split('\n')
  .filter((l) => !HIDDEN.some((h) => l.includes(`${h})`) || l.includes(`${ORIGIN + BASE}${h}`)))
  .join('\n');
const write = (p, c) => {
  if (isHidden(`/${p}`)) return;
  if (p.endsWith('.html')) c = rebase(unlinkHidden(c));
  else if (/\.(xml|txt)$/.test(p)) c = dropHiddenLines(c);
  mkdirSync(`dist/${p.split('/').slice(0, -1).join('/')}`, { recursive: true });
  writeFileSync(`dist/${p}`, c);
};

// Q&A edits from the editor (/admin/): data/shut-edits/<id>.json holds one whole entry, replacing the one with that id
// (or added, for a new id), or { id, deleted: true } to take it off the site. shut.json itself is never rewritten by the editor.
const SHUT_KINDS = ['shut', 'letters'];
const validateShutEdit = (file, x) => {
  const bad = (m) => { throw new Error(`shut-edits/${file}: ${m}`); };
  if (String(x.id) !== file.replace(/\.json$/, '') || !/^[\w-]+$/.test(String(x.id))) bad('id must match the file name');
  if (x.deleted === true) return;
  if (!SHUT_KINDS.includes(x.kind)) bad(`unknown kind "${x.kind}"`);
  if (!x.title || typeof x.title !== 'string') bad('no title');
  for (const k of ['q', 'a']) if (!Array.isArray(x[k]) || x[k].some((p) => typeof p !== 'string')) bad(`${k} must be a list of paragraphs`);
  if (!x.a.some((p) => p.trim())) bad('empty answer');
};
const mergeShut = (base, edits) => {
  if (!edits.length) return base;
  const byId = new Map(edits.map((e) => [String(e.id), e]));
  const ids = new Set(base.map((x) => String(x.id)));
  return base.map((x) => byId.get(String(x.id)) || x).concat(edits.filter((e) => !ids.has(String(e.id)))).filter((x) => !x.deleted);
};
const EDITS_DIR = new URL('../../data/shut-edits/', import.meta.url);
const shutEdits = (() => { try { return readdirSync(EDITS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; } })()
  .map((f) => { const x = read(`shut-edits/${f}`); validateShutEdit(f, x); return x; });
const all = mergeShut(read('shut.json'), shutEdits);
const shut = all.filter((x) => x.kind === 'shut');
const letters = all.filter((x) => x.kind === 'letters');
// Same shape as shut.json entries: { id, title, q: [...], a: [...], date }.
const halacha = read('halacha.json').map((x) => ({ q: [], date: '', ...x }));
// Sample entries ("דוגמה") are never published; with none left, the section is hidden from the site.
const institutions = read('institutions.json').filter((i) => !/דוגמה/.test(i.name));
const pr = read('print.json');
const yeshiva = read('yeshiva.json');
const site = read('site.json');
// Sections not ready for visitors (data/site.json "hidden"): no pages are built, menu entries and cards
// pointing at them are dropped, and inline links to them become plain text. Tracked in TODO.md.
const HIDDEN = (site.hidden || []).map((x) => x.path);
const isHidden = (u) => HIDDEN.some((h) => u.startsWith(h));
// A list item that opens with a link to a hidden section is dropped (unless it holds a nested list).
const LIST_ITEM = /<li>(<a href="(\/[^"]*)"[\s\S]*?)<\/li>/g;
// Any other link into the site: cards, tiles and buttons to a hidden section are dropped, inline links keep their text.
const SITE_LINK = /<a\b([^>]*)\bhref="(\/[^"#?]*)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
const BLOCK_LINK = /class="[^"]*\b(card|tile|btn|tbtn|feature)\b/;
const unlinkHidden = (html) => {
  if (!HIDDEN.length) return html;
  return html
    .replace(LIST_ITEM, (m, inner, h) => (isHidden(h) && !inner.includes('<li') ? '' : m))
    .replace(SITE_LINK, (m, attrs, h, text) => (!isHidden(h) ? m : BLOCK_LINK.test(m) ? '' : text));
};
const yv = read('yavniel.json');
const mk = read('mikveh.json');
const mo = read('moharash.json');
const lib = read('library.json');
const rn = read('rabbi-nachman.json');
const um = read('uman.json');
const tk = read('tikkun.json');
const tkText = read('books/tikkun-haklali.json');
// Topics and pages made in the editor (/admin/): data/topics.json and data/pages/*.json. Checked here so a bad edit fails the build, not the site.
const BLOCK_TYPES = ['text', 'cards', 'faq', 'quote', 'links'];
const RESERVED = ['admin', 'shut', 'letters', 'library', 'halacha', 'rabbi-nachman', 'uman', 'tikkun-haklali', 'moharash', 'yeshiva', 'print', 'yavniel', 'mikveh-malka', 'institutions', 'search', 'about', 'contact', 'accessibility', 'privacy', 'offline', 'fonts', 'img', 'books', 'idx', 'zmanim'];
const topics = read('topics.json');
const cmsPages = readdirSync(new URL('../../data/pages/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => ({ slug: f.slice(0, -5), ...read(`pages/${f}`) }));
// A topic is a place in the site's menu: its menu group ("group", a title; the site's own groups or a new one), its kind
// ("pages": a few free pages, or "collection": many items of one kind, like the library) and, for a collection,
// its "categories" ([{ id, title }]). Each page may name one of its topic's categories in "category".
const TOPIC_KINDS = ['pages', 'collection'];
const validateCms = (topics, pages) => {
  const bad = (m) => { throw new Error(`CMS: ${m}`); };
  const seen = new Set();
  for (const t of topics) {
    if (!/^[a-z0-9-]+$/.test(t.slug || '') || RESERVED.includes(t.slug) || seen.has(t.slug)) bad(`invalid or duplicate topic slug "${t.slug}"`);
    if (!t.title) bad(`topic ${t.slug} has no title`);
    if (t.kind != null && !TOPIC_KINDS.includes(t.kind)) bad(`topic ${t.slug}: unknown kind "${t.kind}"`);
    if (t.group != null && (typeof t.group !== 'string' || t.group.length > 40)) bad(`topic ${t.slug}: invalid group`);
    const cats = t.categories == null ? [] : t.categories;
    if (!Array.isArray(cats) || cats.some((c) => !/^[a-z0-9-]+$/.test(c.id || '') || !c.title)) bad(`topic ${t.slug}: categories need an id (a-z, 0-9, -) and a title`);
    if (new Set(cats.map((c) => c.id)).size !== cats.length) bad(`topic ${t.slug}: duplicate category id`);
    seen.add(t.slug);
  }
  for (const p of pages) {
    if (!/^[a-z0-9-]+$/.test(p.slug)) bad(`invalid page file name "${p.slug}"`);
    if (!seen.has(p.topic)) bad(`page ${p.slug}: unknown topic "${p.topic}"`);
    if (!p.title) bad(`page ${p.slug} has no title`);
    if (p.category != null && typeof p.category !== 'string') bad(`page ${p.slug}: invalid category`);
    for (const b of p.blocks || []) if (!BLOCK_TYPES.includes(b.type)) bad(`page ${p.slug}: unknown block type "${b.type}"`);
  }
  const keys = pages.map((p) => `${p.topic}/${p.slug}`);
  if (new Set(keys).size !== keys.length) bad('duplicate page');
};
validateCms(topics, cmsPages);
const regey = lib.books.find((b) => b.slug === 'regey-moharash');
const catName = Object.fromEntries(lib.categories);
// Ids become directory names and URLs, so only plain slugs are allowed.
for (const [f, xs] of [['shut.json', all], ['halacha.json', halacha]]) for (const x of xs) if (!/^[\w-]+$/.test(x.id)) throw new Error(`Invalid id in ${f}: ${x.id}`);

export { TOPIC_KINDS, validateShutEdit, mergeShut, topics, cmsPages, validateCms, BLOCK_TYPES, RESERVED, SITE, BASE, ORIGIN, rebase, PER_PAGE, BUILD, font, escAttr, esc, url, tel, nik, gist, read, write, all, shut, letters, halacha, institutions, pr, yeshiva, site, HIDDEN, isHidden, unlinkHidden, yv, mk, mo, lib, rn, um, tk, tkText, regey, catName };
