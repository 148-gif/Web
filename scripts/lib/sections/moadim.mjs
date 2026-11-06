// Times of the year: /moadim/ lists the holidays in the order of the year, and /moadim/<id>/ gathers what the site has on one of them
// (data/moadim.json, scripts/lib/moadim.mjs): Moharash's talks and other book sections, whole books, pages of the site and Q&A.
// The home page's holiday band is the seasonal suggestion (scripts/lib/seasonal.mjs on its branch), not built here.
import { esc, write, lib, read } from '../core.mjs';
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

// What each holiday shows
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
