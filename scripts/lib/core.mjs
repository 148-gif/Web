// Site settings, text helpers, data files and the page writer, shared by every section.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE = 'היכל הקודש';
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, ''); // e.g. /Web when served from a sub-path
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, ''); // e.g. https://user.github.io; sitemap URLs must be absolute
const rebase = (h) => (BASE ? h.replace(/(href|src|action)="\//g, `$1="${BASE}/`) : h);
const PER_PAGE = 40;
const FONTS = 'https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Frank+Ruhl+Libre:wght@400;700;900&display=swap';
const BUILD = Date.now().toString(36);
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
const write = (p, c) => {
  if (isHidden(`/${p}`)) return;
  if (p.endsWith('.html')) c = rebase(unlinkHidden(c));
  else if (/\.(xml|txt)$/.test(p)) c = c.replace(/<url><loc>[^<]*<\/loc><\/url>/g, (m) => (isHidden(m.replace(/<[^>]+>/g, '').replace(ORIGIN + BASE, '')) ? '' : m)).split('\n').filter((l) => !HIDDEN.some((h) => l.includes(`${h})`) || l.includes(`${ORIGIN + BASE}${h}`))).join('\n');
  mkdirSync(`dist/${p.split('/').slice(0, -1).join('/')}`, { recursive: true }); writeFileSync(`dist/${p}`, c);
};

const all = read('shut.json');
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
const unlinkHidden = (html) => (HIDDEN.length ? html.replace(/<li>(<a href="(\/[^"]*)"[\s\S]*?)<\/li>/g, (m, inner, h) => (isHidden(h) && !inner.includes('<li') ? '' : m)).replace(/<a\b([^>]*)\bhref="(\/[^"#?]*)[^"]*"[^>]*>([\s\S]*?)<\/a>/g, (m, pre, h, inner) => (!isHidden(h) ? m : /class="[^"]*\b(card|tile|btn|tbtn|feature)\b/.test(m) ? '' : inner)) : html);
const yv = read('yavniel.json');
const mk = read('mikveh.json');
const mo = read('moharash.json');
const lib = read('library.json');
const rn = read('rabbi-nachman.json');
const um = read('uman.json');
const tk = read('tikkun.json');
const tkText = read('books/tikkun-haklali.json');
const regey = lib.books.find((b) => b.slug === 'regey-moharash');
const catName = Object.fromEntries(lib.categories);
// Ids become directory names and URLs, so only plain slugs are allowed.
for (const [f, xs] of [['shut.json', all], ['halacha.json', halacha]]) for (const x of xs) if (!/^[\w-]+$/.test(x.id)) throw new Error(`Invalid id in ${f}: ${x.id}`);

export { SITE, BASE, ORIGIN, rebase, PER_PAGE, FONTS, BUILD, escAttr, esc, url, tel, nik, gist, read, write, all, shut, letters, halacha, institutions, pr, yeshiva, site, HIDDEN, isHidden, unlinkHidden, yv, mk, mo, lib, rn, um, tk, tkText, regey, catName };
