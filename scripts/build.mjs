// Static site generator: data/*.json -> dist/
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';

const SITE = 'היכל הקודש';
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, ''); // e.g. /Web when served from a sub-path
const rebase = (h) => (BASE ? h.replace(/(href|src|action)="\//g, `$1="${BASE}/`) : h);
const PER_PAGE = 40;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nik = (s) => s.replace(/[֑-ׇ]/g, '');
const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const write = (p, c) => { mkdirSync(`dist/${p.split('/').slice(0, -1).join('/')}`, { recursive: true }); writeFileSync(`dist/${p}`, p.endsWith('.html') ? rebase(c) : c); };

const shut = read('shut.json').filter((x) => x.kind === 'shut');
const letters = read('shut.json').filter((x) => x.kind === 'letters');
const halacha = read('halacha.json');
const institutions = read('institutions.json');
const yeshiva = JSON.parse(readFileSync(new URL('../data/yeshiva.json', import.meta.url), 'utf8'));

const nav = [['/', 'בית'], ['/yeshiva/', 'ישיבת בית מנחם'], ['/shut/', 'שו״ת ברסלב'], ['/halacha/', 'שו״ת הלכתי'], ['/institutions/', 'מוסדות הקהילה'], ['/search/', 'חיפוש']];
const layout = (title, body, { desc = '', path = '/' } = {}) => `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${title === SITE ? '' : ' | ' + SITE}</title><meta name="description" content="${esc(desc || 'היכל הקודש: חסידות ברסלב, שאלות ותשובות, הלכה ומוסדות הקהילה')}">
<link rel="stylesheet" href="/style.css"></head><body>
<header class="top"><a class="brand" href="/"><span>${SITE}<small>חסידות ברסלב</small></span></a><nav>${nav.map(([h, t]) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav></header>
<main>${body}</main>
<footer><p>התוכן נכתב על ידי הצדיק מיבניאל זצ״ל, ופורסם ברשות להעתקה והפצה.</p></footer></body></html>`;

const card = (x) => `<a class="card" href="/shut/${x.id}/"><h3>${esc(x.title)}</h3><p>${esc(x.a.find((p) => p.length > 60) || x.a[0]).slice(0, 150)}…</p></a>`;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync(new URL('../site/', import.meta.url), 'dist', { recursive: true });

// Q&A pages
for (const x of shut) {
  write(`shut/${x.id}/index.html`, layout(x.title, `<article class="qa"><p class="crumb"><a href="/shut/">שו״ת ברסלב</a>${x.date ? ' · ' + esc(x.date) : ''}</p>
<h1>${esc(x.title)}</h1>${x.q.length ? `<section class="q"><h2>השאלה</h2>${x.q.map((p) => `<p>${esc(p)}</p>`).join('')}</section>` : ''}
<section class="a"><h2>התשובה</h2>${x.a.map((p) => `<p>${esc(p)}</p>`).join('')}</section></article>`, { desc: x.a.join(' ').slice(0, 155), path: '/shut/' }));
}

// Paginated list
const pages = Math.ceil(shut.length / PER_PAGE);
for (let p = 1; p <= pages; p++) {
  const items = shut.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const pager = `<div class="pager">${p > 1 ? `<a href="${p === 2 ? '/shut/' : `/shut/page/${p - 1}/`}">→ הקודם</a>` : '<span></span>'}<span>עמוד ${p} מתוך ${pages}</span>${p < pages ? `<a href="/shut/page/${p + 1}/">הבא ←</a>` : '<span></span>'}</div>`;
  write(p === 1 ? 'shut/index.html' : `shut/page/${p}/index.html`, layout('שו״ת ברסלב', `<h1>שו״ת ברסלב</h1><p class="lead">${shut.length.toLocaleString('he-IL')} שאלות ותשובות. <a href="/search/">חיפוש בכל השו״ת</a></p><div class="grid">${items.map(card).join('')}</div>${pager}`, { path: '/shut/' }));
}

// Yeshiva
const y = yeshiva, c = y.contact;
write('yeshiva/index.html', layout('ישיבת בית מנחם', `<section class="yhero"><img src="/img/logo.jpg" alt="${esc(y.name)} - ${esc(y.subtitle)}"><p class="banner">${esc(y.banner)}</p></section>
<h1>על הישיבה</h1><div class="about">${y.about.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
<h2>הדרך שלנו</h2><div class="grid">${y.values.map(([t, d]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
<h2>גלריה</h2>${y.photos.length ? `<div class="gallery">${y.photos.map((f) => `<img loading="lazy" src="${esc(f)}" alt="">`).join('')}</div>` : '<div class="empty"><p>התמונות יתווספו בקרוב.</p></div>'}
<h2>יצירת קשר ותמיכה</h2><div class="card contact">${[c.phone && `<p>טלפון: <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></p>`, c.email && `<p>דוא״ל: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>`, c.address && `<p>כתובת: ${esc(c.address)}</p>`, c.donate && `<p><a class="btn" href="${esc(c.donate)}" rel="noopener">לתרומה לישיבה</a></p>`].filter(Boolean).join('') || '<p>פרטי הקשר יתווספו בקרוב.</p>'}</div>`, { desc: 'בית מנחם, ישיבה חסידית. בחורים הלומדים בהתמדה בדרך הצדיק', path: '/yeshiva/' }));

// Halacha
write('halacha/index.html', layout('שו״ת הלכתי', `<h1>שו״ת הלכתי</h1><p class="lead">שאלות ותשובות בהלכה.</p>
${halacha.length ? `<div class="grid">${halacha.map((x) => `<a class="card" href="/halacha/"><h3>${esc(x.title)}</h3></a>`).join('')}</div>` : `<div class="empty"><p>המדור בבנייה. השאלות וההלכות יתווספו בקרוב.</p><p class="small">להוספת תוכן: ערכו את הקובץ <code>data/halacha.json</code>.</p></div>`}`, { path: '/halacha/' }));

// Institutions
write('institutions/index.html', layout('מוסדות הקהילה', `<h1>מוסדות הקהילה</h1><p class="lead">מוסדות תורה וחסד שזקוקים לתמיכתכם.</p>
<div class="grid">${institutions.map((i) => `<div class="card inst"><h3>${esc(i.name)}</h3><p>${esc(i.desc)}</p>${i.goal ? `<p class="goal">${esc(i.goal)}</p>` : ''}<p>${i.link ? `<a class="btn" href="${esc(i.link)}" rel="noopener">לתרומה</a>` : ''}${i.phone ? ` <a class="btn ghost" href="tel:${esc(i.phone)}">${esc(i.phone)}</a>` : ''}</p></div>`).join('')}</div>`, { path: '/institutions/' }));

// Search
write('search/index.html', layout('חיפוש', `<h1>חיפוש בשו״ת</h1><input id="q" type="search" placeholder="הקלידו מילה או ביטוי…" autofocus><p id="count" class="small"></p><div id="results" class="grid"></div><script src="/search.js"></script>`, { path: '/search/' }));
write('search-index.json', JSON.stringify(shut.map((x) => [x.id, x.title, nik((x.title + ' ' + x.q.join(' ') + ' ' + x.a.join(' ')).slice(0, 600))])));

// Home
const letterNote = letters.length ? '' : '';
write('index.html', layout(SITE, `<section class="hero"><h1>היכל הקודש</h1><p class="kicker">חסידות ברסלב</p><p>${shut.length.toLocaleString('he-IL')} שאלות ותשובות בדרכה של חסידות ברסלב: אמונה, תפילה, התבודדות ושמחה.</p>
<form action="/search/" class="hsearch"><input name="q" type="search" placeholder="מה מעסיק אתכם?"><button>חיפוש</button></form></section>
<section class="tiles"><a href="/yeshiva/"><b>ישיבת בית מנחם</b><span>ישיבה חסידית</span></a><a href="/shut/"><b>שו״ת ברסלב</b><span>עיון בכל השאלות</span></a><a href="/halacha/"><b>שו״ת הלכתי</b><span>שאלות בהלכה</span></a><a href="/institutions/"><b>מוסדות הקהילה</b><span>תמיכה ותרומות</span></a></section>
<h2>שאלות אחרונות</h2><div class="grid">${shut.slice(0, 6).map(card).join('')}</div>${letterNote}`, { path: '/' }));

write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/yeshiva/', '/shut/', '/halacha/', '/institutions/', ...shut.map((x) => `/shut/${x.id}/`)].map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`);
if (BASE) {
  const f = 'dist/search.js';
  writeFileSync(f, readFileSync(f, 'utf8').replace("'/search-index.json'", `'${BASE}/search-index.json'`).replace('`/shut/${id}/`', `\`${BASE}/shut/\${id}/\``));
}
console.log(`built ${shut.length} Q&A pages, ${pages} list pages`);
