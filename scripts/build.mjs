// Static site generator: data/*.json -> dist/
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';

const SITE = 'היכל הקודש';
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, ''); // e.g. /Web when served from a sub-path
const rebase = (h) => (BASE ? h.replace(/(href|src|action)="\//g, `$1="${BASE}/`) : h);
const PER_PAGE = 40;
const BUILD = Date.now().toString(36);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nik = (s) => s.replace(/[֑-ׇ]/g, '');
const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const write = (p, c) => { mkdirSync(`dist/${p.split('/').slice(0, -1).join('/')}`, { recursive: true }); writeFileSync(`dist/${p}`, p.endsWith('.html') ? rebase(c) : c); };

const shut = read('shut.json').filter((x) => x.kind === 'shut');
const letters = read('shut.json').filter((x) => x.kind === 'letters');
const halacha = read('halacha.json');
const institutions = read('institutions.json');
const pr = read('print.json');
const yeshiva = JSON.parse(readFileSync(new URL('../data/yeshiva.json', import.meta.url), 'utf8'));

const nav = [['/', 'בית'], ['/print/', 'הדפסת אשר בנחל'], ['/yeshiva/', 'ישיבת בית מנחם'], ['/shut/', 'שו״ת ברסלב'], ['/halacha/', 'שו״ת הלכתי'], ['/institutions/', 'מוסדות הקהילה'], ['/search/', 'חיפוש']];
const ICON = {
  flame: '<path d="M12 2c.6 3.2 4.8 5.3 4.8 10.1A4.8 4.8 0 0 1 12 17a4.8 4.8 0 0 1-4.8-4.9c0-2.2 1.2-3.7 2.3-4.6 0 1.7.8 2.9 1.9 3.3C11 8.3 10.9 5 12 2Z"/><path d="M12 22c-2.8 0-5-1.2-5-2.7 0-.8.6-1.5 1.6-2"/><path d="M15.4 17.3c1 .5 1.6 1.2 1.6 2 0 1.5-2.2 2.7-5 2.7"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5"/><path d="M9 7h7M9 11h5"/>',
  scale: '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z"/><circle cx="12" cy="4" r="1"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/><path d="M12 6.5v2M11 7.5h2"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="2" y="9" width="20" height="9" rx="2"/><path d="M6 14h12v8H6z"/><path d="M18 12.5h.01"/>',
  heart: '<path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6a5 5 0 1 1 7.5 6.6Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  arrow: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
};
const icon = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const orn = `<div class="orn-rule" aria-hidden="true"><i></i>${icon('flame')}<i></i></div>`;
const phead = (kicker, title, lead = '', extra = '') => `<section class="phead"><div class="wrap">${kicker ? `<p class="kicker2">${kicker}</p>` : ''}<h1>${title}</h1>${lead ? `<p class="sub">${lead}</p>` : ''}${extra}</div></section>`;
const layout = (title, body, { desc = '', path = '/', head = '', full = false } = {}) => `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${title === SITE ? '' : ' | ' + SITE}</title><meta name="description" content="${esc(desc || 'היכל הקודש: חסידות ברסלב, שאלות ותשובות, הלכה ומוסדות הקהילה')}">
<meta name="theme-color" content="#0b1d50"><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0b1d50"/><g fill="none" stroke="#e6c466" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON.flame}</g></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Frank+Ruhl+Libre:wght@400;500;700;900&display=swap">
<link rel="stylesheet" href="/style.css?v=${BUILD}"></head><body>
<a class="skip" href="#main">דלגו לתוכן</a>
<header class="top"><div class="bar"><a class="brand" href="/"><span class="mark">${icon('flame')}</span><span>${SITE}<small>חסידות ברסלב</small></span></a><nav aria-label="ניווט ראשי">${nav.map(([h, t]) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${h === '/search/' ? icon('search', 'ico sm') : ''}${t}</a>`).join('')}</nav></div></header>
${head}${full ? `<div id="main">${body}</div>` : `<main id="main">${body}</main>`}
<footer class="foot"><div class="wrap"><div class="fbrand"><span class="mark">${icon('flame')}</span><div><b>${SITE}</b><span>אור הצדיק לכל נפש</span></div></div>
<nav aria-label="ניווט תחתון">${nav.slice(1).map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
<p>התוכן נכתב על ידי הצדיק מיבניאל זצ״ל, ופורסם ברשות להעתקה והפצה.</p></div></footer></body></html>`;

const card = (x) => `<a class="card qcard" href="/shut/${x.id}/"><h3>${esc(x.title)}</h3><p>${esc((x.a.find((p) => p.length > 60) || x.a[0]).slice(0, 150))}…</p><span class="go">לקריאת התשובה ←</span></a>`;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync(new URL('../site/', import.meta.url), 'dist', { recursive: true });

// Q&A pages
const para = (ps) => {
  // Short lines at the head of a letter (date, greeting) and at its end (blessing) are styled apart from the body.
  let i = 0, j = ps.length;
  while (i < Math.min(3, ps.length - 1) && ps[i].length < 50) i++;
  if (j - i > 1 && ps[j - 1].length < 60) j--;
  return [...ps.slice(0, i).map((p) => `<p class="opening">${esc(p)}</p>`), ...ps.slice(i, j).map((p) => `<p>${esc(p)}</p>`), ...ps.slice(j).map((p) => `<p class="closing">${esc(p)}</p>`)].join('');
};
shut.forEach((x, k) => {
  const prev = shut[k - 1], next = shut[k + 1];
  write(`shut/${x.id}/index.html`, layout(x.title, `<article class="qa"><div class="sheet">${x.q.length ? `<section class="q"><h2>השאלה</h2>${x.q.map((p) => `<p>${esc(p)}</p>`).join('')}</section>` : ''}
<section class="a">${x.q.length ? '<h2>התשובה</h2>' : ''}${para(x.a)}</section>${orn}</div>
<nav class="qnav" aria-label="שאלות סמוכות">${prev ? `<a class="prev" href="/shut/${prev.id}/"><small>→ השאלה הקודמת</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="/shut/${next.id}/"><small>השאלה הבאה ←</small>${esc(next.title)}</a>` : '<span></span>'}</nav></article>`,
  { desc: x.a.join(' ').slice(0, 155), path: '/shut/', head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="/shut/">שו״ת ברסלב</a>${x.date ? ' · ' + esc(x.date) : ''}</p><h1>${esc(x.title)}</h1></div></section>` }));
});

// Paginated list
const chips = ['אמונה', 'התבודדות', 'שמחה', 'תפילה', 'אומן', 'פרנסה', 'שלום בית'].map((t) => `<a href="/search/?q=${encodeURIComponent(t)}">${t}</a>`).join('');
const searchForm = `<form action="/search/" class="hsearch" role="search"><input name="q" type="search" placeholder="מה מעסיק אתכם? למשל: שמחה, התבודדות, פרנסה" aria-label="חיפוש בשו״ת"><button>${icon('search', 'ico sm')}חיפוש</button></form>`;
const pages = Math.ceil(shut.length / PER_PAGE);
for (let p = 1; p <= pages; p++) {
  const items = shut.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const pager = `<nav class="pager" aria-label="עמודים">${p > 1 ? `<a class="btn ghost" href="${p === 2 ? '/shut/' : `/shut/page/${p - 1}/`}">→ הקודם</a>` : '<span></span>'}<span>עמוד ${p} מתוך ${pages}</span>${p < pages ? `<a class="btn ghost" href="/shut/page/${p + 1}/">הבא ←</a>` : '<span></span>'}</nav>`;
  write(p === 1 ? 'shut/index.html' : `shut/page/${p}/index.html`, layout('שו״ת ברסלב', `<div class="grid">${items.map(card).join('')}</div>${pager}`, { path: '/shut/', head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות בעבודת ה׳, באמונה ובדרכו של רבינו הקדוש.`, searchForm) }));
}

// Yeshiva
const y = yeshiva, c = y.contact;
write('yeshiva/index.html', layout('ישיבת בית מנחם', `<section class="band"><div class="wrap narrow"><h2 class="sh">על הישיבה</h2>${orn}<div class="about">${y.about.map((p) => `<p>${esc(p)}</p>`).join('')}</div></div></section>
<section class="band soft"><div class="wrap"><h2 class="sh">הדרך שלנו</h2><p class="shsub">ארבעה יסודות שעליהם עומד יום הלימוד בישיבה</p><div class="needs values">${y.values.map(([t, d]) => `<div class="need"><span class="orn">✦</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
<section class="band"><div class="wrap"><h2 class="sh">גלריה</h2>${y.photos.length ? `<div class="gallery">${y.photos.map((f) => `<img loading="lazy" src="${esc(f)}" alt="">`).join('')}</div>` : '<div class="empty"><p>התמונות יתווספו בקרוב.</p></div>'}</div></section>
<section class="band final"><div class="wrap"><h2>יצירת קשר ותמיכה</h2><p>שותפות בהחזקת הישיבה היא שותפות בכל דף שנלמד בה.</p><div class="contact">${[c.phone && `<p>טלפון: <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></p>`, c.email && `<p>דוא״ל: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>`, c.address && `<p>כתובת: ${esc(c.address)}</p>`, c.donate && `<p class="ctarow"><a class="btn big" href="${esc(c.donate)}" rel="noopener">לתרומה לישיבה</a></p>`].filter(Boolean).join('') || '<p class="small">פרטי הקשר יתווספו בקרוב.</p>'}</div></div></section>`,
  { desc: 'בית מנחם, ישיבה חסידית. בחורים הלומדים בהתמדה בדרך הצדיק', path: '/yeshiva/', full: true, head: `<section class="phead yhero"><div class="wrap"><div class="emblem"><img src="/img/logo.jpg" width="760" height="636" alt="${esc(y.name)} - ${esc(y.subtitle)}"></div><p class="kicker2">${esc(y.banner)}</p><h1>ישיבת ${esc(y.name)}</h1><p class="sub">${esc(y.subtitle)} בדרך רבינו הקדוש רבי נחמן מברסלב</p></div></section>` }));

// Halacha
write('halacha/index.html', layout('שו״ת הלכתי', `${halacha.length ? `<div class="grid">${halacha.map((x) => `<a class="card" href="/halacha/"><h3>${esc(x.title)}</h3></a>`).join('')}</div>` : `<div class="empty">${icon('scale', 'ico lg')}<h2>המדור בבנייה</h2><p>השאלות וההלכות יתווספו בקרוב.</p><p class="small">להוספת תוכן: ערכו את הקובץ <code>data/halacha.json</code>.</p><p><a class="btn" href="/shut/">בינתיים, לשו״ת ברסלב</a></p></div>`}`, { path: '/halacha/', head: phead('הלכה למעשה', 'שו״ת הלכתי', 'שאלות ותשובות בהלכה, בבירור ובפשטות.') }));

// Institutions
write('institutions/index.html', layout('מוסדות הקהילה', `<div class="grid insts">${institutions.map((i) => `<div class="card inst">${icon('heart', 'ico')}<h3>${esc(i.name)}</h3><p>${esc(i.desc)}</p>${i.goal ? `<p class="goal">${esc(i.goal)}</p>` : ''}<p class="acts">${i.link ? `<a class="btn" href="${esc(i.link)}" rel="noopener">לתרומה</a>` : ''}${i.phone ? ` <a class="btn ghost" href="tel:${esc(i.phone)}">${esc(i.phone)}</a>` : ''}</p></div>`).join('')}</div>`, { path: '/institutions/', head: phead('צדקה וחסד', 'מוסדות הקהילה', 'מוסדות תורה וחסד שזקוקים לתמיכתכם.') }));

// Print campaign: Asher BaNachal
const pd = pr.donate;
const h = pr.hero;
const money = (n) => Number(n).toLocaleString('he-IL');
const donateBox = () => pd.iframeUrl
  ? `<div class="donbox" id="donate"><h2 class="donhead">התרומה שלכם מתחילה כאן</h2><iframe title="תרומה באשראי" src="${esc(pd.iframeUrl)}" loading="lazy" allow="payment" referrerpolicy="no-referrer" style="width:100%;height:900px;min-height:80vh"></iframe>${pd.fallbackUrl ? `<p class="ctarow"><a class="btn big" href="${esc(pd.fallbackUrl)}" rel="noopener" target="_blank">פתחו את טופס התרומה במסך מלא</a></p>` : ''}</div>`
  : pd.fallbackUrl
    ? `<div class="donbox soon" id="donate"><p><a class="btn big" href="${esc(pd.fallbackUrl)}" rel="noopener">לתרומה באשראי</a></p></div>`
    : `<div class="donbox soon" id="donate"><p>טופס התרומה באשראי יופעל בקרוב.</p>${pd.phone ? `<p><a href="tel:${esc(pd.phone)}">${esc(pd.phone)}</a></p>` : ''}</div>`;
const cta = (t = 'אני רוצה להצטרף להדפסה') => `<a class="btn big glow" href="/print/donate/">${t}</a>`;
const trust = `<ul class="trust">${pr.trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const g = pr.goal || {};
const goal = g.target ? `<div class="goal-bar"><div class="gb-top"><b>${esc(g.label || 'התקדמות ההדפסה')}</b><span>${money(g.raised)} מתוך ${money(g.target)} ₪</span></div><div class="gb-track"><i style="width:${Math.min(100, Math.round((g.raised / g.target) * 100))}%"></i></div></div>` : '';
const tierCards = (link) => `<div class="tiers2">${pr.tiers.map((t) => `<a class="tier2${t.tag ? ' pick' : ''}" href="${link}">${t.tag ? `<em>${esc(t.tag)}</em>` : ''}<b class="amt">${t.amount ? money(t.amount) + ' ₪' : 'סכום חופשי'}</b><h3>${esc(t.name)}</h3><p>${esc(t.desc)}</p><span class="go">לתרומה ←</span></a>`).join('')}</div>`;
const stick = `<div class="stickcta"><a class="btn big glow" href="/print/donate/">להצטרף להדפסה</a></div>`;
const sect = (cls, inner) => `<section class="band ${cls}"><div class="wrap">${inner}</div></section>`;

const promiseBlock = `<blockquote class="pq"><p>${esc(pr.quote)}</p><cite>${esc(pr.quoteBy)}</cite></blockquote>`;

write('print/index.html', layout(pr.title, `<section class="phero2"><div class="wrap"><p class="kicker2">${esc(h.kicker)}</p><h1>${esc(h.headline)}</h1><p class="sub">${esc(h.sub)}</p><p class="ctarow">${cta()}</p>${trust}</div></section>
<section class="statrow"><div class="wrap">${pr.stats.map(([n, l]) => `<div><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('')}</div></section>
${sect('quoteband', promiseBlock + `<p class="ctarow"><a class="more" href="/print/promise/">לקריאה על ההבטחה ←</a></p>`)}
${sect('', `<h2 class="sh">מה זה ״אשר בנחל״</h2><div class="about">${pr.about.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`)}
${sect('soft', `<h2 class="sh">על מה מקדישים</h2><p class="shsub">לכל בקשה יש מקום בכרך. בחרו מה שעל ליבכם.</p><div class="needs">${pr.needs.map(([t, d2]) => `<div class="need"><span class="orn">✦</span><h3>${esc(t)}</h3><p>${esc(d2)}</p></div>`).join('')}</div>`)}
${sect('', `<h2 class="sh">בחרו את השותפות שלכם</h2><p class="shsub">כל סכום נחשב. כל סכום מחיה נפשות.</p>${goal}${tierCards('/print/donate/')}`)}
${sect('soft', `<h2 class="sh">שלושה צעדים פשוטים</h2><div class="steps2">${pr.steps.map(([t, d2], i) => `<div><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(d2)}</p></div>`).join('')}</div>`)}
${sect('final', `<h2>${esc(pr.finalCta.head)}</h2><p>${esc(pr.finalCta.sub)}</p><p class="ctarow">${cta('אני רוצה לתרום עכשיו')}</p>${trust}`)}
${sect('', `<h2 class="sh">שאלות נפוצות</h2>${pr.faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}`)}
${stick}`, { desc: h.sub, path: '/print/', full: true }));

write('print/promise/index.html', layout('ההבטחה והסגולה', `<section class="phero2 short"><div class="wrap"><p class="kicker2">ההבטחה</p><h1>מה הבטיח הצדיק</h1></div></section>
${sect('quoteband', promiseBlock)}
${sect('', `<div class="about promise">${pr.promiseText.map((p) => `<p>${esc(p)}</p>`).join('')}</div><p class="ctarow">${cta()}</p>${trust}`)}
${stick}`, { full: true, desc: 'ההבטחה בשם הצדיק מיבניאל זצ״ל למשתתפים בהדפסת אשר בנחל', path: '/print/' }));

write('print/donate/index.html', layout('תרומה להדפסת אשר בנחל', `<section class="phero2 short"><div class="wrap"><p class="kicker2">כמעט שם</p><h1>הצטרפו להדפסת אשר בנחל</h1><p class="sub">בחרו סכום, רשמו הקדשה, וסיימתם. התשלום מאובטח.</p>${trust}</div></section>
${sect('', `${goal}${tierCards('#donate')}${donateBox()}<p class="small center">התרומה היא להדפסת ספרי הצדיק והפצתם. אין בה התחייבות לתוצאה מסוימת.</p>`)}`, { full: true, desc: 'תרומה באשראי להדפסת אשר בנחל', path: '/print/' }));

// Search
write('search/index.html', layout('חיפוש', `<p id="count" class="small count" aria-live="polite"></p><div id="results" class="grid"></div><script src="/search.js"></script>`, { path: '/search/', head: phead('בכל אלפי השאלות', 'חיפוש בשו״ת', '', `<div class="hsearch">${icon('search', 'ico sm')}<input id="q" type="search" placeholder="הקלידו מילה או ביטוי…" aria-label="חיפוש" autofocus></div><div class="chips">${chips}</div>`) }));
write('search-index.json', JSON.stringify(shut.map((x) => [x.id, x.title, nik((x.title + ' ' + x.q.join(' ') + ' ' + x.a.join(' ')).slice(0, 600))])));

// Home
const tile = (href, ic, t, d) => `<a class="tile" href="${href}">${icon(ic, 'ico lg')}<b>${t}</b><span>${d}</span><i class="arr">${icon('arrow', 'ico sm')}</i></a>`;
write('index.html', layout(SITE, `<section class="band"><div class="wrap"><div class="tiles">
${tile('/shut/', 'book', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות`)}${tile('/yeshiva/', 'home', 'ישיבת בית מנחם', 'ישיבה חסידית')}${tile('/halacha/', 'scale', 'שו״ת הלכתי', 'שאלות בהלכה')}${tile('/institutions/', 'heart', 'מוסדות הקהילה', 'תמיכה ותרומות')}</div>
<a class="feature" href="/print/"><span class="fic">${icon('print', 'ico lg')}</span><span class="ftxt"><em>${esc(pr.hero.kicker)}</em><b>הדפסת ״אשר בנחל״</b><span>הצטרפו להדפסת ספרי הצדיק, והיו שותפים בכל עותק שמחזק עוד נפש.</span></span><span class="btn">להצטרפות ←</span></a></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq"><p>מצוה גדולה להיות בשמחה תמיד</p><cite>ליקוטי מוהר״ן תנינא, סימן כ״ד</cite></blockquote></div></section>
<section class="band soft"><div class="wrap"><h2 class="sh">מתוך השו״ת</h2><p class="shsub">שאלות שנשאלו ותשובות שנכתבו, מלב אל לב</p><div class="grid">${shut.slice(0, 6).map(card).join('')}</div><p class="ctarow"><a class="btn ghost" href="/shut/">לכל השאלות והתשובות ←</a></p></div></section>`,
{ path: '/', full: true, head: `<section class="phead hero"><div class="wrap"><span class="mark big">${icon('flame')}</span><p class="kicker2">חסידות ברסלב</p><h1>${SITE}</h1><p class="sub">שאלות ותשובות בדרכו של רבינו הקדוש רבי נחמן מברסלב: אמונה, תפילה, התבודדות ושמחה.</p>${searchForm}<div class="chips">${chips}</div></div></section>` }));

write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/print/', '/print/promise/', '/print/donate/', '/yeshiva/', '/shut/', '/halacha/', '/institutions/', ...shut.map((x) => `/shut/${x.id}/`)].map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`);
if (BASE) {
  const f = 'dist/search.js';
  writeFileSync(f, readFileSync(f, 'utf8').replace("'/search-index.json'", `'${BASE}/search-index.json'`).replace('`/shut/${id}/`', `\`${BASE}/shut/\${id}/\``));
}
console.log(`built ${shut.length} Q&A pages, ${pages} list pages`);
