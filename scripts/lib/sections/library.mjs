// Library index, kuntresim, book pages and the book reader.
import { esc, url, nik, read, write, lib, catName } from '../core.mjs';
import { icon, orn, phead, layout } from '../layout.mjs';
import { seasonHtml, seasonPools } from '../seasonal.mjs';
import { ps, ld, absu, crumbs, facts, person, pagerHtml, bookText, kinds, btags, bookCard } from '../parts.mjs';
import { moedOfChapter, moedOfBook } from '../moadim.mjs';

// Library index: books first by "featured", then one section per category; the books of a series are one card there, leading to the
// series page (/library/<id>/) with a compact list of its volumes. A filter (words, and "read on the site" / "PDF") narrows the cards.
const series = lib.series || [], seriesOf = (b) => series.find((s) => s.id === b.series);
const seriesBooks = (s) => lib.books.filter((b) => b.series === s.id);
// a series card is not one link: its title goes to the series page, and a folded list links each volume (keeps them 3 clicks from home)
const seriesCard = (s) => {
  const bs = seriesBooks(s), unit = esc(s.unit || 'ספרים');
  return `<div class="card book series" data-t="${esc([s.title, s.sub, ...(s.keywords || []), ...bs.map(bookText)].join(' '))}" data-k="${kinds(bs)}">${icon('books', 'ico lg')}<h3><a href="/library/${s.id}/">${esc(s.title)}</a></h3><p>${esc(s.sub)}</p><span class="btags"><span class="btag cnt">${bs.length} ${unit}</span>${bs.every((b) => b.text) ? '<span class="btag web">קריאה באתר</span>' : ''}${bs.every((b) => b.pdf) ? '<span class="btag">PDF</span>' : ''}</span><details class="svols"><summary>רשימת ה${unit}</summary>${(s.groups || [{ books: bs.map((b) => b.slug) }]).map((g) => `${g.title ? `<p class="sgh">${esc(g.title)}</p>` : ''}<ul>${g.books.map((slug) => bs.find((b) => b.slug === slug)).map((b) => `<li data-t="${esc(bookText(b))}"><a href="/library/${b.slug}/">${esc(shortTitle(s, b))}</a></li>`).join('')}</ul>`).join('')}</details><a class="go" href="/library/${s.id}/">לדף ${esc(s.title)} ←</a></div>`;
};
const shortTitle = (s, b) => b.title.replace(new RegExp(`^${s.title}[,:]?\\s*`), '') || b.title;
const onlineCard = ([, t, h, x]) => `<a class="card book" href="${url(h)}" data-t="${esc(`${t} ${x}`)}" data-k="web">${icon('letter', 'ico lg')}<h3>${esc(t)}</h3><p>${esc(x)}</p><span class="btags"><span class="btag web">קריאה באתר</span></span><span class="go">לקריאה באתר ←</span></a>`;
// a category lists its books in data order, a series in the place of its first book
const catItems = (c) => lib.books.filter((b) => b.category === c && (!b.series || seriesBooks(seriesOf(b))[0] === b)).map((b) => (b.series ? seriesCard(seriesOf(b)) : bookCard(b)));
const libCats = lib.categories.filter(([c]) => lib.books.some((b) => b.category === c) || lib.online.some(([oc]) => oc === c));
const featured = (lib.featured || []).map((f) => lib.books.find((b) => b.slug === f));
// "By holiday": a chip per occasion of library.json, each to its hub page (/moadim/<id>/), or to its main book when it has none (in the order of the year)
const occasionNav = (lib.occasions || []).length ? `<nav class="chips lchips moadim" aria-label="לפי מועדי השנה"><span class="chiplabel">לפי חג:</span>${lib.occasions.filter((o) => o.hub || o.books.length).map((o) => `<a href="${o.hub ? `/moadim/${o.hub}/` : `/library/${o.books[0]}/`}">${esc(o.title)}</a>`).join('')}</nav>` : '';
const kfilter = `<div class="kfilter" role="group" aria-label="סוג" hidden><button type="button" data-kf="" aria-pressed="true">הכול</button><button type="button" data-kf="web" aria-pressed="false">לקריאה באתר</button><button type="button" data-kf="pdf" aria-pressed="false">PDF להורדה</button></div>`;
const cfilter = (label, withKinds, hint = 'שם הספר או נושא…') => `<div class="cfilter"><label class="slabel" for="cf">${label}</label><input id="cf" type="search" data-cfilter placeholder="${hint}" autocomplete="off">${withKinds ? kfilter : ''}</div>`;
for (const [id, rows] of Object.entries(seasonPools())) write(`season/${id}.json`, JSON.stringify(rows));
write('library/index.html', layout('ספרייה', `${seasonHtml()}${featured.length ? `<section class="band" id="start" data-unfiltered><div class="wrap"><h2 class="sh">להתחיל כאן</h2><p class="shsub">ספרים מרכזיים, לקריאה מלאה באתר</p><div class="grid featured">${featured.map((b) => bookCard(b, ' feat')).join('')}</div></div></section>` : ''}
<section class="band${featured.length ? ' soft' : ''}" id="all"><div class="wrap"><h2 class="sh">כל הספרים</h2>${cfilter('חיפוש בספרייה', true)}${occasionNav}${libCats.length > 1 ? `<nav class="chips lchips anchors" aria-label="קטגוריות">${libCats.map(([c, n]) => `<a href="#${c}">${esc(n)}</a>`).join('')}</nav>` : ''}
${libCats.map(([c, n]) => `<section class="libcat" id="${c}"><h2 class="subh">${icon('book', 'ico')}${esc(n)}</h2><div class="grid">${catItems(c).join('')}${lib.online.filter(([oc]) => oc === c).map(onlineCard).join('')}</div></section>`).join('')}<p class="cnone" hidden>לא נמצא ספר שמתאים. נסו מילה אחרת.</p></div></section>
<section class="band" id="soon"><div class="wrap"><h2 class="sh">בקרוב בספרייה</h2><p class="shsub">ספרים נוספים של מוהרא״ש שיתווספו בהדרגה</p><ul class="chips2 soonlist">${lib.soon.map(([c, t]) => `<li>${esc(t)} <small>${esc(catName[c])}</small></li>`).join('')}</ul></div></section>
<section class="band soft"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>כל ספר שנכנס לספרייה ומודפס, הוא זכות לכל מי שהשתתף.</span></span><span class="btn">להשתתפות ←</span></a></div></section>`,
  { desc: 'ספריית ספרי מוהרא״ש, הצדיק מיבנאל: ספרים לקריאה ולהורדה בחינם', path: '/library/', full: true, head: phead('מוהרא״ש · הצדיק מיבנאל', 'ספרייה', esc(lib.intro)),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: 'ספרייה', description: lib.intro, hasPart: lib.books.map((b) => ({ '@type': 'Book', name: b.title, author: person, ...(absu(`/library/${b.slug}/`) ? { url: absu(`/library/${b.slug}/`) } : {}) })) }, crumbs([['בית', '/'], ['ספרייה', '/library/']])] }) }));
