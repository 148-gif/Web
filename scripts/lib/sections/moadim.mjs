// Times of the year: /moadim/ lists the holidays in the order of the year, and /moadim/<id>/ gathers what the site has on one of them
// (data/moadim.json, scripts/lib/moadim.mjs): Moharash's talks and other book sections, whole books, pages of the site and Q&A.
import { esc, nik, write, lib, read } from '../core.mjs';
import { icon, layout, phead, card } from '../layout.mjs';
import { ld, absu, crumbs } from '../parts.mjs';
import { moadim, qaFor } from '../moadim.mjs';
import { bookChapters } from './library.mjs';

const QA_SHOW = 6;
const book = (slug) => lib.books.find((b) => b.slug === slug);
const unitPl = new Map(lib.books.filter((b) => b.text).map((b) => [b.slug, read(b.text).unitPlural || 'סעיפים']));
// A range of sections is named by its book, and by the book's part when the range is exactly one part ("חודש אדר").
const rangeName = ([slug, from, to]) => {
  const b = book(slug), p = (b.parts || []).find(([, , [f, t]]) => f === from && t === to);
  return p ? `${b.title}: ${p[0]}` : b.title;
};
const chList = ([slug, from, to]) => `<ol class="toc">${bookChapters[slug].slice(from, to + 1).map((c) => `<li><a href="/library/${slug}/${c.id}/"><b>${esc(c.label)}</b><span>${esc(c.title)}</span></a></li>`).join('')}</ol>`;
const bookCard = (b) => `<a class="card book" href="/library/${b.slug}/">${icon('book', 'ico lg')}<h3>${esc(b.title)}</h3><p>${esc(b.sub)}</p><span class="go">${b.text ? 'לקריאה באתר ←' : 'לספר ←'}</span></a>`;

// What each holiday shows, worked out once: the hub page and the home page teaser both use it.
const content = moadim.items.map((m) => {
  const ranges = m.chapters || [], books = (m.books || []).map(book), qa = qaFor(m);
  return { m, ranges, books, qa, links: m.links || [] };
});

const sections = ({ m, ranges, books, qa, links }) => [
  ...ranges.map((r, i) => [`r${i + 1}`, rangeName(r), `<h2 class="subh">${icon('book', 'ico')}${esc(rangeName(r))} <small>${r[2] - r[1] + 1} ${esc(unitPl.get(r[0]))}</small></h2>${chList(r)}`]),
  ...(books.length ? [['books', 'ספרים', `<h2 class="subh">${icon('books', 'ico')}ספרים ל${esc(m.short)}</h2><div class="grid">${books.map(bookCard).join('')}</div>`]] : []),
  ...(links.length ? [['site', 'באתר', `<h2 class="subh">${icon('pin', 'ico')}עוד באתר</h2><div class="grid">${links.map(([h, t, d]) => `<a class="card" href="${h}"><h3>${esc(t)}</h3>${d ? `<p>${esc(d)}</p>` : ''}<span class="go">לעמוד ←</span></a>`).join('')}</div>`]] : []),
  ...(qa.length ? [['qa', 'שאלות ותשובות', `<h2 class="subh">${icon('chat', 'ico')}שאלות ותשובות <small>${qa.length}</small></h2><div class="grid">${qa.slice(0, QA_SHOW).map((x) => card(x)).join('')}</div>${m.search ? `<p class="ctarow"><a class="btn ghost" href="/search/?q=${encodeURIComponent(m.search)}">לכל השאלות על ${esc(m.short)} ←</a></p>` : ''}`]] : []),
];

const all = moadim.items;
content.forEach((c, i) => {
  const { m } = c, self = `/moadim/${m.id}/`, secs = sections(c), prev = all[i - 1], next = all[i + 1];
  const chipsNav = `<nav class="chips lchips moedchips" aria-label="זמני השנה">${all.map((x) => `<a href="/moadim/${x.id}/"${x === m ? ' aria-current="page"' : ''}>${esc(x.short)}</a>`).join('')}</nav>`;
  write(`moadim/${m.id}/index.html`, layout(m.title, `<section class="band"><div class="wrap">${secs.length > 2 ? `<nav class="chips lchips anchors" aria-label="בעמוד זה">${secs.map(([h, t]) => `<a href="#${h}">${esc(t.replace(/^.*: /, ''))}</a>`).join('')}</nav>` : ''}
${secs.map(([h, , html]) => `<section class="libcat moedsec" id="${h}">${html}</section>`).join('')}
<nav class="qnav" aria-label="מועדים נוספים">${prev ? `<a class="prev" href="/moadim/${prev.id}/"><small>→ הקודם בשנה</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="/moadim/${next.id}/"><small>הבא בשנה ←</small>${esc(next.title)}</a>` : '<span></span>'}</nav>
<p class="small"><a href="/moadim/">← לכל זמני השנה</a></p></div></section>`,
    { desc: `${m.title}: ${m.lead} שיחות של מוהרא״ש, ספרים, מכתבים ושאלות ותשובות.`.slice(0, 155), path: '/moadim/', self, full: true,
      head: phead('<a href="/moadim/">זמני השנה</a>', esc(m.title), esc(m.lead), chipsNav),
      head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: m.title, description: m.lead, inLanguage: 'he', ...(absu(self) ? { url: absu(self) } : {}) }, crumbs([['בית', '/'], ['זמני השנה', '/moadim/'], [m.title, self]])] }) }));
});

