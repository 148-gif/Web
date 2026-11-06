// Times of the year (data/moadim.json): what the site has on each holiday, gathered for its hub page (/moadim/<id>/), for the
// "more on this holiday" links in the book reader.
// A holiday names its book sections as [book slug, from, to] (the section numbers of data/books/<slug>.json), whole books by slug,
// pages of the site, and the words that pick its questions from the Q&A by their titles.
import { read, lib, shut } from './core.mjs';

// sizes: book slug -> number of sections it has on the site (books without a text file are not in it)
const validateMoadim = (m, books, sizes) => {
  const bad = (x) => { throw new Error(`moadim.json: ${x}`); };
  const ids = new Set();
  for (const x of m.items || []) {
    if (!/^[a-z0-9-]+$/.test(x.id || '')) bad(`bad id "${x.id}"`);
    if (ids.has(x.id)) bad(`duplicate id "${x.id}"`);
    ids.add(x.id);
    if (!x.title || !x.short || !x.lead) bad(`${x.id}: title, short and lead are required`);
    for (const c of x.chapters || []) {
      const [slug, from, to] = c;
      if (!sizes.has(slug)) bad(`${x.id}: "${slug}" is not a book read on the site`);
      if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && from <= to && to <= sizes.get(slug))) bad(`${x.id}: ${slug} ${from}–${to} is outside the book (1–${sizes.get(slug)})`);
    }
    for (const b of x.books || []) if (!books.some((y) => y.slug === b)) bad(`${x.id}: unknown book "${b}"`);
    for (const [h, t] of x.links || []) if (!/^\/[\w/-]*$/.test(h || '') || !t) bad(`${x.id}: a link needs a site path and a title`);
    if (!(x.chapters || []).length && !(x.books || []).length) bad(`${x.id}: nothing to show`);
  }
};

const moadim = read('moadim.json');
const sizes = new Map(lib.books.filter((b) => b.text).map((b) => [b.slug, read(b.text).sections.length]));
validateMoadim(moadim, lib.books, sizes);

// The holidays a section (chapter index k = section number) or a whole book belongs to.
const moedOfChapter = (slug, k) => moadim.items.filter((x) => (x.chapters || []).some(([s, f, t]) => s === slug && k >= f && k <= t));
const moedOfBook = (slug) => moadim.items.filter((x) => (x.books || []).includes(slug) || (x.chapters || []).some(([s]) => s === slug));

// Questions whose title has one of the holiday's words as a word of its own (a prefix letter such as ב, ל, ו, ה is allowed), so
// "פורים" does not find "הכיפורים" or "ספורים". Those that mention another holiday too come last.
const he = (w) => new RegExp(`(^|[^\\u05D0-\\u05EA])[והבלמש]{0,2}${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\u05D0-\\u05EA])`);
const qaRe = new Map(moadim.items.map((x) => [x.id, (x.qa || []).map(he)]));
const hits = (id, t) => qaRe.get(id).some((r) => r.test(t));
const qaFor = (x) => {
  const own = shut.filter((q) => hits(x.id, q.title));
  const others = (q) => moadim.items.filter((y) => y !== x && hits(y.id, q.title)).length;
  return own.map((q, i) => [others(q), i, q]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , q]) => q);
};

export { moadim, validateMoadim, moedOfChapter, moedOfBook, qaFor };