// Series pages: the volumes as a short list, each row a link to the book's own page
for (const s of series) {
  const bs = seriesBooks(s), base = `/library/${s.id}/`, sameSub = bs.every((b) => b.sub === bs[0].sub);
  const row = (b) => `<li data-t="${esc(bookText(b))}"><a href="/library/${b.slug}/"><b>${esc(shortTitle(s, b))}</b>${sameSub ? '' : `<span>${esc(b.sub)}</span>`}${btags(b)}</a></li>`;
  write(`library/${s.id}/index.html`, layout(s.title, `<section class="band"><div class="wrap narrow">${bs.length > 12 ? cfilter(`חיפוש ב${esc(s.unit || 'ספרים')}`, false) : ''}${s.groups ? `<nav class="chips lchips" aria-label="חלוקה">${s.groups.map((g) => `<a href="#${g.id}">${esc(g.title)}</a>`).join('')}</nav>${s.groups.map((g) => `<section class="libcat" id="${g.id}"><h2 class="subh">${icon('books', 'ico')}${esc(g.title)}</h2><ol class="slist">${g.books.map((slug) => row(bs.find((b) => b.slug === slug))).join('')}</ol></section>`).join('')}` : `<section class="libcat"><h2 class="subh">${icon('books', 'ico')}${bs.length} ${esc(s.unit || 'ספרים')}${sameSub ? ` · ${esc(bs[0].sub)}` : ''}</h2><ol class="slist">${bs.map(row).join('')}</ol></section>`}<p class="cnone" hidden>לא נמצא. נסו מילה אחרת.</p><p class="small"><a href="/library/#${s.category}">← לכל ספרי הספרייה</a></p></div></section>
<section class="band soft"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>לרפואה, לפרנסה, לזיווג או לעילוי נשמה, בהדפסת ספרי מוהרא״ש.</span></span><span class="btn">להשתתפות ←</span></a></div></section>`,
    { desc: `${s.title}: ${s.lead}`.slice(0, 155), path: '/library/', self: base, full: true, head: phead(`<a href="/library/">ספרייה</a> · ${esc(catName[s.category])}`, esc(s.title), esc(s.lead)),
      head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'BookSeries', name: s.title, description: s.lead, author: person, inLanguage: 'he', ...(absu(base) ? { url: absu(base) } : {}), hasPart: bs.map((b) => ({ '@type': 'Book', name: b.title, ...(absu(`/library/${b.slug}/`) ? { url: absu(`/library/${b.slug}/`) } : {}) })) }, crumbs([['בית', '/'], ['ספרייה', '/library/'], [s.title, base]])] }) }));
}