// what a holiday has, in a few words: "3 שיחות · ספר · 16 מכתבים · 24 שאלות"
const counts = ({ ranges, books, qa }) => [
  ...ranges.map(([s, f, t]) => `${t - f + 1} ${unitPl.get(s)}`),
  ...(books.length ? [books.length === 1 ? 'ספר' : `${books.length} ספרים`] : []),
  ...(qa.length ? [`${qa.length} שאלות ותשובות`] : []),
].join(' · ');
write('moadim/index.html', layout('זמני השנה', `<section class="band"><div class="wrap"><div class="grid moedgrid">${content.map((c) => `<a class="card moedcard" href="/moadim/${c.m.id}/">${icon('calendar', 'ico lg')}<h3>${esc(c.m.title)}</h3><p>${esc(c.m.lead)}</p><span class="mcount">${esc(counts(c))}</span><span class="go">לכל התכנים ←</span></a>`).join('')}</div></div></section>`,
  { desc: `זמני השנה בדרך ברסלב: ${all.map((m) => m.short).join(', ')}. שיחות של מוהרא״ש, ספרים, מכתבים ושאלות ותשובות לכל מועד.`.slice(0, 155), path: '/moadim/', full: true,
    head: phead('מוהרא״ש · חסידות ברסלב', 'זמני השנה', esc(moadim.intro)),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: 'זמני השנה', description: moadim.intro, inLanguage: 'he', hasPart: all.map((m) => ({ '@type': 'CollectionPage', name: m.title, ...(absu(`/moadim/${m.id}/`) ? { url: absu(`/moadim/${m.id}/`) } : {}) })) }, crumbs([['בית', '/'], ['זמני השנה', '/moadim/']])] }) }));

// Home page teaser: one hidden band per holiday; site/app.js shows the one whose dates (data-from..data-to, Hebrew calendar) hold today,
// with a count of the days left to data-day. Three items at most, of different kinds, and one way on to the hub page.
const teaserItems = ({ ranges, books, qa }) => {
  const sec = ([slug, from]) => { const c = bookChapters[slug][from], b = book(slug); return [`/library/${slug}/${c.id}/`, b.title, nik(c.title), 'לקריאה ←']; };
  // a talk of Moharash first, then a book, a question, and only then the letters of the month (their titles are dates)
  const talks = ranges.filter(([s]) => s === 'sichot-moharash'), rest = ranges.filter(([s]) => s !== 'sichot-moharash');
  return [
    ...talks.slice(0, 1).map(sec),
    ...books.slice(0, 1).map((b) => [`/library/${b.slug}/`, 'ספר', b.title, 'לספר ←']),
    ...qa.slice(0, 1).map((q) => [`/shut/${q.id}/`, 'שאלה ותשובה', q.title, 'לתשובה ←']),
    ...rest.slice(0, 1).map(sec),
    ...qa.slice(1, 3).map((q) => [`/shut/${q.id}/`, 'שאלה ותשובה', q.title, 'לתשובה ←']),
  ].slice(0, 3);
};
const moedTeasers = content.map((c) => {
  const { m } = c, d = (x) => x.join(' ');
  return `<section class="band moedband" data-moed="${m.id}" data-from="${d(m.from)}" data-to="${d(m.to)}"${m.day ? ` data-day="${d(m.day)}" data-dayname="${esc(m.dayName)}"` : ''} hidden><div class="wrap"><p class="kicker2 moedwhen">${icon('calendar', 'ico sm')}<span>זמני השנה</span></p><h2 class="sh">${esc(m.title)}</h2><p class="shsub">${esc(m.lead)}</p><div class="grid moedtease">${teaserItems(c).map(([h, k, t, go]) => `<a class="card" href="${h}"><span class="mkind">${esc(k)}</span><h3>${esc(t)}</h3><span class="go">${go}</span></a>`).join('')}</div><p class="ctarow"><a class="btn" href="/moadim/${m.id}/">כל התכנים על ${esc(m.short)} ←</a></p></div></section>`;
}).join('');

export { moedTeasers };
