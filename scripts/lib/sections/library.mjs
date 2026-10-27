// Library index, kuntresim, book pages and the book reader.
import { esc, nik, read, write, lib, catName } from '../core.mjs';
import { icon, orn, phead, layout } from '../layout.mjs';
import { ps, ld, absu, crumbs, facts, person } from '../parts.mjs';

const libCats = lib.categories.filter(([c]) => lib.books.some((b) => b.category === c) || lib.online.some(([oc]) => oc === c));
write('library/index.html', layout('ספרייה', `<section class="band"><div class="wrap">${libCats.length > 1 ? `<nav class="chips lchips" aria-label="קטגוריות">${libCats.map(([c, n]) => `<a href="#${c}">${esc(n)}</a>`).join('')}</nav>` : ''}
${libCats.map(([c, n]) => `<section class="libcat" id="${c}"><h2 class="subh">${icon('book', 'ico')}${esc(n)}</h2><div class="grid">${lib.books.filter((b) => b.category === c).map((b) => `<a class="card book" href="/library/${b.slug}/">${icon('book', 'ico lg')}<h3>${esc(b.title)}</h3><p>${esc(b.sub)}</p><span class="go">${b.text ? 'לקריאה באתר ←' : 'לספר · PDF ←'}</span></a>`).join('')}${lib.online.filter(([oc]) => oc === c).map(([, t, h, x]) => `<a class="card book" href="${h}">${icon('letter', 'ico lg')}<h3>${esc(t)}</h3><p>${esc(x)}</p><span class="go">לקריאה באתר ←</span></a>`).join('')}</div></section>`).join('')}</div></section>
<section class="band soft" id="soon"><div class="wrap"><h2 class="sh">בקרוב בספרייה</h2><p class="shsub">ספרים נוספים של מוהרא״ש שיתווספו בהדרגה</p><ul class="chips2 soonlist">${lib.soon.map(([c, t]) => `<li>${esc(t)} <small>${esc(catName[c])}</small></li>`).join('')}</ul></div></section>
<section class="band"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>כל ספר שנכנס לספרייה ומודפס, הוא זכות לכל מי שהשתתף.</span></span><span class="btn">להשתתפות ←</span></a></div></section>`,
  { desc: 'ספריית ספרי מוהרא״ש, הצדיק מיבנאל: ספרים לקריאה ולהורדה בחינם', path: '/library/', full: true, head: phead('מוהרא״ש · הצדיק מיבנאל', 'ספרייה', esc(lib.intro)),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: 'ספרייה', description: lib.intro, hasPart: lib.books.map((b) => ({ '@type': 'Book', name: b.title, author: person, ...(absu(`/library/${b.slug}/`) ? { url: absu(`/library/${b.slug}/`) } : {}) })) }, crumbs([['בית', '/'], ['ספרייה', '/library/']])] }) }));

// Book reader: one page per section of every book with a text file (introduction, sections, closing prayer)
// Short kuntresim (data/kuntresim.json): one page grouped by topic, each item a PDF in site/books/kuntresim/
const kt = read('kuntresim.json');
write('library/kuntresim/index.html', layout('קונטרסים', `<section class="band"><div class="wrap"><nav class="chips lchips" aria-label="נושאים">${kt.groups.map(([g, n]) => `<a href="#${g}">${esc(n)}</a>`).join('')}</nav>
${kt.groups.map(([g, n]) => `<section class="libcat" id="${g}"><h2 class="subh">${icon('book', 'ico')}${esc(n)}</h2><div class="grid">${kt.items.filter((k) => k.group === g).map((k) => `<a class="card book" href="/books/kuntresim/${k.slug}.pdf">${icon('book', 'ico lg')}<h3>${esc(k.title)}</h3><p>${k.pages} עמודים · ${esc(k.size)}</p><span class="go">קריאה והורדה · PDF ←</span></a>`).join('')}</div></section>`).join('')}</div></section>`,
  { desc: `קונטרסים קצרים של מוהרא״ש, הצדיק מיבנאל, לקריאה ולהורדה בחינם: ${kt.groups.map(([, n]) => n).join(', ')}.`, path: '/library/', self: '/library/kuntresim/', full: true, head: phead('מוהרא״ש · הצדיק מיבנאל', 'קונטרסים', esc(kt.intro)),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: 'קונטרסים', description: kt.intro }, crumbs([['בית', '/'], ['ספרייה', '/library/'], ['קונטרסים', '/library/kuntresim/']])] }) }));