// Book reader: one page per section of every book with a text file (introduction, sections, closing prayer)
// Short kuntresim (data/kuntresim.json): one page grouped by topic, each item a PDF in site/books/kuntresim/
const kt = read('kuntresim.json');
// A kuntres that is also a book of the library ("book": its slug) leads to the book's page, which offers the kuntres too.
const kuntresCard = (k) => (k.book
  ? `<a class="card book" href="/library/${k.book}/">${icon('book', 'ico lg')}<h3>${esc(k.title)}</h3><p>${k.pages} עמודים · ${esc(k.size)}</p><span class="go">לקריאה באתר ולהורדה ←</span></a>`
  : `<a class="card book" href="/books/kuntresim/${k.slug}.pdf">${icon('book', 'ico lg')}<h3>${esc(k.title)}</h3><p>${k.pages} עמודים · ${esc(k.size)}</p><span class="go">קריאה והורדה · PDF ←</span></a>`);
for (const k of kt.items) if (k.book && !lib.books.some((b) => b.slug === k.book)) throw new Error(`kuntresim.json: "${k.slug}" names an unknown book "${k.book}"`);
// A topic with many items gets its own numbered pages (/library/kuntresim/<topic>/, .../page/<n>/); the small ones stay on the main page.
const KPER = 60, KBIG = 18;
const kItems = (g) => kt.items.filter((k) => k.group === g);
const kBig = new Set(kt.groups.filter(([g]) => kItems(g).length > KBIG).map(([g]) => g));
const kHref = (g) => (kBig.has(g) ? `/library/kuntresim/${g}/` : `/library/kuntresim/#${g}`);
const kChips = (cur) => `<nav class="chips lchips" aria-label="נושאים">${kt.groups.map(([g, n]) => `<a href="${kHref(g)}"${g === cur ? ' aria-current="page"' : ''}>${esc(n)}</a>`).join('')}</nav>`;
write('library/kuntresim/index.html', layout('קונטרסים', `<section class="band"><div class="wrap">${kChips('')}
${kt.groups.filter(([g]) => !kBig.has(g)).map(([g, n]) => `<section class="libcat" id="${g}"><h2 class="subh">${icon('book', 'ico')}${esc(n)}</h2><div class="grid">${kItems(g).map(kuntresCard).join('')}</div></section>`).join('')}
${kBig.size ? `<section class="libcat" id="more"><h2 class="subh">${icon('book', 'ico')}עוד נושאים</h2><div class="grid">${kt.groups.filter(([g]) => kBig.has(g)).map(([g, n]) => `<a class="card book" href="${kHref(g)}">${icon('book', 'ico lg')}<h3>${esc(n)}</h3><p>${kItems(g).length} קונטרסים</p><span class="go">לרשימה ←</span></a>`).join('')}</div></section>` : ''}</div></section>`,
  { desc: `קונטרסים של מוהרא״ש, הצדיק מיבנאל, לקריאה ולהורדה בחינם: ${kt.groups.map(([, n]) => n).join(', ')}.`, path: '/library/', self: '/library/kuntresim/', full: true, head: phead('מוהרא״ש · הצדיק מיבנאל', 'קונטרסים', esc(kt.intro)),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: 'קונטרסים', description: kt.intro }, crumbs([['בית', '/'], ['ספרייה', '/library/'], ['קונטרסים', '/library/kuntresim/']])] }) }));
for (const g of kBig) {
  const name = kt.groups.find(([x]) => x === g)[1], all = kItems(g), total = Math.ceil(all.length / KPER), base = `/library/kuntresim/${g}/`;
  for (let n = 1; n <= total; n++) {
    const items = all.slice((n - 1) * KPER, n * KPER), self = n === 1 ? base : `${base}page/${n}/`;
    write(`${self.slice(1)}index.html`, layout(n === 1 ? name : `${name} — עמוד ${n}`, `<section class="band"><div class="wrap">${kChips(g)}<div class="grid">${items.map(kuntresCard).join('')}</div>${pagerHtml(n, total, (x) => (x === 1 ? base : `${base}page/${x}/`))}<p class="small"><a href="/library/kuntresim/">← לכל נושאי הקונטרסים</a></p></div></section>`,
      { desc: (n === 1 ? `${name}: ${all.length} קונטרסים לקריאה ולהורדה בחינם.` : `${name}, עמוד ${n} מתוך ${total}: ${items.slice(0, 3).map((k) => k.title).join(' · ')}`).slice(0, 155), path: '/library/', self, full: true, head: phead('ספרייה · קונטרסים', esc(name), `${all.length} קונטרסים, עמוד ${n} מתוך ${total}.`),
        head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name, description: `${all.length} קונטרסים`, inLanguage: 'he' }, crumbs([['בית', '/'], ['ספרייה', '/library/'], ['קונטרסים', '/library/kuntresim/'], [name, base]])] }) }));
  }
}

