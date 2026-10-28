// Site settings, text helpers, data files and the page writer, shared by every section.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SITE = 'היכל הקודש';
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, ''); // e.g. /Web when served from a sub-path
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, ''); // e.g. https://user.github.io; sitemap URLs must be absolute
// srcset holds several comma-separated paths, so each one that starts at the site root gets the base too.
const rebase = (h) => (BASE ? h.replace(/(href|src|action)="\//g, `$1="${BASE}/`).replace(/srcset="([^"]*)"/g, (m, v) => `srcset="${v.replace(/(^|,\s*)\//g, `$1${BASE}/`)}"`) : h);
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
const BLOCK_TYPES = ['text', 'cards', 'faq', 'quote', 'links', 'image', 'gallery'];
const RESERVED = ['admin', 'shut', 'letters', 'library', 'halacha', 'rabbi-nachman', 'uman', 'tikkun-haklali', 'moharash', 'yeshiva', 'print', 'yavniel', 'mikveh-malka', 'institutions', 'search', 'about', 'contact', 'accessibility', 'privacy', 'offline', 'fonts', 'img', 'books', 'idx', 'zmanim'];
const topics = read('topics.json');
const cmsPages = readdirSync(new URL('../../data/pages/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => ({ slug: f.slice(0, -5), ...read(`pages/${f}`) }));
// A topic is a place in the site's menu: its menu group ("group", a title; the site's own groups or a new one), its kind
// ("page": a single page, like אומן, or "collection": many items of one kind, like the library) and, for a collection,
// its "categories" ([{ id, title }]). Each page may name one of its topic's categories in "category".
// "pages" is the old name of a collection without categories, from before single pages existed.
const TOPIC_KINDS = ['page', 'collection', 'pages'];
const isSingle = (t) => t.kind === 'page';
const validateCms = (topics, pages, imgs = images) => {
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
    for (const b of p.blocks || []) {
      if (!BLOCK_TYPES.includes(b.type)) bad(`page ${p.slug}: unknown block type "${b.type}"`);
      // A photo reaches visitors only with the owner's approval (see .claude/skills/images/SKILL.md).
      const ids = b.type === 'image' ? [b.id] : b.type === 'gallery' ? (Array.isArray(b.ids) && b.ids.length && b.ids.length <= MAX_GALLERY ? b.ids : bad(`page ${p.slug}: a gallery needs 1 to ${MAX_GALLERY} image ids`)) : [];
      for (const id of ids) {
        const im = imgs.find((x) => x.id === id);
        if (!im) bad(`page ${p.slug}: unknown image "${id}"`);
        if (im.rights !== 'approved') bad(`page ${p.slug}: image "${id}" is not approved for publishing (rights: ${im.rights})`);
      }
    }
  }
  for (const t of topics.filter(isSingle)) if (pages.filter((p) => p.topic === t.slug).length > 1) bad(`topic ${t.slug} is a single page, but has more than one page`);
  const keys = pages.map((p) => `${p.topic}/${p.slug}`);
  if (new Set(keys).size !== keys.length) bad('duplicate page');
};
// Photos: data/images.json lists them; each one's files are data/img/<id>/<width>.webp (sizes, the largest is the whole photo) and
// t360.webp / t720.webp (3:4 thumbnails cut around the face). scripts/prepare-image.mjs makes them. The editor writes only under data/.
const IMG_RIGHTS = ['approved', 'pending'], IMG_WIDTHS = [480, 800, 1200, 1600], IMG_THUMBS = [360, 720], MAX_GALLERY = 24;
const images = read('images.json');
// Width and height from the header of a WebP file (lossy, lossless or extended), so no image library is needed to check them.
const webpSize = (b) => {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP file');
  const k = b.toString('latin1', 12, 16);
  if (k === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (k === 'VP8L') { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  if (k === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  throw new Error('unknown WebP type');
};
const imgWidths = (im) => [...IMG_WIDTHS.filter((w) => w < im.w), im.w];
const IMG_DIR = new URL('../../data/img/', import.meta.url);
const validateImages = (list, dir = IMG_DIR) => {
  const bad = (m) => { throw new Error(`Images: ${m}`); };
  const seen = new Set();
  for (const im of list) {
    const at = `image "${im.id}"`;
    if (!/^[a-z0-9-]+$/.test(im.id || '') || seen.has(im.id)) bad(`invalid or duplicate id "${im.id}"`);
    seen.add(im.id);
    if (!Number.isInteger(im.w) || !Number.isInteger(im.h) || im.w < 1 || im.h < 1) bad(`${at}: w and h must be whole numbers`);
    if (typeof im.alt !== 'string' || (!im.alt.trim() && !im.decorative)) bad(`${at}: needs alt text (or decorative: true for an image that only decorates)`);
    if (!IMG_RIGHTS.includes(im.rights)) bad(`${at}: rights must be one of ${IMG_RIGHTS.join(', ')}`);
    for (const f of ['fx', 'fy']) if (typeof im[f] !== 'number' || im[f] < 0 || im[f] > 100) bad(`${at}: ${f} must be a number from 0 to 100`);
    for (const f of ['caption', 'credit', 'year', 'note']) if (im[f] != null && typeof im[f] !== 'string') bad(`${at}: ${f} must be text`);
    const size = (f) => { try { return webpSize(readFileSync(new URL(`${im.id}/${f}`, dir))); } catch (e) { return bad(`${at}: ${f}: ${e.code === 'ENOENT' ? 'file is missing' : e.message}`); } };
    for (const w of imgWidths(im)) {
      const [fw, fh] = size(`${w}.webp`);
      // The browser reserves space from width/height, so every size must have the registered proportions.
      if (fw !== w || Math.abs(fh - (w * im.h) / im.w) > 1.5) bad(`${at}: ${w}.webp is ${fw}x${fh}, expected ${w}x${Math.round((w * im.h) / im.w)}`);
    }
    for (const tw of IMG_THUMBS.filter((t) => t <= im.w)) {
      const [fw, fh] = size(`t${tw}.webp`);
      if (fw !== tw || fh !== Math.round((tw * 4) / 3)) bad(`${at}: t${tw}.webp must be ${tw}x${Math.round((tw * 4) / 3)}`);
    }
  }
};
validateImages(images);
validateCms(topics, cmsPages);
const regey = lib.books.find((b) => b.slug === 'regey-moharash');
const catName = Object.fromEntries(lib.categories);
// Ids become directory names and URLs, so only plain slugs are allowed.
for (const [f, xs] of [['shut.json', all], ['halacha.json', halacha]]) for (const x of xs) if (!/^[\w-]+$/.test(x.id)) throw new Error(`Invalid id in ${f}: ${x.id}`);

export { images, validateImages, webpSize, imgWidths, IMG_THUMBS, IMG_DIR, MAX_GALLERY, TOPIC_KINDS, isSingle, validateShutEdit, mergeShut, topics, cmsPages, validateCms, BLOCK_TYPES, RESERVED, SITE, BASE, ORIGIN, rebase, PER_PAGE, BUILD, font, escAttr, esc, url, tel, nik, gist, read, write, all, shut, letters, halacha, institutions, pr, yeshiva, site, HIDDEN, isHidden, unlinkHidden, yv, mk, mo, lib, rn, um, tk, tkText, regey, catName };