const bookTexts = lib.books.filter((b) => b.text).map((b) => [b, read(b.text)]);
const fnText = (txt, key, labels) => esc(txt).replace(/\[([^\]\s]{1,4})\]/g, (m, l) => (labels.has(l) ? `<sup class="fn"><a href="#fn-${key}-${l}" id="fr-${key}-${l}" aria-label="הערה ${l}">${l}</a></sup>` : m));
const readerPages = (bk, tx) => {
  const base = `/library/${bk.slug}/`;
  const chapters = [
    { id: 'hakdama', label: 'הקדמה', title: tx.intro.title, paras: tx.intro.paras, notes: tx.intro.notes, heading2: tx.intro.heading2 },
    ...tx.sections.map((x) => ({ id: String(x.n), label: `סעיף ${x.label}`, title: x.title.replace(/[.\s]+$/, ''), paras: x.paras, notes: x.notes })),
    ...(tx.tikkun ? [{ id: 'tikkun-haklali', label: 'נספח', title: tx.tikkun.title, paras: tx.tikkun.paras, notes: [], tikkun: true }] : []),
  ];
  chapters.forEach((c, k) => {
    const prev = chapters[k - 1], next = chapters[k + 1], url = `${base}${c.id}/`, labels = new Set(c.notes.map(([l]) => l));
    const body = c.tikkun
      ? c.paras.map((p) => (/^\[הערה\]/.test(p) ? `<p class="tnote">${esc(p.replace(/^\[הערה\]\s*/, ''))}</p>` : /^מזמור/.test(p) ? `<h2 class="psalm">${esc(p.replace(/\.$/, ''))}</h2>` : p.length < 60 && /:$/.test(p) ? `<p class="inst">${esc(p)}</p>` : p.length < 50 ? `<p class="opening">${esc(p)}</p>` : `<p>${esc(p)}</p>`)).join('')
      : c.paras.map((p) => (p === c.heading2 ? `<h2 class="subt">${esc(p)}</h2>` : `<p>${fnText(p, c.id, labels)}</p>`)).join('');
    const notes = c.notes.length ? `<aside class="fnotes" aria-label="הערות"><h2>הערות</h2><ol>${c.notes.map(([l, t]) => `<li id="fn-${c.id}-${l}"><b>${l}</b><span>${fnText(t, c.id, labels)} <a href="#fr-${c.id}-${l}" aria-label="חזרה לטקסט">↩</a></span></li>`).join('')}</ol></aside>` : '';
    const navLink = (x, cls, arrow) => (x ? `<a class="${cls}" href="${base}${x.id}/"><small>${arrow}</small>${esc(x.label)}: ${esc(nik(x.title)).slice(0, 70)}</a>` : '<span></span>');
    write(`library/${bk.slug}/${c.id}/index.html`, layout(`${nik(c.title)} | ${bk.title}`, `<article class="qa" data-book="${bk.slug}" data-ch="${esc(c.label)}"><div class="tools" role="group" aria-label="כלי קריאה"><a class="tbtn toc" href="${base}#toc">${icon('menu', 'ico sm')}תוכן</a><button type="button" class="tbtn" data-fs="-1" aria-label="הקטנת טקסט">א־</button><button type="button" class="tbtn big" data-fs="1" aria-label="הגדלת טקסט">א+</button><button type="button" class="tbtn" data-nikud aria-pressed="false">ניקוד</button><button type="button" class="tbtn share" data-share>${icon('share', 'ico sm')}שיתוף</button></div>
<div class="sheet book-sheet">${body}${notes}${orn}</div>
<nav class="qnav" aria-label="ניווט בספר">${navLink(prev, 'prev', '→ הקודם')}${navLink(next, 'next', 'הבא ←')}</nav></article>`,
      { desc: `${bk.title}, ${c.label}: ${nik(c.title)}. ${nik(c.paras.find((p) => p.length > 80) || c.paras[0] || '').slice(0, 110)}`, path: '/library/', self: url, reading: true,
        head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="/library/">ספרייה</a> · <a href="${base}">${esc(bk.title)}</a> </p><h1>${esc(c.label)}</h1><p class="sub csum">${esc(c.title)}</p></div></section>`,
        head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Chapter', name: nik(c.title), position: k, isPartOf: { '@type': 'Book', name: bk.title, author: person, ...(absu(base) ? { url: absu(base) } : {}) }, inLanguage: 'he', ...(absu(url) ? { url: absu(url) } : {}) }, crumbs([['בית', '/'], ['ספרייה', '/library/'], [bk.title, base], [c.label, url]])] }) }));
  });
  return chapters;
};
const bookChapters = Object.fromEntries(bookTexts.map(([bk, tx]) => [bk.slug, readerPages(bk, tx)]));
// Library: one page per book in data/library.json, and an index grouped by category
for (const bk of lib.books) {
  const bookUrl = `/library/${bk.slug}/`, chs = bookChapters[bk.slug];
  const pdfBtns = `<div class="navbtns"><a class="btn" href="${bk.pdf}" target="_blank" rel="noopener">${icon('book', 'ico sm')}קריאה בספר</a><a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}הורדה (PDF, ${bk.pdfSize})</a></div>`;
  write(`library/${bk.slug}/index.html`, layout(bk.title, `<section class="band"><div class="wrap"><div class="bio-top"><div class="about lead1">${ps(bk.about)}</div><aside class="factbox" aria-label="פרטי הספר"><h2>${esc(bk.title)}</h2>${facts([['סוג', catName[bk.category]], ...bk.facts])}<div class="fbtns">${chs ? `<div class="navbtns"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a><a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}PDF (${bk.pdfSize})</a></div>` : pdfBtns}</div></aside></div></div></section>
${bk.parts ? `<section class="band soft" id="contents"><div class="wrap"><h2 class="sh">מה בספר</h2><p class="shsub">${bk.parts.length} חלקים</p><div class="steps3 six">${bk.parts.map(([t, x], i) => `<div class="card"><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(x)}</p></div>`).join('')}</div></div></section>` : ''}
${chs ? `<section class="band" id="toc"><div class="wrap narrow"><h2 class="sh">תוכן העניינים</h2><p class="shsub">לחצו על חלק כדי לראות את הסעיפים שבו</p><p class="continue" data-continue="${bk.slug}" hidden></p>
<ol class="toc"><li><a href="/library/${bk.slug}/hakdama/"><b>הקדמה</b><span>החלום שבעקבותיו החל לכתוב, ולמה נקרא הספר ״רגעי מוהרא״ש״</span></a></li></ol>
${bk.parts.map(([t, , [from, to]], i) => `<details class="tocpart"><summary><span class="tn">${i + 1}</span><b>${esc(t)}</b><small>${to - from + 1} סעיפים</small><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><ol class="toc">${chs.slice(from, to + 1).map((c) => `<li><a href="/library/${bk.slug}/${c.id}/"><b>${esc(c.label)}</b><span>${esc(c.title)}</span></a></li>`).join('')}</ol></details>`).join('')}
${bookTexts.find(([b]) => b === bk)?.[1].tikkun ? `<h3 class="tocpart"><span>✦</span>נספח</h3><ol class="toc"><li><a href="/library/${bk.slug}/tikkun-haklali/"><b>תיקון הכללי</b><span>עשרת המזמורים של רבי נחמן מברסלב</span></a></li></ol>` : ''}</div></section>` : ''}
${bk.noCopyright ? `<section class="band quoteband"><div class="wrap"><p class="kicker2">על הדפסת ספריו</p><blockquote class="pq small"><p>${esc(bk.noCopyright)}</p><cite>${esc(bk.noCopyrightBy)}</cite></blockquote></div></section>` : ''}
<section class="band" id="dedicate"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>לרפואה, לפרנסה, לזיווג או לעילוי נשמה, בהדפסת ספרי מוהרא״ש.</span></span><span class="btn">להשתתפות ←</span></a></div></section>
<section class="band final" id="read"><div class="wrap narrow"><h2>לקריאה ולהורדה</h2><p>${chs ? 'הספר המלא באתר, מנוקד, עם הערות, ולהורדה כ־PDF.' : 'הספר המלא, כפי שיצא לאור, בחינם.'}</p>${chs ? `<div class="navbtns"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a><a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}הורדה (PDF, ${bk.pdfSize})</a></div>` : pdfBtns}<p class="small"><a href="/library/">← לכל ספרי הספרייה</a></p></div></section>`,
    { desc: `${bk.title}: ${bk.lead}`, path: '/library/', self: bookUrl, full: true,
      head: phead(`ספרייה · ${catName[bk.category]}`, esc(bk.title), esc(bk.lead), chs ? `<div class="navbtns hcta"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a><a class="btn ghost" href="#toc">תוכן העניינים</a></div>` : `<div class="navbtns hcta"><a class="btn" href="${bk.pdf}" target="_blank" rel="noopener">${icon('book', 'ico sm')}קריאה בספר</a><a class="btn ghost" href="${bk.parts ? '#contents' : '#read'}">${bk.parts ? 'מה בספר' : 'הורדה'}</a></div>`),
      head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Book', name: bk.title, author: person, inLanguage: 'he', description: bk.lead, genre: catName[bk.category], bookFormat: 'https://schema.org/EBook', ...(bk.pages ? { numberOfPages: bk.pages } : {}), isAccessibleForFree: true, ...(absu(bookUrl) ? { url: absu(bookUrl), workExample: { '@type': 'Book', bookFormat: 'https://schema.org/EBook', encodingFormat: 'application/pdf', url: absu(bk.pdf) } } : {}) }, crumbs([['בית', '/'], ['ספרייה', '/library/'], [bk.title, bookUrl]])] }) }));
}

export { bookChapters };