const bookTexts = lib.books.filter((b) => b.text).map((b) => [b, read(b.text)]);
const fnText = (txt, key, labels) => esc(txt).replace(/\[([^\]\s]{1,4})\]/g, (m, l) => (labels.has(l) ? `<sup class="fn"><a href="#fn-${key}-${l}" id="fr-${key}-${l}" aria-label="הערה ${l}">${l}</a></sup>` : m));
// Hebrew numerals ("תתרעב" = 1072) for the printed indexes of a book: each number after a dash becomes a link to that section.
const GEM = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };
const gematria = (s) => [...s].reduce((a, ch) => a + (GEM[ch] || 0), 0);
const NUMTOK = /(^|[\s.])(ת{0,2}[קרש]?(?:טו|טז|[יכלמנסעפצ]?[א-ט]?))(?=[.\s]|$)/g;
const indexLine = (p, base, refs) => {
  const e = esc(p);
  if (/^[א-ת]$/.test(p)) return `<h3 class="ixh">${e}</h3>`;
  if (!p.includes('–') && p.length < 40 && !/[.)]$/.test(p) && !/^[א-ת]{1,5}\./.test(p)) return `<h3 class="ixs">${e}</h3>`;
  const link = (run) => run.replace(NUMTOK, (mm, pre, tok) => (tok && refs.get(gematria(tok)) ? `${pre}<a href="${base}${refs.get(gematria(tok))}/">${tok}</a>` : mm));
  // a long entry wraps onto a line that starts with the numbers themselves
  const cont = !p.includes('–') && /^ת{0,2}[קרש]?(?:טו|טז|[יכלמנסעפצ]?[א-ט]?)\./.test(p);
  const linked = cont ? link(e) : e.replace(/(–\s*)([^()]*)/g, (m, dash, run) => dash + link(run));
  return `<p class="ix">${linked}</p>`;
};
// Links to the times of the year (/moadim/): under a section that belongs to a holiday, and at the end of a book's contents.
const moedBox = (slug, k) => moedOfChapter(slug, k).map((m) => `<a class="moedbox" href="/moadim/${m.id}/">${icon('calendar', 'ico lg')}<span><b>עוד על ${esc(m.short)} באתר</b><small>${esc(m.title)}: שיחות, ספרים, מכתבים ושאלות ותשובות</small></span><i class="arr">${icon('arrow', 'ico sm')}</i></a>`).join('');
const moedLinks = (slug) => {
  const ms = moedOfBook(slug);
  return ms.length ? `<p class="moedlinks">${icon('calendar', 'ico sm')}<span>${ms.length > 1 ? 'לפי זמני השנה' : 'עוד באתר'}:</span> ${ms.map((m) => `<a href="/moadim/${m.id}/">${esc(m.title)}</a>`).join(' · ')}</p>` : '';
};
// A book's parts ([title, description, [from, to], unit?] over the section numbers) are its table of contents. Parts named only by
// their range ("קונטרסים א–י", "כל הקונטרסים") say nothing about the content, so a short book with only such parts shows one flat list.
const TOC_OPEN = 80;   // up to this many sections every part is shown open; a bigger book folds its parts and gets a filter
const generic = (t) => /^(כל |(קונטרסים|פרקים|סיפורים|סימנים) [א-ת״"]+–[א-ת״"]+$)/.test(t);
const bookParts = (bk, tx) => {
  const ps = bk.parts || [];
  return tx.sections.length <= TOC_OPEN && ps.every(([t]) => generic(t)) ? [] : ps;
};
const partAt = (parts, i) => parts.findIndex(([, , [f, t]]) => i >= f && i <= t);
const readerPages = (bk, tx) => {
  const base = `/library/${bk.slug}/`, parts = bookParts(bk, tx), unitPl = tx.unitPlural || 'סעיפים';
  const refs = new Map();
  tx.sections.forEach((x) => { if (x.ref && !refs.has(x.ref)) refs.set(x.ref, x.n); });
  const chapters = [
    { id: 'hakdama', label: tx.intro.label || 'הקדמה', title: tx.intro.title, paras: tx.intro.paras, notes: tx.intro.notes, heading2: tx.intro.heading2 },
    ...tx.sections.map((x) => ({ id: String(x.id ?? x.n), label: x.unit === '' ? x.label : `${x.unit ?? tx.unit ?? 'סעיף'} ${x.label}`, title: x.title.replace(/[.\s]+$/, ''), paras: x.paras, notes: x.notes, index: x.index, subs: new Set(x.subs || []) })),
    ...(tx.tikkun ? [{ id: 'tikkun-haklali', label: 'נספח', title: tx.tikkun.title, paras: tx.tikkun.paras, notes: [], tikkun: true }] : []),
  ];
  chapters.forEach((c, k) => {
    const prev = chapters[k - 1], next = chapters[k + 1], url = `${base}${c.id}/`, labels = new Set(c.notes.map(([l]) => l));
    const body = c.tikkun
      ? c.paras.map((p) => (/^\[הערה\]/.test(p) ? `<p class="tnote">${esc(p.replace(/^\[הערה\]\s*/, ''))}</p>` : /^מזמור/.test(p) ? `<h2 class="psalm">${esc(p.replace(/\.$/, ''))}</h2>` : p.length < 60 && /:$/.test(p) ? `<p class="inst">${esc(p)}</p>` : p.length < 50 ? `<p class="opening">${esc(p)}</p>` : `<p>${esc(p)}</p>`)).join('')
      : c.index ? c.paras.map((p) => indexLine(p, base, refs)).join('')
      : c.paras.map((p) => (p === c.heading2 || c.subs?.has(p) ? `<h2 class="subt">${esc(p)}</h2>` : `<p>${fnText(p, c.id, labels)}</p>`)).join('');
    const notes = c.notes.length ? `<aside class="fnotes" aria-label="הערות"><h2>הערות</h2><ol>${c.notes.map(([l, t]) => `<li id="fn-${c.id}-${l}"><b>${l}</b><span>${fnText(t, c.id, labels)} <a href="#fr-${c.id}-${l}" aria-label="חזרה לטקסט">${icon('up', 'ico sm')}</a></span></li>`).join('')}</ol></aside>` : '';
    const pk = partAt(parts, k), part = parts[pk], pHref = part ? `${base}#p${pk + 1}` : `${base}#toc`;
    const sibs = part ? chapters.slice(part[2][0], part[2][1] + 1) : [];
    const inPart = sibs.length > 1 && sibs.length <= 20 ? `<aside class="inpart" aria-label="${esc(part[0])}"><h2>${esc(part[0])} <small>${sibs.indexOf(c) + 1} מתוך ${sibs.length}</small></h2><ol class="toc">${sibs.map((x) => `<li><a href="${base}${x.id}/"${x === c ? ' aria-current="page"' : ''}><b>${esc(x.label)}</b><span>${esc(x.title)}</span></a></li>`).join('')}</ol></aside>` : '';
    const moed = moedBox(bk.slug, k);
    const topNav = (x, cls, arrow) => (x ? `<a class="${cls}" href="${base}${x.id}/" title="${esc(nik(x.title))}">${arrow}</a>` : '');
    const navLink = (x, cls, arrow) => (x ? `<a class="${cls}" href="${base}${x.id}/"><small>${arrow}</small>${esc(x.label)}: ${esc(nik(x.title)).slice(0, 70)}</a>` : '<span></span>');
    write(`library/${bk.slug}/${c.id}/index.html`, layout(`${nik(c.title)} | ${bk.title}`, `<article class="qa" data-book="${bk.slug}" data-ch="${esc(c.label)}"><div class="tools" role="group" aria-label="כלי קריאה"><a class="tbtn toc" href="${pHref}">${icon('menu', 'ico sm')}תוכן</a><button type="button" class="tbtn" data-fs="-1" aria-label="הקטנת טקסט">א־</button><button type="button" class="tbtn big" data-fs="1" aria-label="הגדלת טקסט">א+</button><button type="button" class="tbtn" data-nikud aria-pressed="false">ניקוד</button><button type="button" class="tbtn share" data-share>${icon('share', 'ico sm')}שיתוף</button></div>
<nav class="qtop" aria-label="מעבר בין ה${esc(unitPl)}">${topNav(prev, 'prev', `→ ${prev ? esc(prev.label) : ''}`)}${topNav(next, 'next', `${next ? esc(next.label) : ''} ←`)}</nav>
<div class="sheet book-sheet">${body}${notes}${orn}</div>${moed}${inPart}
<nav class="qnav" aria-label="ניווט בספר">${navLink(prev, 'prev', '→ הקודם')}${navLink(next, 'next', 'הבא ←')}</nav></article>`,
      { desc: `${bk.title}, ${c.label}: ${nik(c.title)}. ${nik(c.paras.find((p) => p.length > 80) || c.paras[0] || '').slice(0, 110)}`, path: '/library/', self: url, reading: true,
        head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="/library/">ספרייה</a> · <a href="${base}">${esc(bk.title)}</a>${part ? ` · <a href="${pHref}">${esc(part[0])}</a>` : ''}</p><h1>${esc(c.label)}</h1><p class="sub csum">${esc(c.title)}</p></div></section>`,
        head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Chapter', name: nik(c.title), position: k, isPartOf: { '@type': 'Book', name: bk.title, author: person, ...(absu(base) ? { url: absu(base) } : {}) }, inLanguage: 'he', ...(absu(url) ? { url: absu(url) } : {}) }, crumbs([['בית', '/'], ['ספרייה', '/library/'], [bk.title, base], [c.label, url]])] }) }));
  });
  return chapters;
};
// What the reader really offers for a book: vocalised text only when most of it is, notes only when it has some
const readNote = (tx) => {
  const all = [tx.intro, ...tx.sections], paras = all.flatMap((c) => c.paras);
  const vocal = paras.filter((p) => /[\u05B0-\u05C7]/.test(p)).length > paras.length / 2, noted = all.some((c) => (c.notes || []).length);
  return `הספר המלא באתר${vocal ? ', מנוקד' : ''}${noted ? ', עם הערות' : ''}`;
};
const bookChapters = Object.fromEntries(bookTexts.map(([bk, tx]) => [bk.slug, readerPages(bk, tx)]));
// Library: one page per book in data/library.json, and an index grouped by category
// The book's contents, first on its page: the introduction, then each part (a chip row jumps to it). Up to TOC_OPEN sections the
// parts are open lists; a bigger book folds them (the part with the last section read opens) and gets a filter by words.
const tocHtml = (bk, chs, tx) => {
  const base = `/library/${bk.slug}/`, parts = bookParts(bk, tx), unitPl = tx.unitPlural || 'סעיפים', big = tx.sections.length > TOC_OPEN;
  const li = (c) => `<li data-t="${esc(`${c.label} ${nik(c.title)}`)}"><a href="${base}${c.id}/"><b>${esc(c.label)}</b><span>${esc(c.title)}</span></a></li>`;
  const count = (from, to, cnt) => `${to - from + 1} ${esc(cnt || unitPl)}`;
  // a book with groups of parts (data/library.json "groups": [title, description, [first part, last part]]) shows each group
  // with its parts folded, so a long book reads as a short list of topics; a part opens to its sections
  const groups = parts.length ? bk.groups || [] : [], fold = big || groups.length > 0;
  const partHtml = ([t, d, [from, to], cnt], i) => (fold
    ? `<details class="tocpart libcat" id="p${i + 1}"><summary><span class="tn">${i + 1}</span><b>${esc(t)}</b><small>${count(from, to, cnt)}</small><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>${d && groups.length ? `<p class="tocdesc">${esc(d)}</p>` : ''}<ol class="toc">${chs.slice(from, to + 1).map(li).join('')}</ol></details>`
    : `<section class="tocsec libcat" id="p${i + 1}"><h3 class="tocpart"><span>${i + 1}</span>${esc(t)}<small>${count(from, to, cnt)}</small></h3>${d ? `<p class="tocdesc">${esc(d)}</p>` : ''}<ol class="toc">${chs.slice(from, to + 1).map(li).join('')}</ol></section>`);
  const flat = `<section class="libcat"><ol class="toc">${chs.slice(1, tx.sections.length + 1).map(li).join('')}</ol></section>`;
  const sub = groups.length ? `${tx.sections.length} ${esc(unitPl)} ב־${groups.length} חלקים ו־${parts.length} נושאים. לחצו על נושא כדי לפתוח אותו` : parts.length > 1 ? `${tx.sections.length} ${esc(unitPl)} ב־${parts.length} חלקים${big ? '. לחצו על חלק כדי לפתוח אותו' : ''}` : `${tx.sections.length} ${esc(unitPl)}`;
  const groupHtml = ([t, d, [a, z]], gi) => `<section class="tocgroup" id="g${gi + 1}"><h3 class="tocgh">${esc(t)}<small>${parts.slice(a, z + 1).reduce((n, [, , [f, l]]) => n + l - f + 1, 0)} ${esc(unitPl)}</small></h3>${d ? `<p class="tocdesc">${esc(d)}</p>` : ''}${parts.slice(a, z + 1).map((pt, k) => partHtml(pt, a + k)).join('')}</section>`;
  const nav = groups.length > 1 ? `<nav class="chips lchips anchors tocnav" aria-label="חלקי הספר">${groups.map(([t], i) => `<a href="#g${i + 1}">${esc(t)}</a>`).join('')}</nav>`
    : parts.length > 1 && parts.length <= 14 ? `<nav class="chips lchips anchors" aria-label="חלקי הספר">${parts.map(([t], i) => `<a href="#p${i + 1}">${esc(t)}</a>`).join('')}</nav>` : '';
  return `<section class="band" id="toc"><div class="wrap narrow"><h2 class="sh">תוכן העניינים</h2><p class="shsub">${sub}</p><p class="continue" data-continue="${bk.slug}" hidden></p>
${nav}${fold ? cfilter(`חיפוש ב${esc(unitPl)}`, false, 'מילה מהכותרת…') : ''}
<ol class="toc"><li><a href="${base}hakdama/"><b>${esc(chs[0].label)}</b><span>${esc(bk.introDesc || chs[0].title)}</span></a></li></ol>
${groups.length ? groups.map(groupHtml).join('') : parts.length ? parts.map(partHtml).join('') : flat}${fold ? '<p class="cnone" hidden>לא נמצא. נסו מילה אחרת.</p>' : ''}
${tx.tikkun ? `<h3 class="tocpart"><span>${icon('sparkle', 'ico sm')}</span>נספח</h3><ol class="toc"><li><a href="${base}tikkun-haklali/"><b>תיקון הכללי</b><span>עשרת המזמורים של רבי נחמן מברסלב</span></a></li></ol>` : ''}${moedLinks(bk.slug)}</div></section>`;
};
// The printed booklets of a book (data/books/<slug>.json "booklets": title, pdf, pages, size, part), for download, by topic:
// in the order of "bookletTopics" (else of the book's parts, then any other topic), each topic one folded row.
const bookletsHtml = (bk, tx) => {
  const bs = tx.booklets || [];
  if (!bs.length) return '';
  // a single booklet: one download row, no topics to fold
  if (bs.length === 1) return `<section class="band soft" id="booklets"><div class="wrap narrow"><h2 class="sh">${esc(tx.bookletHeading || 'החוברת המודפסת')}</h2>${tx.bookletLead ? `<p class="shsub">${esc(tx.bookletLead)}</p>` : ''}<ul class="toc blist">${bs.map((b) => `<li><a href="${b.pdf}" download>${icon('print', 'ico sm')}<span>${esc(b.title)}</span><small>PDF · ${b.pages} עמ׳ · ${esc(b.size)}</small></a></li>`).join('')}</ul></div></section>`;
  const order = [...(tx.bookletTopics || (bk.parts || []).map(([t]) => t))];
  for (const b of bs) if (!order.includes(b.part)) order.push(b.part);
  const rows = order.map((t) => [t, bs.filter((b) => b.part === t)]).filter(([, xs]) => xs.length);
  return `<section class="band soft" id="booklets"><div class="wrap narrow"><h2 class="sh">החוברות המודפסות</h2><p class="shsub">${bs.length} חוברות להורדה, לפי הנושאים</p>
${rows.map(([t, xs]) => `<details class="tocpart"><summary><b>${esc(t)}</b><small>${xs.length} ${xs.length === 1 ? 'חוברת' : 'חוברות'}</small><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><ul class="toc blist">${xs.map((b) => `<li><a href="${b.pdf}" download>${icon('print', 'ico sm')}<span>${esc(b.title)}</span><small>PDF · ${b.pages} עמ׳ · ${esc(b.size)}</small></a></li>`).join('')}</ul></details>`).join('')}</div></section>`;
};
// The ways to read a book ("ways" in library.json: { title, desc, read } or { title, desc, pdf, pages, size, label }), side by side under
// its title, so a visitor sees at once that it is on the site, in a scan and in print. A PDF opens to view and can be downloaded.
const waysHtml = (bk) => `<section class="band" id="ways"><div class="wrap"><h2 class="sh">${esc(bk.waysTitle || 'דרכים לקרוא את הספר')}</h2><div class="ways">${bk.ways.map((w) => `<div class="card way"><span class="wic">${icon(w.read ? 'book' : w.icon || 'print', 'ico lg')}</span><h3>${esc(w.title)}</h3><p>${esc(w.desc)}</p>${w.pdf ? `<p class="small wmeta">${w.pages} עמודים · <bdi>PDF, ${esc(w.size)}</bdi></p>` : ''}<div class="navbtns">${w.read ? `<a class="btn" href="${w.read}">לקריאה באתר ←</a>` : `<a class="btn" href="${w.pdf}" target="_blank" rel="noopener">צפייה</a><a class="btn ghost" href="${w.pdf}" download aria-label="הורדת ${esc(w.title)}">הורדה</a>`}</div></div>`).join('')}</div></div></section>`;
// the same ways as one row of buttons (the book's facts box and its closing band)
const waysBtns = (bk) => `<div class="navbtns">${bk.ways.map((w, i) => (w.read ? `<a class="btn" href="${w.read}">${icon('book', 'ico sm')}קריאה באתר</a>` : `<a class="btn${i ? ' ghost' : ''}" href="${w.pdf}" target="_blank" rel="noopener">${icon(w.icon || 'print', 'ico sm')}${esc(w.label || w.title)}</a>`)).join('')}</div>`;
for (const bk of lib.books) {
  const bookUrl = `/library/${bk.slug}/`, chs = bookChapters[bk.slug], sr = seriesOf(bk);
  // a book in a series links to its series and to the volumes before and after it
  const sbs = sr ? seriesBooks(sr) : [], si = sbs.indexOf(bk);
  const sNav = sr ? `<nav class="qnav snav" aria-label="${esc(sr.title)}: ${esc(sr.unit || 'ספרים')} נוספים">${[[sbs[si - 1], 'prev', '→ הקודם'], [sbs[si + 1], 'next', 'הבא ←']].map(([x, cls, arrow]) => (x ? `<a class="${cls}" href="/library/${x.slug}/"><small>${arrow}</small>${esc(x.title)}</a>` : '<span></span>')).join('')}</nav>` : '';
  const sCrumb = sr ? [[sr.title, `/library/${sr.id}/`]] : [];
  const pdfBtns = `<div class="navbtns"><a class="btn" href="${bk.pdf}" target="_blank" rel="noopener">${icon('book', 'ico sm')}קריאה בספר</a><a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}הורדה (PDF, ${bk.pdfSize})</a></div>`;
  write(`library/${bk.slug}/index.html`, layout(bk.title, `${bk.ways ? waysHtml(bk) : ''}${chs ? tocHtml(bk, chs, bookTexts.find(([b]) => b === bk)[1]) + (bk.ways ? '' : bookletsHtml(bk, bookTexts.find(([b]) => b === bk)[1])) : ''}
<section class="band${chs ? ' soft' : ''}"><div class="wrap"><div class="bio-top"><div class="about lead1">${ps(bk.about)}</div><aside class="factbox" aria-label="פרטי הספר"><h2>${esc(bk.title)}</h2>${facts([['סוג', catName[bk.category]], ...bk.facts])}<div class="fbtns">${bk.ways ? waysBtns(bk) : chs ? `<div class="navbtns"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a>${bk.pdf ? `<a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}PDF (${bk.pdfSize})</a>` : ''}</div>` : pdfBtns}</div></aside></div></div></section>
${bk.parts && !chs ? `<section class="band soft" id="contents"><div class="wrap"><h2 class="sh">מה בספר</h2><p class="shsub">${bk.parts.length} חלקים</p><div class="steps3 six">${bk.parts.map(([t, x], i) => `<div class="card"><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(x)}</p></div>`).join('')}</div></div></section>` : ''}
${bk.noCopyright ? `<section class="band quoteband"><div class="wrap"><p class="kicker2">על הדפסת ספריו</p><blockquote class="pq small"><p>${esc(bk.noCopyright)}</p><cite>${esc(bk.noCopyrightBy)}</cite></blockquote></div></section>` : ''}
<section class="band" id="dedicate"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>לרפואה, לפרנסה, לזיווג או לעילוי נשמה, בהדפסת ספרי מוהרא״ש.</span></span><span class="btn">להשתתפות ←</span></a></div></section>
<section class="band final" id="read"><div class="wrap narrow"><h2>לקריאה ולהורדה</h2><p>${chs ? `${readNote(bookTexts.find(([b]) => b === bk)[1])}${bk.pdf ? ', ולהורדה כ־PDF' : ''}.` : 'הספר המלא, כפי שיצא לאור, בחינם.'}</p>${bk.ways ? waysBtns(bk) : chs ? `<div class="navbtns"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a>${bk.pdf ? `<a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}הורדה (PDF, ${bk.pdfSize})</a>` : ''}</div>` : pdfBtns}${sNav}<p class="small">${sr ? `<a href="/library/${sr.id}/">← לכל ה${esc(sr.unit || 'ספרים')} של ${esc(sr.title)}</a> · ` : ''}<a href="/library/">לכל ספרי הספרייה</a></p></div></section>`,
    { desc: `${bk.title}: ${bk.lead}`, path: '/library/', self: bookUrl, full: true,
      head: phead(`<a href="/library/">ספרייה</a> · ${sr ? `<a href="/library/${sr.id}/">${esc(sr.title)}</a>` : esc(catName[bk.category])}`, esc(bk.title), esc(bk.lead), chs ? `<div class="navbtns hcta"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a>${bk.ways ? '<a class="btn ghost" href="#ways">בכתב יד ובדפוס</a>' : '<a class="btn ghost" href="#toc">תוכן העניינים</a>'}</div>` : `<div class="navbtns hcta"><a class="btn" href="${bk.pdf}" target="_blank" rel="noopener">${icon('book', 'ico sm')}קריאה בספר</a><a class="btn ghost" href="${bk.parts ? '#contents' : '#read'}">${bk.parts ? 'מה בספר' : 'הורדה'}</a></div>`),
      head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Book', name: bk.title, author: person, inLanguage: 'he', description: bk.lead, genre: catName[bk.category], bookFormat: 'https://schema.org/EBook', ...(bk.pages ? { numberOfPages: bk.pages } : {}), isAccessibleForFree: true, ...(absu(bookUrl) ? { url: absu(bookUrl), ...(bk.pdf ? { workExample: { '@type': 'Book', bookFormat: 'https://schema.org/EBook', encodingFormat: 'application/pdf', url: absu(bk.pdf) } } : {}) } : {}) }, crumbs([['בית', '/'], ['ספרייה', '/library/'], ...sCrumb, [bk.title, bookUrl]])] }) }));
}

export { bookChapters };
