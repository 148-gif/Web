// Static site generator: data/*.json -> dist/
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SITE = 'היכל הקודש';
const BASE = (process.env.SITE_BASE || '').replace(/\/$/, ''); // e.g. /Web when served from a sub-path
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, ''); // e.g. https://user.github.io; sitemap URLs must be absolute
const rebase = (h) => (BASE ? h.replace(/(href|src|action)="\//g, `$1="${BASE}/`) : h);
const PER_PAGE = 40;
const FONTS = 'https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Frank+Ruhl+Libre:wght@400;700;900&display=swap';
const BUILD = Date.now().toString(36);
const esc = (s) => String(s).replace(/(\d+)–(\d+)/g, '\u2066$1–$2\u2069').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const write = (p, c) => { mkdirSync(`dist/${p.split('/').slice(0, -1).join('/')}`, { recursive: true }); writeFileSync(`dist/${p}`, p.endsWith('.html') ? rebase(c) : c); };

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

// Security policy. Inline scripts (head bootstrap, speculation rules) are allowed by hash.
// It also adds the stylesheet: normally parser-blocking, but on a first visit it loads without blocking paint
// behind the splash, which fades once the styles are in (class "ready").
const CSS_URL = `${BASE}/style.css?v=${BUILD}`;
const HEAD_JS = `var d=document.documentElement,u='${CSS_URL}',sp=0;d.classList.add('js');try{var rs=parseFloat(localStorage.getItem('rs'));if(rs>=0.85&&rs<=1.5)d.style.setProperty('--rs',rs);if(!sessionStorage.getItem('seen')){sp=1;sessionStorage.setItem('seen',1)}}catch(e){}if(sp){d.classList.add('splash');var l=document.createElement('link');l.rel='stylesheet';l.href=u;l.onload=l.onerror=function(){d.classList.add('ready')};document.head.appendChild(l)}else document.write('<link rel="stylesheet" href="'+u+'">')`;
// Prefetch same-site pages on hover/touch so navigation feels instant.
const SPEC = '{"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}]}';
const sha = (t) => `'sha256-${createHash('sha256').update(t).digest('base64')}'`;
const frames = [pr.donate.iframeUrl].filter(Boolean).map((u) => new URL(u).origin);
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${sha(HEAD_JS)} ${sha(SPEC)}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https:",
  "connect-src 'self'",
  `frame-src ${frames.join(' ') || "'none'"}`,
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const nav = [['/', 'בית', 'home'], ['/print/', 'הדפסת אשר בנחל', 'print'], ['/yeshiva/', 'ישיבת בית מנחם', 'school'], ['/shut/', 'שו״ת ברסלב', 'book'], ['/letters/', 'מכתבים', 'letter'], ['/halacha/', 'שו״ת הלכתי', 'scale'], ['/rabbi-nachman/', 'רבי נחמן', 'flame'], ['/uman/', 'אומן', 'pin'], ['/moharash/', 'הצדיק מיבנאל', 'flame'], ['/library/', 'ספרייה', 'book'], ['/yavniel/', 'יבנאל', 'pin'], ...(institutions.length ? [['/institutions/', 'מוסדות הקהילה', 'heart']] : []), ['/search/', 'חיפוש', 'search']];
// Organisation and contact details come from data/site.json; empty fields are simply left out.
const org = site.org || {}, sc = site.contact || {};
const orgLine = org.name ? esc(org.name) + (org.number ? ` · ע״ר ${esc(org.number)}` : '') + (org.section46 ? ' · התרומות מוכרות לצורכי מס לפי סעיף 46' : '') : '';
const wa = (n) => `https://wa.me/${tel(n).replace(/^\+/, '').replace(/^0/, '972')}`;
const contactList = (c) => [
  c.phone && ['phone', 'טלפון', `<a href="tel:${tel(c.phone)}">${esc(c.phone)}</a>`],
  c.whatsapp && ['chat', 'וואטסאפ', `<a href="${wa(c.whatsapp)}" rel="noopener">${esc(c.whatsapp)}</a>`],
  c.email && ['letter', 'דוא״ל', `<a href="${url('mailto:' + c.email, ['mailto:'])}">${esc(c.email)}</a>`],
  c.address && ['pin', 'כתובת', esc(c.address)],
  c.hours && ['clock', 'שעות מענה', esc(c.hours)],
].filter(Boolean);
const infoNav = [['/about/', 'אודות'], ['/contact/', 'צור קשר'], ['/accessibility/', 'הצהרת נגישות'], ['/privacy/', 'פרטיות ותנאי שימוש']];
const ICON = {
  flame: '<path d="M12 2c.6 3.2 4.8 5.3 4.8 10.1A4.8 4.8 0 0 1 12 17a4.8 4.8 0 0 1-4.8-4.9c0-2.2 1.2-3.7 2.3-4.6 0 1.7.8 2.9 1.9 3.3C11 8.3 10.9 5 12 2Z"/><path d="M12 22c-2.8 0-5-1.2-5-2.7 0-.8.6-1.5 1.6-2"/><path d="M15.4 17.3c1 .5 1.6 1.2 1.6 2 0 1.5-2.2 2.7-5 2.7"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5"/><path d="M9 7h7M9 11h5"/>',
  scale: '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z"/><circle cx="12" cy="4" r="1"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/><path d="M12 6.5v2M11 7.5h2"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="2" y="9" width="20" height="9" rx="2"/><path d="M6 14h12v8H6z"/><path d="M18 12.5h.01"/>',
  school: '<path d="M2 21h20M4 21V10l8-6 8 6v11"/><path d="M9 21v-5a3 3 0 0 1 6 0v5"/><path d="M12 7.5v3M10.5 9h3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  heart: '<path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6a5 5 0 1 1 7.5 6.6Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  arrow: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  letter: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  phone: '<path d="M5 3h3.5l1.7 4.3-2.2 1.4a11 11 0 0 0 7.3 7.3l1.4-2.2L21 15.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2Z"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  chat: '<path d="M4 19.5 5.3 15A8 8 0 1 1 8.6 18.4Z"/><path d="M9 10h6M9 13h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  drop: '<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
  nav: '<path d="M3 11 21 3l-8 18-2-8z"/>',
  meal: '<path d="M5 3v7a3 3 0 0 0 6 0V3M8 3v18"/><path d="M18 21V3c-2.2 1.4-3.5 4-3.5 7.5S15.8 14 18 14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.3A5 5 0 0 1 21.5 19"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  mountain: '<path d="m2 20 7-12 4 6.5 3-4.5 6 10z"/><circle cx="17" cy="6" r="1.8"/>',
};
const icon = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const orn = `<div class="orn-rule" aria-hidden="true"><i></i>${icon('flame')}<i></i></div>`;
const phead = (kicker, title, lead = '', extra = '') => `<section class="phead"><div class="wrap">${kicker ? `<p class="kicker2">${kicker}</p>` : ''}<h1>${title}</h1>${lead ? `<p class="sub">${lead}</p>` : ''}${extra}</div></section>`;
// First visit only: the stylesheet loads without blocking paint, and a branded splash shows until it is in.
const SPLASH_CSS = '#splash{display:none}.splash #splash{display:flex;position:fixed;inset:0;z-index:100;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:radial-gradient(120% 90% at 50% 0,#1a46a3,#0b1d50 55%,#071338);color:#e6c466;font:900 1.7rem/1.2 "Frank Ruhl Libre",David,serif;transition:opacity .45s;animation:spout .4s 6s forwards}#splash small{font:600 .8rem Assistant,Arial,sans-serif;letter-spacing:.14em;color:#c9d3ef}#splash .spm{width:88px;height:88px;border-radius:50%;display:grid;place-items:center;border:1.5px solid #e6c466;background:radial-gradient(circle at 50% 35%,#2a5bc4,#0d2466 70%);animation:spp 1.6s infinite}#splash svg{width:46px;height:46px}#splash i{width:140px;height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,#e6c466,transparent) 0 0/50% 100% no-repeat;animation:sps 1.1s ease-in-out infinite alternate}html.ready #splash{opacity:0;visibility:hidden;transition:opacity .45s,visibility 0s .45s}@keyframes spp{0%{box-shadow:0 0 0 0 rgba(230,196,102,.55)}70%,100%{box-shadow:0 0 0 20px rgba(230,196,102,0)}}@keyframes sps{to{background-position:100% 0}}@keyframes spout{to{opacity:0;visibility:hidden}}@media (prefers-reduced-motion:reduce){#splash,#splash *{animation:none!important}}';
const splash = `<div id="splash" aria-hidden="true"><span class="spm">${icon('flame')}</span><span>${SITE}</span><small>חסידות ברסלב</small><i></i></div>`;
const DESC = 'היכל הקודש: חסידות ברסלב, שאלות ותשובות, מכתבים, הלכה ומוסדות הקהילה';
// Share previews (WhatsApp, Facebook) need absolute URLs, so canonical/og:url/og:image appear only when SITE_ORIGIN is set.
const abs = (p) => esc(ORIGIN + BASE + p);
const layout = (title, body, { desc = '', path = '/', self = path, head = '', full = false, reading = false, head_extra = '', index = true } = {}) => `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="strict-origin-when-cross-origin"><script>${HEAD_JS}</script>
<title>${esc(nik(title))}${title === SITE ? '' : ' | ' + SITE}</title><meta name="description" content="${esc(nik(desc || DESC))}">${index ? '' : '<meta name="robots" content="noindex">'}
<meta name="theme-color" content="#0b1d50"><meta property="og:title" content="${esc(nik(title))}"><meta property="og:description" content="${esc(nik(desc || DESC))}"><meta property="og:site_name" content="${SITE}"><meta property="og:locale" content="he_IL"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">${ORIGIN && index ? `<link rel="canonical" href="${abs(self)}"><meta property="og:url" content="${abs(self)}"><meta property="og:image" content="${abs('/img/og.png')}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : ''}
<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/img/icon-180.png"><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0b1d50"/><g fill="none" stroke="#e6c466" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON.flame}</g></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<noscript><link rel="stylesheet" href="/style.css?v=${BUILD}"></noscript><style>${SPLASH_CSS}</style>
<link rel="stylesheet" href="${FONTS}" media="print" data-fonts><noscript><link rel="stylesheet" href="${FONTS}"></noscript>${head_extra}</head><body>
${splash}<a class="skip" href="#main">דלגו לתוכן</a>
<header class="top"><div class="bar"><a class="brand" href="/"><span class="mark">${icon('flame')}</span><span>${SITE}<small>חסידות ברסלב</small></span></a><div class="hacts"><a class="iconbtn" href="/search/" aria-label="חיפוש">${icon('search')}</a><button class="iconbtn mbtn" type="button" aria-expanded="false" aria-controls="mainnav" aria-label="תפריט">${icon('menu', 'ico i-open')}${icon('close', 'ico i-close')}</button></div><nav id="mainnav" aria-label="ניווט ראשי">${nav.map(([h, t, ic]) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${icon(ic, `ico sm${ic === 'search' ? ' keep' : ''}`)}${t}</a>`).join('')}</nav></div>${reading ? '<div class="readbar" aria-hidden="true"><i></i></div>' : ''}</header>
<main id="main">${head}${full ? body : `<div class="page">${body}</div>`}</main>
<footer class="foot"><div class="wrap"><div class="fbrand"><span class="mark">${icon('flame')}</span><div><b>${SITE}</b><span>אור הצדיק לכל נפש</span></div></div>
<nav aria-label="ניווט תחתון">${nav.slice(1, -1).map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
<nav class="finfo" aria-label="מידע על האתר">${infoNav.map(([h, t]) => `<a href="${h}"${h === self ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
<p>שו״ת ברסלב נכתב על ידי <a href="/moharash/">הצדיק מיבניאל זצ״ל</a>, ופורסם ברשות להעתקה והפצה.</p>${orgLine ? `<p>${orgLine}</p>` : ''}</div></footer><script src="/app.js?v=${BUILD}" defer></script><script type="speculationrules">{"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}]}</script></body></html>`;

const sr = (t) => `<h2 class="sr">${t}</h2>`;
const card = (x, base = '/shut/') => `<a class="card qcard" href="${base}${x.id}/"><h3>${esc(x.title)}</h3><p>${esc((x.a.find((p) => p.length > 60) || x.a[0]).slice(0, 150))}…</p><span class="go">לקריאת התשובה ←</span></a>`;

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
// One reading page per item; shared by shut, letters and halacha.
const readPages = (list, base, section, [prevL, nextL, navL]) => list.forEach((x, k) => {
  const prev = list[k - 1], next = list[k + 1];
  write(`${base.slice(1)}${x.id}/index.html`, layout(x.title, `<article class="qa"><div class="tools" role="group" aria-label="כלי קריאה"><span class="small">גודל טקסט</span><button type="button" class="tbtn" data-fs="-1" aria-label="הקטנת טקסט">א־</button><button type="button" class="tbtn big" data-fs="1" aria-label="הגדלת טקסט">א+</button><button type="button" class="tbtn share" data-share>${icon('share', 'ico sm')}שיתוף</button></div><div class="sheet">${x.q.length ? `<section class="q"><h2>השאלה</h2>${x.q.map((p) => `<p>${esc(p)}</p>`).join('')}</section>` : ''}
<section class="a">${x.q.length ? '<h2>התשובה</h2>' : ''}${para(x.a)}</section>${orn}</div>
<nav class="qnav" aria-label="${navL}">${prev ? `<a class="prev" href="${base}${prev.id}/"><small>→ ${prevL}</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${base}${next.id}/"><small>${nextL} ←</small>${esc(next.title)}</a>` : '<span></span>'}</nav></article>`,
  { desc: x.a.join(' ').slice(0, 155), path: base, self: `${base}${x.id}/`, reading: true, head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="${base}">${section}</a>${x.date ? ' · ' + esc(x.date) : ''}</p><h1>${esc(x.title)}</h1></div></section>` }));
});
readPages(shut, '/shut/', 'שו״ת ברסלב', ['השאלה הקודמת', 'השאלה הבאה', 'שאלות סמוכות']);
readPages(letters, '/letters/', 'מכתבים', ['המכתב הקודם', 'המכתב הבא', 'מכתבים סמוכים']);
readPages(halacha, '/halacha/', 'שו״ת הלכתי', ['השאלה הקודמת', 'השאלה הבאה', 'שאלות סמוכות']);

// Paginated list
const chips = ['אמונה', 'התבודדות', 'שמחה', 'תפילה', 'אומן', 'פרנסה', 'שלום בית'].map((t) => `<a href="/search/?q=${encodeURIComponent(t)}">${t}</a>`).join('');
const searchForm = `<form action="/search/" class="hsearch" role="search"><input name="q" type="search" placeholder="מה מעסיק אתכם? למשל: שמחה, התבודדות, פרנסה" aria-label="חיפוש בשו״ת"><button>${icon('search', 'ico sm')}חיפוש</button></form>`;
const pages = Math.ceil(shut.length / PER_PAGE);
for (let p = 1; p <= pages; p++) {
  const items = shut.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const pager = `<nav class="pager" aria-label="עמודים">${p > 1 ? `<a class="btn ghost" href="${p === 2 ? '/shut/' : `/shut/page/${p - 1}/`}">→ הקודם</a>` : '<span></span>'}<span>עמוד ${p} מתוך ${pages}</span>${p < pages ? `<a class="btn ghost" href="/shut/page/${p + 1}/">הבא ←</a>` : '<span></span>'}</nav>`;
  write(p === 1 ? 'shut/index.html' : `shut/page/${p}/index.html`, layout('שו״ת ברסלב', `${sr('רשימת השאלות')}<div class="grid">${items.map((x) => card(x)).join('')}</div>${pager}`, { path: '/shut/', self: p === 1 ? '/shut/' : `/shut/page/${p}/`, head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות בעבודת ה׳, באמונה ובדרכו של רבינו הקדוש.`, searchForm) }));
}

// Yeshiva
const y = yeshiva, c = y.contact;
write('yeshiva/index.html', layout('ישיבת בית מנחם', `<section class="band"><div class="wrap narrow"><h2 class="sh">על הישיבה</h2>${orn}<div class="about">${y.about.map((p) => `<p>${esc(p)}</p>`).join('')}</div></div></section>
<section class="band soft"><div class="wrap"><h2 class="sh">הדרך שלנו</h2><p class="shsub">ארבעה יסודות שעליהם עומד יום הלימוד בישיבה</p><div class="needs values">${y.values.map(([t, d]) => `<div class="need"><span class="orn">✦</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
${y.photos.length ? `<section class="band"><div class="wrap"><h2 class="sh">גלריה</h2><div class="gallery">${y.photos.map((f) => `<img loading="lazy" decoding="async" src="${url(f)}" alt="תמונה מהישיבה">`).join('')}</div></div></section>` : ''}
<section class="band final"><div class="wrap"><h2>יצירת קשר ותמיכה</h2><p>שותפות בהחזקת הישיבה היא שותפות בכל דף שנלמד בה.</p><div class="contact">${[c.phone && `<p>טלפון: <a href="tel:${tel(c.phone)}">${esc(c.phone)}</a></p>`, c.email && `<p>דוא״ל: <a href="${url('mailto:' + c.email, ['mailto:'])}">${esc(c.email)}</a></p>`, c.address && `<p>כתובת: ${esc(c.address)}</p>`, c.donate && `<p class="ctarow"><a class="btn big" href="${url(c.donate)}" rel="noopener">לתרומה לישיבה</a></p>`].filter(Boolean).join('') || '<p class="ctarow"><a class="btn big" href="/contact/">ליצירת קשר</a></p>'}</div></div></section>`,
  { desc: 'בית מנחם, ישיבה חסידית. בחורים הלומדים בהתמדה בדרך הצדיק', path: '/yeshiva/', full: true, head: `<section class="phead yhero"><div class="wrap"><div class="emblem"><img src="/img/logo.webp" width="760" height="636" fetchpriority="high" decoding="async" alt="${esc(y.name)} - ${esc(y.subtitle)}"></div><p class="kicker2">${esc(y.banner)}</p><h1>ישיבת ${esc(y.name)}</h1><p class="sub">${esc(y.subtitle)} בדרך רבינו הקדוש רבי נחמן מברסלב</p></div></section>` }));


// Yavniel and Malka mikveh pages
const ul = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;
const ps = (xs) => xs.map((p) => `<p>${esc(p)}</p>`).join('');
const navBtns = (q, cls = '') => `<div class="navbtns${cls}"><a class="btn" href="${url(`https://www.waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`)}" rel="noopener">${icon('nav', 'ico sm')}ניווט ב־Waze</a><a class="btn ghost" href="${url(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`)}" rel="noopener">${icon('pin', 'ico sm')}Google Maps</a></div>`;
const anchors = (xs) => `<nav class="chips" aria-label="בעמוד זה">${xs.map(([h, t]) => `<a href="#${h}">${t}</a>`).join('')}</nav>`;
const ysect = (id, cls, title, sub, body, narrow = true) => `<section class="band${cls ? ' ' + cls : ''}" id="${id}"><div class="wrap${narrow ? ' narrow' : ''}"><h2 class="sh">${title}</h2>${sub ? `<p class="shsub">${sub}</p>` : orn}${body}</div></section>`;
const sched = (gs) => `<div class="sgrid">${gs.map((g) => `<div class="scard"><h3>${esc(g.title)}</h3>${g.note ? `<p class="snote">${esc(g.note)}</p>` : ''}<dl>${g.rows.map(([t, p]) => `<div><dt>${esc(t)}</dt><dd>${esc(p)}</dd></div>`).join('')}</dl></div>`).join('')}</div>`;
const hours = (rows) => `<dl class="hrs">${rows.map(([t, v]) => `<div><dt>${esc(t)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
const statrow = (xs) => `<div class="statrow"><div class="wrap">${xs.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}</div></div>`;
const telA = (n) => `<a href="tel:${tel(n)}">${esc(n)}</a>`;

write('yavniel/index.html', layout('יבנאל', `${statrow(yv.stats)}
${ysect('history', '', 'על היישוב', '', `<div class="about lead1">${ps(yv.intro)}</div>`)}
<section class="band soft" id="timeline"><div class="wrap narrow"><h2 class="sh">מסע בזמן</h2><p class="shsub">תחנות בתולדות המושבה</p><ol class="tline">${yv.timeline.map(([t, d]) => `<li><b>${esc(t)}</b><p>${esc(d)}</p></li>`).join('')}</ol><p class="tnote">${esc(yv.livelihood)}</p></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq"><p>${esc(yv.nachman)}</p><cite>${esc(yv.nachmanBy)}</cite></blockquote></div></section>
${ysect('community', '', 'קהילת ברסלב ביבנאל', '', `<div class="about">${ps(yv.community)}</div>`)}
<section class="band soft"><div class="wrap"><h2 class="sh">מוסדות וחסד</h2><p class="shsub">מה שהקים מוהרא״ש ביבנאל</p><ul class="inst-list">${yv.institutions.map(([n, d]) => `<li>${icon('school', 'ico')}<span><b>${esc(n)}</b>${d ? `<small>${esc(d)}</small>` : ''}</span></li>`).join('')}</ul><div class="svc">${yv.chesed.map(([ic, t, d]) => `<div class="card">${icon(ic, 'ico lg')}<h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
${ysect('city', '', esc(yv.cityTitle), '', `<div class="about">${ps(yv.city)}</div>${yv.quotes.map(([q, by]) => `<figure class="letterq"><blockquote>${esc(q)}</blockquote><figcaption>${esc(by)}</figcaption></figure>`).join('')}`)}
<section class="band soft" id="zion"><div class="wrap narrow"><h2 class="sh">ציון הצדיק</h2>${orn}<div class="about">${ps(yv.zion)}</div><p class="navbtns"><a class="btn" href="/moharash/tziyun/">${icon('flame', 'ico sm')}לדף ציון מוהרא״ש</a><a class="btn ghost" href="/moharash/">על הצדיק מיבנאל</a></p><div class="vow"><span class="kicker2">${esc(yv.promiseNote.replace(/:$/, ''))}</span><p>${esc(yv.promise)}</p></div></div></section>
<section class="band" id="letters"><div class="wrap"><h2 class="sh">${esc(yv.fromShutTitle)}</h2><p class="shsub">${esc(yv.fromShutLead)}</p><div class="grid notes">${yv.fromShut.map(([t, ids]) => `<div class="card"><p>${esc(t)}</p><span class="go">${ids.map((i, n) => `<a href="/shut/${i}/">${ids.length > 1 ? `תשובה ${'אבג'[n]}׳` : 'לתשובה'} ←</a>`).join('')}</span></div>`).join('')}</div></div></section>
<section class="band soft" id="prayer"><div class="wrap"><h2 class="sh">זמני תפילה</h2><p class="shsub">${esc(yv.prayerNote)}</p><h3 class="subh">${icon('clock', 'ico')}ימי חול</h3>${sched(yv.weekday)}<p class="snote c">${esc(yv.weekdayNote)}</p><h3 class="subh">${icon('flame', 'ico')}שבת קודש</h3>${sched(yv.shabbat)}<p class="snote c">${esc(yv.shabbatNote)}</p></div></section>
<section class="band" id="lessons"><div class="wrap"><h2 class="sh">שיעורי תורה</h2><p class="shsub">שיעורים קבועים בבתי המדרש ובכוללים</p>${sched(yv.lessons)}<div class="card wide">${icon('users', 'ico lg')}<h3>אבות ובנים</h3><p>${esc(yv.fathers)}</p></div></div></section>
<section class="band soft" id="services"><div class="wrap"><h2 class="sh">מקוואות ושירותים</h2><p class="shsub">מה שכדאי לדעת לפני שמגיעים</p><div class="svc two">
<div class="card">${icon('drop', 'ico lg')}<h3>מקווה גברים</h3>${hours(yv.mikvehMen)}<p>${esc(yv.mikvehMenNote)}</p></div>
<a class="card hl" href="/mikveh-malka/">${icon('drop', 'ico lg')}<h3>מקווה נשים: מקווה מלכה</h3>${hours(yv.mikvehWomen)}<p>${esc(yv.mikvehWomenNote)}</p><span class="go">לדף המקווה, טלפונים וניווט ←</span></a>
<div class="card">${icon('meal', 'ico lg')}<h3>בית התבשיל ״אהל אברהם״</h3>${ps(yv.kitchen)}</div>
<div class="card">${icon('heart', 'ico lg')}<h3>ערב שמחה לנשים</h3><p>${esc(yv.womenEvening)}</p></div>
</div></div></section>
<section class="band final" id="visit"><div class="wrap narrow"><h2>מגיעים ליבנאל</h2><p>${esc(yv.directions)}</p>${navBtns(yv.navQuery)}</div></section>
<section class="band srcs"><div class="wrap narrow"><h2>מקורות</h2>${ul(yv.sources.map(([t, u]) => `<a href="${url(u)}" rel="noopener">${esc(t)}</a>`))}</div></section>`,
  { desc: 'יבנאל עיר ברסלב: תולדות המושבה, קהילת חסידי ברסלב, ציון מוהרא״ש, זמני תפילה, מקוואות ושיעורים', path: '/yavniel/', full: true, head: phead('הגליל התחתון · עיר ברסלב', 'יבנאל', esc(yv.lead), anchors([['history', 'היסטוריה'], ['community', 'הקהילה'], ['zion', 'הציון'], ['prayer', 'זמני תפילה'], ['services', 'מקוואות ושירותים'], ['visit', 'הגעה']])) }));

write('mikveh-malka/index.html', layout('מקווה מלכה', `<section class="band"><div class="wrap"><ul class="clist quick">
<li>${icon('phone', 'ico')}<span><b>טלפון במקווה</b>${telA(mk.phone)}</span></li>
<li>${icon('clock', 'ico')}<span><b>שעות פתיחה</b><a href="#hours">משקיעת החמה, בכל ערב</a></span></li>
<li>${icon('pin', 'ico')}<span><b>כתובת</b><a href="#visit">${esc(mk.address)}</a></span></li></ul>
<div class="wrap narrow about lead1 pad">${ps(mk.about)}</div>
<div class="feats">${mk.features.map(([ic, t, d]) => `<div>${icon(ic, 'ico lg')}<b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}</div></div></section>
<section class="band quoteband" id="promise"><div class="wrap"><p class="kicker2">${esc(mk.promiseTitle)}</p><blockquote class="pq small"><p>${esc(mk.promise)}</p><cite>מוהרא״ש זי״ע</cite></blockquote></div></section>
<section class="band"><div class="wrap"><h2 class="sh">ישועות</h2><p class="shsub">${esc(mk.promiseAfter)}</p><div class="svc tst">${mk.testimonials.map((t) => `<figure class="card"><span class="qm" aria-hidden="true">״</span><blockquote>${esc(t)}</blockquote></figure>`).join('')}</div></div></section>
${ysect('story', 'soft', esc(mk.storyTitle), '', `<div class="about">${ps(mk.story)}</div>`)}
<section class="band" id="answers"><div class="wrap narrow"><h2 class="sh">${esc(mk.fromShutTitle)}</h2><p class="shsub">${esc(mk.fromShutLead)}</p><div class="faqs">${mk.fromShut.map(([q, a, ids], n) => `<details class="faq"${n ? '' : ' open'}><summary>${esc(q)}</summary><p>${esc(a)}</p><p class="faqlinks">${ids.map((i, k) => `<a href="/shut/${i}/">${ids.length > 1 ? `תשובה ${'אבג'[k]}׳` : 'לתשובה המלאה'} ←</a>`).join('')}</p></details>`).join('')}</div></div></section>
<section class="band soft" id="hours"><div class="wrap narrow"><h2 class="sh">${esc(mk.hoursTitle)}</h2><p class="shsub">${esc(mk.hoursNote)}</p><div class="card">${hours(mk.hours)}</div></div></section>
<section class="band" id="contact"><div class="wrap narrow"><h2 class="sh">טלפונים</h2><p class="shsub">${esc(mk.phoneNote.replace(/:$/, ''))}</p><ul class="clist">
<li>${icon('phone', 'ico')}<span><b>טלפון במקווה</b>${telA(mk.phone)}</span></li>
${mk.attendants.map(([n, ts]) => `<li>${icon('users', 'ico')}<span><b>בלנית: ${esc(n)}</b>${ts.map(telA).join('<br>')}</span></li>`).join('')}</ul></div></section>
<section class="band final" id="visit"><div class="wrap narrow"><h2>הגעה למקווה</h2><p>${esc(mk.address)}</p>${navBtns(mk.navQuery)}<p class="small"><a href="/yavniel/">← עוד על יבנאל: זמני תפילה, מקוואות ושירותים</a></p></div></section>
<div class="stickcta duo"><a class="btn" href="tel:${tel(mk.phone)}">${icon('phone', 'ico sm')}התקשרו</a><a class="btn ghost" href="#visit">${icon('nav', 'ico sm')}ניווט</a></div>`,
  { desc: 'מקווה מלכה ביבנאל: מקווה טהרה לנשים, הבטחת הצדיק מיבנאל, שעות פעילות, טלפונים וניווט', path: '/mikveh-malka/', full: true, head: phead('יבנאל · מקווה טהרה לנשים', 'מקווה מלכה', esc(mk.lead), `<div class="navbtns hcta"><a class="btn" href="tel:${tel(mk.phone)}">${icon('phone', 'ico sm')}התקשרו למקווה</a><a class="btn ghost light" href="#visit">${icon('nav', 'ico sm')}ניווט</a></div>`) }));

// The Tzaddik of Yavniel: biography and tziyun (grave) pages, with structured data for search and AI engines
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const absu = (p) => (ORIGIN ? ORIGIN + BASE + p : undefined);
const crumbs = (xs) => ({ '@type': 'BreadcrumbList', itemListElement: xs.map(([n, p], i) => ({ '@type': 'ListItem', position: i + 1, name: n, ...(absu(p) ? { item: absu(p) } : {}) })) });
const faqLd = (xs) => ({ '@type': 'FAQPage', mainEntity: xs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
const faqHtml = (xs) => `<div class="faqs">${xs.map(([q, a], n) => `<details class="faq"${n ? '' : ' open'}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`;
const facts = (xs) => `<dl class="facts">${xs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
const srcList = (xs) => `<section class="band srcs"><div class="wrap narrow"><h2>מקורות</h2>${ul(xs.map(([t, u]) => `<a href="${url(u)}" rel="noopener">${esc(t)}</a>`))}</div></section>`;
const person = { '@type': 'Person', ...(absu('/moharash/') ? { '@id': absu('/moharash/') + '#person', url: absu('/moharash/') } : {}), name: 'רבי אליעזר שלמה שיק', alternateName: ['מוהרא״ש', 'מוהרא"ש', 'הצדיק מיבנאל', 'הצדיק מיבניאל', 'Rabbi Eliezer Shlomo Schick', 'Moharash'], birthDate: '1940-05-29', deathDate: '2015-02-06', birthPlace: { '@type': 'Place', name: 'תל אביב' }, deathPlace: { '@type': 'Place', name: 'ניו יורק' }, description: mo.lead, knowsAbout: ['חסידות ברסלב', 'רבי נחמן מברסלב'], sameAs: mo.sources.slice(0, 2).map(([, u]) => u) };

write('moharash/index.html', layout(mo.title, `<section class="band"><div class="wrap"><div class="bio-top"><div class="about lead1">${ps(mo.summary)}<p class="small">${esc(mo.acronym)}</p></div><aside class="factbox" aria-label="פרטים עיקריים"><h2>${esc(mo.name)}</h2>${facts(mo.facts)}</aside></div></div></section>
<section class="band soft" id="life"><div class="wrap narrow"><h2 class="sh">תולדות חייו</h2><p class="shsub">מתל אביב וירושלים, דרך ניו יורק, ועד יבנאל</p><p class="snote c">${esc(mo.lifeLead)} <a href="/library/${regey.slug}/">לספר ←</a></p><ol class="tline">${mo.life.map(([t, d]) => `<li><b>${esc(t)}</b><p>${esc(d)}</p></li>`).join('')}</ol><p class="tnote">${esc(mo.community)}</p></div></section>
<section class="band" id="teachings"><div class="wrap"><h2 class="sh">דרכו והדרכותיו</h2><p class="shsub">הנקודות שעליהן העמיד את תלמידיו, בדרכו של רבי נחמן מברסלב</p><div class="grid notes tch">${mo.teachings.map(([t, d, src]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p>${src ? `<span class="go">${esc(src)}</span>` : ''}</div>`).join('')}</div>
<div class="card wide"><h3>סדר הלימוד היומי: חמישה־עשר מקורות</h3><ul class="chips2">${mo.sources15.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq small"><p>${esc(mo.legacyQuote)}</p><cite>${esc(mo.legacyBy)}</cite></blockquote></div></section>
<section class="band" id="books"><div class="wrap"><h2 class="sh">ספריו</h2><p class="shsub">ירושתו העיקרית: אלפי מכתבים ועשרות ספרים</p><ul class="inst-list books">${mo.books.map(([n, d]) => `<li>${icon('book', 'ico')}<span><b>${(lib.books.find((x) => x.title === n)) ? `<a href="/library/${lib.books.find((x) => x.title === n).slug}/">${esc(n)}</a>` : esc(n)}</b><small>${esc(d)}</small></span></li>`).join('')}</ul>
<div class="svc two"><a class="card hl" href="/shut/">${icon('book', 'ico lg')}<h3>שו״ת ברסלב באתר</h3><p>${shut.length.toLocaleString('he-IL')} שאלות ותשובות שכתב מוהרא״ש, בעבודת ה׳, באמונה, בתפילה ובהתבודדות.</p><span class="go">לשאלות ולתשובות ←</span></a><a class="card" href="/print/">${icon('print', 'ico lg')}<h3>הדפסת ״אשר בנחל״</h3><p>שותפות בהדפסת ספרי הצדיק והפצתם, כבקשתו לפני פטירתו.</p><span class="go">להצטרפות ←</span></a></div></div></section>
${ysect('passing', 'soft', 'פטירתו', '', `<div class="about">${ps(mo.passing)}</div>`)}
<section class="band" id="tziyun-cta"><div class="wrap"><a class="feature" href="/moharash/tziyun/"><span class="fic">${icon('flame', 'ico lg')}</span><span class="ftxt"><em>ציון הצדיק ביבנאל</em><b>ציון מוהרא״ש</b><span>ההבטחות לבאים אל קברו, ההילולה בי״ז בשבט ודרכי הגעה.</span></span><span class="btn">לדף הציון ←</span></a></div></section>
<section class="band soft" id="faq"><div class="wrap narrow"><h2 class="sh">שאלות נפוצות</h2><p class="shsub">בקצרה, על הצדיק מיבנאל</p>${faqHtml(mo.faq)}</div></section>
${srcList(mo.sources)}`,
  { desc: 'מוהרא״ש, הצדיק מיבנאל: רבי אליעזר שלמה שיק (1940–2015), מנהיג בחסידות ברסלב, מייסד היכל הקודש ומחבר אשר בנחל. תולדות חייו, דרכו, ספריו וציונו ביבנאל.', path: '/moharash/', full: true,
    head: phead('רבי אליעזר שלמה שיק זצ״ל', esc(mo.title), esc(mo.lead), `${anchors([['life', 'תולדות חייו'], ['story', 'סיפור ההסתר'], ['teachings', 'דרכו'], ['books', 'ספריו'], ['passing', 'פטירתו'], ['faq', 'שאלות נפוצות']])}<div class="navbtns hcta"><a class="btn" href="/moharash/tziyun/">${icon('flame', 'ico sm')}לציון הצדיק</a><a class="btn ghost" href="/shut/">${icon('book', 'ico sm')}שו״ת ברסלב</a></div>`),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [person, crumbs([['בית', '/'], [mo.title, '/moharash/']]), faqLd(mo.faq)] }) }));

const tz = mo.tziyun;
write('moharash/tziyun/index.html', layout(tz.title, `<section class="band"><div class="wrap"><ul class="clist quick">${tz.quick.map(([ic, k, v]) => `<li>${icon(ic, 'ico')}<span><b>${esc(k)}</b>${esc(v)}</span></li>`).join('')}</ul><div class="wrap narrow about lead1 pad">${ps(tz.summary)}<p>על חייו ופועלו: <a href="/moharash/">מוהרא״ש, הצדיק מיבנאל ←</a></p></div></div></section>
<section class="band quoteband" id="vow"><div class="wrap"><p class="kicker2">ההבטחה שעל המצבה</p><blockquote class="pq small"><p>${esc(tz.vow)}</p><cite>${esc(tz.vowNote)}</cite></blockquote></div></section>
<section class="band" id="promises"><div class="wrap narrow"><h2 class="sh">הבטחות לבאים אל קברו</h2>${orn}<div class="about"><p>${esc(tz.promisesLead)}</p></div>${tz.promises.map(([q, by]) => `<figure class="letterq"><blockquote>${esc(q)}</blockquote><figcaption>${esc(by)}</figcaption></figure>`).join('')}<div class="vow"><span class="kicker2">ולצד זה: אומן</span><p>${esc(tz.uman)}</p></div></div></section>
${ysect('hillula', 'soft', 'הילולת הצדיק מיבנאל', '', `<div class="about"><p>${esc(tz.hillula)}</p></div>`)}
<section class="band" id="directions"><div class="wrap"><h2 class="sh">דרכי הגעה</h2><p class="shsub">הציון נמצא ביבנאל, בגליל התחתון, כעשרים דקות מטבריה</p><div class="steps3">${tz.routes.map(([t, d], i) => `<div class="card"><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div><p class="snote c">${esc(tz.transit)}</p></div></section>
<section class="band final" id="visit"><div class="wrap narrow"><h2>ניווט לציון</h2><p>בוויז מחפשים ״${esc(tz.nav)}״</p>${navBtns(tz.nav)}<p class="small"><a href="/yavniel/">← ביבנאל: זמני תפילה, מקוואות ובית התבשיל</a></p></div></section>
<section class="band soft" id="faq"><div class="wrap narrow"><h2 class="sh">שאלות נפוצות</h2><p class="shsub">על ציון מוהרא״ש</p>${faqHtml(tz.faq)}</div></section>
${srcList(mo.sources.slice(0, 2))}
<div class="stickcta duo"><a class="btn" href="${url(`https://www.waze.com/ul?q=${encodeURIComponent(tz.nav)}&navigate=yes`)}" rel="noopener">${icon('nav', 'ico sm')}ניווט ב־Waze</a><a class="btn ghost" href="#directions">${icon('pin', 'ico sm')}דרכי הגעה</a></div>`,
  { desc: 'ציון מוהרא״ש, קבר הצדיק מיבנאל: היכן נמצא, ההבטחה לרווקים ורווקות החרוטה על המצבה, ההילולה בי״ז בשבט ודרכי הגעה ליבנאל.', path: '/moharash/', self: '/moharash/tziyun/', full: true,
    head: phead('יבנאל · הגליל התחתון', esc(tz.title), esc(tz.lead), `<div class="navbtns hcta"><a class="btn" href="#visit">${icon('nav', 'ico sm')}ניווט לציון</a><a class="btn ghost" href="#vow">${icon('star', 'ico sm')}ההבטחה</a></div>`),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': ['Cemetery', 'TouristAttraction'], name: tz.title, alternateName: ['קבר מוהרא״ש', 'ציון הצדיק מיבנאל', 'קבר הצדיק מיבנאל'], description: tz.summary[0], address: { '@type': 'PostalAddress', addressLocality: 'יבנאל', addressCountry: 'IL' }, containedInPlace: { '@type': 'Place', name: 'יבנאל' }, ...(absu('/moharash/tziyun/') ? { url: absu('/moharash/tziyun/') } : {}), subjectOf: person }, crumbs([['בית', '/'], [mo.title, '/moharash/'], ['ציון מוהרא״ש', '/moharash/tziyun/']]), faqLd(tz.faq)] }) }));


const libCats = lib.categories.filter(([c]) => lib.books.some((b) => b.category === c) || lib.online.some(([oc]) => oc === c));
write('library/index.html', layout('ספרייה', `<section class="band"><div class="wrap">${libCats.length > 1 ? `<nav class="chips lchips" aria-label="קטגוריות">${libCats.map(([c, n]) => `<a href="#${c}">${esc(n)}</a>`).join('')}</nav>` : ''}
${libCats.map(([c, n]) => `<section class="libcat" id="${c}"><h2 class="subh">${icon('book', 'ico')}${esc(n)}</h2><div class="grid">${lib.books.filter((b) => b.category === c).map((b) => `<a class="card book" href="/library/${b.slug}/">${icon('book', 'ico lg')}<h3>${esc(b.title)}</h3><p>${esc(b.sub)}</p><span class="go">${b.text ? 'לקריאה באתר ←' : 'לספר · PDF ←'}</span></a>`).join('')}${lib.online.filter(([oc]) => oc === c).map(([, t, h, x]) => `<a class="card book" href="${h}">${icon('letter', 'ico lg')}<h3>${esc(t)}</h3><p>${esc(x)}</p><span class="go">לקריאה באתר ←</span></a>`).join('')}</div></section>`).join('')}</div></section>
<section class="band soft" id="soon"><div class="wrap"><h2 class="sh">בקרוב בספרייה</h2><p class="shsub">ספרים נוספים של מוהרא״ש שיתווספו בהדרגה</p><ul class="chips2 soonlist">${lib.soon.map(([c, t]) => `<li>${esc(t)} <small>${esc(catName[c])}</small></li>`).join('')}</ul></div></section>
<section class="band"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>כל ספר שנכנס לספרייה ומודפס, הוא זכות לכל מי שהשתתף.</span></span><span class="btn">להשתתפות ←</span></a></div></section>`,
  { desc: 'ספריית ספרי מוהרא״ש, הצדיק מיבנאל: ספרים לקריאה ולהורדה בחינם', path: '/library/', full: true, head: phead('מוהרא״ש · הצדיק מיבנאל', 'ספרייה', esc(lib.intro)),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: 'ספרייה', description: lib.intro, hasPart: lib.books.map((b) => ({ '@type': 'Book', name: b.title, author: person, ...(absu(`/library/${b.slug}/`) ? { url: absu(`/library/${b.slug}/`) } : {}) })) }, crumbs([['בית', '/'], ['ספרייה', '/library/']])] }) }));

// Book reader: one page per section of every book with a text file (introduction, sections, closing prayer)
const bookTexts = lib.books.filter((b) => b.text).map((b) => [b, read(b.text)]);
const heLabel = (n) => { const o = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'], t = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ']; return n === 15 ? 'טו' : n === 16 ? 'טז' : t[Math.floor(n / 10)] + o[n % 10]; };
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
        head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="/library/">ספרייה</a> · <a href="${base}">${esc(bk.title)}</a> · ${esc(c.label)}</p><h1>${esc(c.title)}</h1></div></section>`,
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
${chs ? `<section class="band" id="toc"><div class="wrap narrow"><h2 class="sh">תוכן העניינים</h2><p class="shsub">לחצו על סעיף כדי לקרוא אותו באתר</p><p class="continue" data-continue="${bk.slug}" hidden></p>
<ol class="toc"><li><a href="/library/${bk.slug}/hakdama/"><b>הקדמה</b><span>החלום שבעקבותיו החל לכתוב, ולמה נקרא הספר ״רגעי מוהרא״ש״</span></a></li></ol>
${bk.parts.map(([t, , [from, to]], i) => `<h3 class="tocpart"><span>${i + 1}</span>${esc(t)}</h3><ol class="toc">${chs.slice(from, to + 1).map((c) => `<li><a href="/library/${bk.slug}/${c.id}/"><b>${esc(c.label)}</b><span>${esc(c.title)}</span></a></li>`).join('')}</ol>`).join('')}
${bookTexts.find(([b]) => b === bk)?.[1].tikkun ? `<h3 class="tocpart"><span>✦</span>נספח</h3><ol class="toc"><li><a href="/library/${bk.slug}/tikkun-haklali/"><b>תיקון הכללי</b><span>עשרת המזמורים של רבי נחמן מברסלב</span></a></li></ol>` : ''}</div></section>` : ''}
${bk.noCopyright ? `<section class="band quoteband"><div class="wrap"><p class="kicker2">על הדפסת ספריו</p><blockquote class="pq small"><p>${esc(bk.noCopyright)}</p><cite>${esc(bk.noCopyrightBy)}</cite></blockquote></div></section>` : ''}
<section class="band" id="dedicate"><div class="wrap"><a class="feature" href="/print/"><span class="fic">${icon('heart', 'ico lg')}</span><span class="ftxt"><em>שותפות בהפצת ספרי הצדיק</em><b>הקדשה והשתתפות בהדפסה</b><span>לרפואה, לפרנסה, לזיווג או לעילוי נשמה, בהדפסת ספרי מוהרא״ש.</span></span><span class="btn">להשתתפות ←</span></a></div></section>
<section class="band final" id="read"><div class="wrap narrow"><h2>לקריאה ולהורדה</h2><p>${chs ? 'הספר המלא באתר, מנוקד, עם הערות, ולהורדה כ־PDF.' : 'הספר המלא, כפי שיצא לאור, בחינם.'}</p>${chs ? `<div class="navbtns"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a><a class="btn ghost" href="${bk.pdf}" download>${icon('print', 'ico sm')}הורדה (PDF, ${bk.pdfSize})</a></div>` : pdfBtns}<p class="small"><a href="/library/">← לכל ספרי הספרייה</a></p></div></section>`,
    { desc: `${bk.title}: ${bk.lead}`, path: '/library/', self: bookUrl, full: true,
      head: phead(`ספרייה · ${catName[bk.category]}`, esc(bk.title), esc(bk.lead), chs ? `<div class="navbtns hcta"><a class="btn" href="${bookUrl}hakdama/">${icon('book', 'ico sm')}קריאה באתר</a><a class="btn ghost" href="#toc">תוכן העניינים</a></div>` : `<div class="navbtns hcta"><a class="btn" href="${bk.pdf}" target="_blank" rel="noopener">${icon('book', 'ico sm')}קריאה בספר</a><a class="btn ghost" href="${bk.parts ? '#contents' : '#read'}">${bk.parts ? 'מה בספר' : 'הורדה'}</a></div>`),
      head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Book', name: bk.title, author: person, inLanguage: 'he', description: bk.lead, genre: catName[bk.category], bookFormat: 'https://schema.org/EBook', ...(bk.pages ? { numberOfPages: bk.pages } : {}), isAccessibleForFree: true, ...(absu(bookUrl) ? { url: absu(bookUrl), workExample: { '@type': 'Book', bookFormat: 'https://schema.org/EBook', encodingFormat: 'application/pdf', url: absu(bk.pdf) } } : {}) }, crumbs([['בית', '/'], ['ספרייה', '/library/'], [bk.title, bookUrl]])] }) }));
}
// Rabbi Nachman of Breslov and Uman: two pages with structured data for search and AI engines
const tikkunUrl = '/tikkun-haklali/';
const rnPerson = { '@type': 'Person', ...(absu('/rabbi-nachman/') ? { '@id': absu('/rabbi-nachman/') + '#person', url: absu('/rabbi-nachman/') } : {}), name: 'רבי נחמן מברסלב', alternateName: ['רבינו', 'מוהר״ן', 'מוהר"ן', 'רבי נחמן מברסלב', 'Rebbe Nachman of Breslov', 'Nachman of Breslov'], birthDate: '1772', deathDate: '1810-10', birthPlace: { '@type': 'Place', name: 'מז׳יבוז׳' }, deathPlace: { '@type': 'Place', name: 'אומן' }, description: rn.short, knowsAbout: ['חסידות ברסלב', 'ליקוטי מוהר״ן'], sameAs: rn.sources.slice(0, 2).map(([, u]) => u) };
write('rabbi-nachman/index.html', layout(rn.title, `<section class="band"><div class="wrap"><div class="bio-top"><div class="about lead1">${ps(rn.summary)}</div><aside class="factbox" aria-label="פרטים עיקריים"><h2>${esc(rn.name)}</h2>${facts(rn.facts)}</aside></div></div></section>
<section class="band soft" id="life"><div class="wrap narrow"><h2 class="sh">תולדות חייו</h2><p class="shsub">מז׳יבוז׳, ארץ ישראל, ברסלב ואומן</p><ol class="tline">${rn.life.map(([t, d]) => `<li><b>${esc(t)}</b><p>${esc(d)}</p></li>`).join('')}</ol></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq"><p>מצוה גדולה להיות בשמחה תמיד</p><cite>ליקוטי מוהר״ן תנינא, סימן כ״ד</cite></blockquote></div></section>
<section class="band" id="story"><div class="wrap narrow"><h2 class="sh">${esc(rn.stories.title)}</h2><p class="shsub">${esc(rn.stories.lead)}</p><div class="about">${ps(rn.stories.text)}</div></div></section>
<section class="band soft" id="teachings"><div class="wrap"><h2 class="sh">דרכו ותורתו</h2><p class="shsub">עיקרי הדרך של חסידות ברסלב</p><div class="grid notes tch">${rn.teachings.map(([t, d, src]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p><span class="go">${esc(src)}</span></div>`).join('')}</div></div></section>
<section class="band" id="works"><div class="wrap"><h2 class="sh">ספריו וספרי תלמידיו</h2><p class="shsub">התורות והסיפורים שהשאיר רבינו, וכפי שרבי נתן רשם אותם</p><ul class="inst-list books">${rn.works.map(([n, d]) => `<li>${icon('book', 'ico')}<span><b>${esc(n)}</b><small>${esc(d)}</small></span></li>`).join('')}</ul></div></section>
${ysect('natan', 'soft', esc(rn.natan.title), '', `<div class="about">${ps(rn.natan.text)}</div>`)}
<section class="band" id="tikkun"><div class="wrap narrow"><h2 class="sh">${esc(rn.tikkun.title)}</h2>${orn}<div class="about">${ps(rn.tikkun.text)}</div><ul class="chips2 psalms">${rn.tikkun.psalms.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="navbtns"><a class="btn" href="${tikkunUrl}">${icon('book', 'ico sm')}לנוסח התיקון הכללי</a></p></div></section>
<section class="band" id="uman"><div class="wrap"><a class="feature" href="/uman/"><span class="fic">${icon('pin', 'ico lg')}</span><span class="ftxt"><em>העיר שבה נטמן רבינו</em><b>אומן</b><span>${esc(rn.uman)}</span></span><span class="btn">לדף אומן ←</span></a></div></section>
<section class="band soft" id="faq"><div class="wrap narrow"><h2 class="sh">שאלות נפוצות</h2><p class="shsub">בקצרה, על רבי נחמן מברסלב</p>${faqHtml(rn.faq)}</div></section>
${srcList(rn.sources)}`,
  { desc: 'רבי נחמן מברסלב (תקל״ב–תקע״א), מייסד חסידות ברסלב ומחבר ליקוטי מוהר״ן: תולדות חייו, תורתו, ספריו, התיקון הכללי וציונו באומן.', path: '/rabbi-nachman/', full: true,
    head: phead('מייסד חסידות ברסלב', esc(rn.title), esc(rn.lead), `${anchors([['life', 'תולדות חייו'], ['teachings', 'דרכו'], ['works', 'ספריו'], ['tikkun', 'התיקון הכללי'], ['uman', 'אומן'], ['faq', 'שאלות נפוצות']])}<div class="navbtns hcta"><a class="btn" href="/uman/">${icon('pin', 'ico sm')}ציון רבינו באומן</a><a class="btn ghost" href="${tikkunUrl}">${icon('book', 'ico sm')}התיקון הכללי</a></div>`),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [rnPerson, crumbs([['בית', '/'], [rn.title, '/rabbi-nachman/']]), faqLd(rn.faq)] }) }));

write('uman/index.html', layout(um.title, `<section class="band"><div class="wrap"><ul class="clist quick">${um.quick.map(([ic, k, v]) => `<li>${icon(ic, 'ico')}<span><b>${esc(k)}</b>${esc(v)}</span></li>`).join('')}</ul><div class="wrap narrow about lead1 pad">${ps(um.summary)}<p>על חייו של רבינו: <a href="/rabbi-nachman/">רבי נחמן מברסלב ←</a></p></div></div></section>
<section class="band soft" id="history"><div class="wrap narrow"><h2 class="sh">תולדות אומן וציון רבינו</h2><p class="shsub">מקברי הקדושים ועד הקיבוץ של ימינו</p><ol class="tline">${um.history.map(([t, d]) => `<li><b>${esc(t)}</b><p>${esc(d)}</p></li>`).join('')}</ol></div></section>
<section class="band quoteband" id="place"><div class="wrap"><p class="kicker2">רבי נחמן, בדרכו לברסלב</p><blockquote class="pq small"><p>כאן מקום טוב לשכב</p><cite>על בית הקברות של אומן, שבו נטמנו אלפי קדושים על קידוש השם</cite></blockquote></div></section>
${ysect('tziyun', '', 'הציון והתיקון הכללי', '', `<div class="about">${ps(um.tziyun)}</div><p class="navbtns"><a class="btn" href="${tikkunUrl}">${icon('book', 'ico sm')}לנוסח התיקון הכללי</a></p>`)}
${ysect('kibbutz', 'soft', 'קיבוץ ראש השנה', '', `<div class="about">${ps(um.kibbutz)}</div>`)}
${ysect('curtain', '', esc(um.ironCurtain.title), '', `<div class="about">${ps(um.ironCurtain.text.slice(0, 1))}</div><figure class="letterq"><blockquote>${esc(um.ironCurtain.text[1])}</blockquote><figcaption>מוהרא״ש, מתוך סקירה על אומן</figcaption></figure>`)}
<section class="band soft" id="stories"><div class="wrap"><h2 class="sh">סיפורי אומן</h2><p class="shsub">מהעיר ומהציון</p><div class="grid notes">${um.stories.map(([t, x]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(x)}</p></div>`).join('')}</div></div></section>
${ysect('holocaust', '', esc(um.holocaust.title), '', `<div class="about">${ps(um.holocaust.text)}</div>`)}
<section class="band soft" id="more"><div class="wrap"><div class="svc two"><div class="card">${icon('flame', 'ico lg')}<h3>גן סופיה</h3><p>${esc(um.sofia)}</p>${ps(um.sofiaStory)}</div><div class="card">${icon('pin', 'ico lg')}<h3>רבי אברהם בן רבי נחמן</h3><p>${esc(um.avraham)}</p></div></div></div></section>
${ysect('today', '', 'אומן היום', '', `<div class="about"><p>${esc(um.today)}</p></div>`)}
<section class="band" id="travel"><div class="wrap narrow"><h2 class="sh">${esc(um.travel.title)}</h2><p class="shsub">${esc(um.travel.note)}</p><div class="card wide">${icon('clock', 'ico lg')}<h3>אזהרה</h3><p>${esc(um.travel.warning)}</p></div><div class="faq">${um.travel.items.map(([t, x]) => `<details><summary>${esc(t)}</summary><p>${esc(x)}</p></details>`).join('')}</div><p class="shsub">מקורות: ${um.travel.sources.map(([t, u]) => `<a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(t)}</a>`).join(' · ')}</p></div></section>
<section class="band soft" id="visit"><div class="wrap narrow"><div class="card wide">${icon('clock', 'ico lg')}<h3>לפני שנוסעים</h3><p>${esc(um.visit)}</p></div>${navBtns(um.nav)}</div></section>
<section class="band" id="faq"><div class="wrap narrow"><h2 class="sh">שאלות נפוצות</h2><p class="shsub">על אומן ועל הציון</p>${faqHtml(um.faq)}</div></section>
${srcList(um.sources)}`,
  { desc: 'אומן: העיר שבה נטמן רבי נחמן מברסלב. תולדות העיר, ציון רבינו, התיקון הכללי, קיבוץ ראש השנה והמסע של חסידי ברסלב לאומן.', path: '/uman/', full: true,
    head: phead('אוקראינה · ציון רבינו', esc(um.title), esc(um.lead), `<div class="navbtns hcta"><a class="btn" href="#tziyun">${icon('flame', 'ico sm')}הציון</a><a class="btn ghost" href="#kibbutz">קיבוץ ראש השנה</a></div>`),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': ['City', 'TouristAttraction'], name: 'אומן', alternateName: ['Uman', 'Умань', 'ציון רבי נחמן מברסלב'], description: um.short, containedInPlace: { '@type': 'Country', name: 'אוקראינה' }, ...(absu('/uman/') ? { url: absu('/uman/') } : {}), subjectOf: rnPerson, sameAs: um.sources.slice(0, 2).map(([, u]) => u) }, crumbs([['בית', '/'], ['אומן', '/uman/']]), faqLd(um.faq)] }) }));

// Tikkun HaKlali: full text and guide
const verses = (vs) => vs.map(([n, t]) => `<sup class="vn">${esc(n)}</sup>${esc(t).replace(/\[([^\]]+)\]/g, '<span class="hint">($1)</span>')}`).join(' ');
const textBlock = `<div class="tools" role="group" aria-label="כלי קריאה"><button type="button" class="tbtn" data-fs="-1" aria-label="הקטנת טקסט">א־</button><button type="button" class="tbtn big" data-fs="1" aria-label="הגדלת טקסט">א+</button><button type="button" class="tbtn" data-nikud aria-pressed="false">ניקוד</button><button type="button" class="tbtn share" data-share>${icon('share', 'ico sm')}שיתוף</button><a class="tbtn" href="/books/tikkun-haklali.pdf" download>${icon('print', 'ico sm')}PDF להורדה</a></div>
<div class="sheet book-sheet tikkun-text"><div class="thead">${tkText.head.map((x) => `<p>${esc(x)}</p>`).join('')}</div>
<h2 class="subt" id="t-before">תפילה קצרה לפני התיקון הכללי</h2>${tkText.pre.slice(1).map((x) => `<p>${esc(x)}</p>`).join('')}<p class="inst">${esc(tkText.pre[0].replace(/\s*$/, ''))}</p>
<h2 class="subt" id="t-hitkashrut">התקשרות ויחוד</h2>${tkText.hitkashrut.map((x) => `<p>${esc(x)}</p>`).join('')}
${tkText.psalms.map((p, i) => `<h2 class="psalm" id="ps-${i + 1}">${esc(p.title)}</h2><p class="verses">${verses(p.verses)}</p>`).join('')}
<h2 class="subt" id="t-after">אחרי התיקון הכללי</h2>${tkText.closing.map((x) => `<p>${esc(x)}</p>`).join('')}
<h2 class="subt">תפילה לאחר התיקון הכללי, שיסד רבי נתן</h2>${tkText.post.map((x) => `<p>${esc(x)}</p>`).join('')}
<h2 class="subt">תפילה קצרה אחר התיקון הכללי</h2>${tkText.short.map((x) => `<p>${esc(x)}</p>`).join('')}${orn}</div>`;
write('tikkun-haklali/index.html', layout('התיקון הכללי', `<section class="band"><div class="wrap"><ul class="clist quick">${tk.quick.map(([ic, k, v]) => `<li>${icon(ic, 'ico')}<span><b>${esc(k)}</b>${esc(v)}</span></li>`).join('')}</ul><div class="wrap narrow about lead1 pad">${ps(tk.summary)}</div></div></section>
<section class="band quoteband" id="vow"><div class="wrap"><p class="kicker2">ההבטחה</p><blockquote class="pq small"><p>${esc(tk.vow)}</p><cite>${esc(tk.vowBy)}</cite></blockquote></div></section>
${ysect('origin', '', 'מי גילה ומתי', '', `<div class="about"><p>${esc(tk.origin)}</p><div class="vow"><span class="kicker2">על התיקון הכללי</span><p>${esc(tk.strong)}</p></div></div>`)}
<section class="band soft" id="how"><div class="wrap"><h2 class="sh">איך אומרים</h2><p class="shsub">הסדר, בארבעה שלבים</p><div class="steps3">${tk.steps.map(([t, x], i) => `<div class="card"><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(x)}</p></div>`).join('')}</div><ul class="chips2 psalms">${tkText.psalms.map((p, i) => `<li><a href="#ps-${i + 1}">${esc(p.title.replace('פרק ', ''))}</a></li>`).join('')}</ul></div></section>
${ysect('explain', '', esc(tk.explanationTitle), esc(tk.explanationLead), `<div class="about">${tkText.explanation.map((x) => `<p>${esc(x)}</p>`).join('')}</div>`)}
<section class="band soft" id="text"><div class="wrap narrow"><h2 class="sh">הנוסח המלא</h2><p class="shsub">${esc(tk.textNote)}</p>${textBlock}</div></section>
<section class="band" id="faq"><div class="wrap narrow"><h2 class="sh">שאלות נפוצות</h2><p class="shsub">על התיקון הכללי</p>${faqHtml(tk.faq)}<div class="sheet" style="margin-top:22px"><h3>עוד בשו״ת ברסלב</h3><p class="small">תשובות מוהרא״ש בענייני התיקון הכללי:</p><ul class="clist">${tk.shut.map(([id, q]) => `<li><a href="/shut/${id}/">${esc(q)}</a></li>`).join('')}</ul></div><p class="navbtns"><a class="btn" href="/rabbi-nachman/">${icon('flame', 'ico sm')}על רבי נחמן מברסלב</a><a class="btn ghost" href="/uman/">${icon('pin', 'ico sm')}ציון רבינו באומן</a></p></div></section>`,
  { desc: 'התיקון הכללי של רבי נחמן מברסלב: נוסח מלא ומנוקד של עשרת המזמורים (טז, לב, מא, מב, נט, עז, צ, קה, קלז, קנ), התפילות שלפניו ואחריו, ההבטחה, ואיך ומתי אומרים אותו.', path: '/tikkun-haklali/', full: true,
    head: phead('רבי נחמן מברסלב', 'התיקון הכללי', esc(tk.lead), `${anchors([['how', 'איך אומרים'], ['explain', 'הסבר מוהרא״ש'], ['text', 'הנוסח המלא'], ['faq', 'שאלות נפוצות']])}<div class="navbtns hcta"><a class="btn" href="#text">${icon('book', 'ico sm')}לנוסח המלא</a><a class="btn ghost" href="/books/tikkun-haklali.pdf" download>${icon('print', 'ico sm')}הורדה (PDF)</a><a class="btn ghost" href="#how">איך אומרים</a></div>`),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', headline: tk.title, inLanguage: 'he', description: tk.short, about: rnPerson, ...(absu('/tikkun-haklali/') ? { url: absu('/tikkun-haklali/') } : {}) }, crumbs([['בית', '/'], ['רבי נחמן מברסלב', '/rabbi-nachman/'], ['התיקון הכללי', '/tikkun-haklali/']]), faqLd(tk.faq)] }) }));

// Halacha
write('halacha/index.html', layout('שו״ת הלכתי', `${halacha.length ? `${sr('רשימת השאלות')}<div class="grid">${halacha.map((x) => card(x, '/halacha/')).join('')}</div>` : `<div class="empty">${icon('scale', 'ico lg')}<h2>המדור בבנייה</h2><p>השאלות וההלכות יתווספו בקרוב.</p><p><a class="btn" href="/shut/">בינתיים, לשו״ת ברסלב</a></p></div>`}`, { path: '/halacha/', head: phead('הלכה למעשה', 'שו״ת הלכתי', 'שאלות ותשובות בהלכה, בבירור ובפשטות.') }));

// Institutions
if (institutions.length) write('institutions/index.html', layout('מוסדות הקהילה', `${sr('המוסדות')}<div class="grid insts">${institutions.map((i) => `<div class="card inst">${icon('heart', 'ico')}<h3>${esc(i.name)}</h3><p>${esc(i.desc)}</p>${i.goal ? `<p class="goal">${esc(i.goal)}</p>` : ''}<p class="acts">${i.link ? `<a class="btn" href="${url(i.link)}" rel="noopener">לתרומה</a>` : ''}${i.phone ? ` <a class="btn ghost" href="tel:${tel(i.phone)}">${esc(i.phone)}</a>` : ''}</p></div>`).join('')}</div>`, { path: '/institutions/', head: phead('צדקה וחסד', 'מוסדות הקהילה', 'מוסדות תורה וחסד שזקוקים לתמיכתכם.') }));

// Print campaign: Asher BaNachal
const pd = pr.donate;
const h = pr.hero;
const money = (n) => Number(n).toLocaleString('he-IL');
const donateBox = () => pd.iframeUrl
  ? `<div class="donbox" id="donate"><h2 class="donhead">התרומה שלכם מתחילה כאן</h2><iframe title="תרומה באשראי" src="${url(pd.iframeUrl)}" loading="lazy" allow="payment" referrerpolicy="no-referrer" style="width:100%;height:900px;min-height:80vh"></iframe>${pd.fallbackUrl ? `<p class="ctarow"><a class="btn big" href="${url(pd.fallbackUrl)}" rel="noopener" target="_blank">פתחו את טופס התרומה במסך מלא</a></p>` : ''}</div>`
  : pd.fallbackUrl
    ? `<div class="donbox soon" id="donate"><p><a class="btn big" href="${url(pd.fallbackUrl)}" rel="noopener">לתרומה באשראי</a></p></div>`
    : `<div class="donbox soon" id="donate"><p>טופס התרומה באשראי יופעל בקרוב.</p>${pd.phone ? `<p><a href="tel:${tel(pd.phone)}">${esc(pd.phone)}</a></p>` : ''}</div>`;
const cta = (t = 'אני רוצה להצטרף להדפסה') => `<a class="btn big glow" href="/print/donate/">${t}</a>`;
const trust = `<ul class="trust">${pr.trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const g = pr.goal || {};
const goal = g.target ? `<div class="goal-bar"><div class="gb-top"><b>${esc(g.label || 'התקדמות ההדפסה')}</b><span>${money(g.raised)} מתוך ${money(g.target)} ₪</span></div><div class="gb-track"><i style="width:${Math.min(100, Math.round((g.raised / g.target) * 100))}%"></i></div></div>` : '';
const tierCards = (link) => `<div class="tiers2">${pr.tiers.map((t) => `<a class="tier2${t.tag ? ' pick' : ''}" href="${link}">${t.tag ? `<em>${esc(t.tag)}</em>` : ''}<b class="amt${t.amount ? '' : ' free'}">${t.amount ? money(t.amount) + ' ₪' : 'סכום חופשי'}</b><h3>${esc(t.name)}</h3><p>${esc(t.desc)}</p><span class="go">לתרומה ←</span></a>`).join('')}</div>`;
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
${sect('', `${sr('בחירת סכום')}${goal}${tierCards('#donate')}${donateBox()}<p class="small center">התרומה היא להדפסת ספרי הצדיק והפצתם. אין בה התחייבות לתוצאה מסוימת.</p>`)}
${sect('soft', `<div class="info narrow"><h2>פרטים חשובים לפני התרומה</h2>${orgLine ? `<p><b>מקבל התרומה:</b> ${orgLine}.</p>` : ''}<p><b>אבטחת התשלום:</b> התשלום מתבצע בטופס המאובטח של מערכת ״נדרים פלוס״. פרטי האשראי מוזנים ישירות אצלם, ואינם עוברים דרך האתר ואינם נשמרים בו.</p><p><b>קבלה:</b> ניתן לבקש קבלה בעת התרומה.${org.section46 ? ' התרומות מוכרות לזיכוי ממס לפי סעיף 46 לפקודת מס הכנסה.' : ''}</p><p><b>ביטול או טעות בחיוב:</b> תרומה שבוצעה בטעות, או חיוב כפול, יבוטלו לפי בקשה. פנו אלינו <a href="/contact/">בעמוד צור קשר</a> בהקדם ונטפל בפנייה.</p><p><b>פרטיות:</b> פרטיכם משמשים לביצוע התרומה, להקדשה ולמשלוח קבלה בלבד. פרטים נוספים ב<a href="/privacy/">מדיניות הפרטיות</a>.</p></div>`)}`, { full: true, desc: 'תרומה באשראי להדפסת אשר בנחל', path: '/print/' }));

// Letters
write('letters/index.html', layout('מכתבים', `${sr('רשימת המכתבים')}<div class="grid">${letters.map((x) => card(x, '/letters/')).join('')}</div>`, { path: '/letters/', head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'מכתבים', 'מכתבים כלליים לאנשי שלומנו: חיזוק, עצות ודרך בעבודת ה׳.') }));

// Search
// Search index: a small titles file for instant results, then full text split into shards fetched in parallel.
// Unique, punctuation-free words only: term matching is unchanged, the files are much smaller.
// Each entry carries its own path (shut/12, letters/5602), so results can point to any section.
const SHARDS = 8;
const words = (t, skip = new Set()) => [...new Set(nik(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !skip.has(w)))].join(' ');
const indexed = [...shut.map((x) => ['shut', x]), ...letters.map((x) => ['letters', x]), ...halacha.map((x) => ['halacha', x]),
  ...Object.entries(bookChapters).flatMap(([slug, chs]) => chs.map((c) => [`library/${slug}`, { id: c.id, title: `${lib.books.find((b) => b.slug === slug).title}: ${nik(c.title)}`, q: [], a: c.paras.map(nik) }]))];
const shardSize = Math.ceil(indexed.length / SHARDS);
write('idx/titles.json', JSON.stringify({ n: SHARDS, size: shardSize, t: indexed.map(([b, x]) => [`${b}/${x.id}`, x.title]) }));
for (let k = 0; k < SHARDS; k++) write(`idx/${k}.json`, JSON.stringify(indexed.slice(k * shardSize, (k + 1) * shardSize).map(([, x]) => words((x.title + ' ' + x.q.join(' ') + ' ' + x.a.join(' ')).slice(0, 600), new Set(words(x.title).split(' '))))));
const preloads = ['titles', ...Array.from({ length: SHARDS }, (_, k) => k)].map((f) => `<link rel="preload" href="/idx/${f}.json?v=${BUILD}" as="fetch" crossorigin>`).join('');
write('search/index.html', layout('חיפוש', `${sr('תוצאות החיפוש')}<p id="count" class="small count" aria-live="polite"></p><div id="results" class="grid"></div><script src="/search.js?v=${BUILD}" defer></script>`, { path: '/search/', head_extra: preloads, head: phead('בכל אלפי השאלות והמכתבים', 'חיפוש באתר', '', `<div class="hsearch">${icon('search', 'ico sm')}<input id="q" type="search" placeholder="הקלידו מילה או ביטוי…" aria-label="חיפוש" autofocus></div><div class="chips">${chips}</div>`) }));

// Home
const tile = (href, ic, t, d) => `<a class="tile" href="${href}">${icon(ic, 'ico lg')}<b>${t}</b><span>${d}</span><i class="arr">${icon('arrow', 'ico sm')}</i></a>`;
write('index.html', layout(SITE, `<section class="band"><div class="wrap"><div class="tiles">
${tile('/rabbi-nachman/', 'flame', 'רבי נחמן מברסלב', 'רבינו, תורתו והתיקון הכללי')}${tile('/uman/', 'pin', 'אומן', 'ציון רבינו וקיבוץ ראש השנה')}${tile('/shut/', 'book', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות`)}${tile('/letters/', 'letter', 'מכתבים', `${letters.length} מכתבים כלליים`)}${tile('/moharash/', 'flame', 'הצדיק מיבנאל', 'מוהרא״ש: חייו, דרכו וציונו')}${tile('/library/', 'book', 'ספרייה', 'ספרי הצדיק לקריאה ולהורדה')}${tile('/yavniel/', 'mountain', 'יבנאל', 'עיר ברסלב: קהילה, תפילות ומידע')}${tile('/mikveh-malka/', 'drop', 'מקווה מלכה', 'מקווה טהרה לנשים ביבנאל')}${tile('/yeshiva/', 'school', 'ישיבת בית מנחם', 'ישיבה חסידית')}${tile('/halacha/', 'scale', 'שו״ת הלכתי', 'שאלות בהלכה')}${institutions.length ? tile('/institutions/', 'heart', 'מוסדות הקהילה', 'תמיכה ותרומות') : ''}</div>
<a class="feature" href="/print/"><span class="fic">${icon('print', 'ico lg')}</span><span class="ftxt"><em>${esc(pr.hero.kicker)}</em><b>הדפסת ״אשר בנחל״</b><span>הצטרפו להדפסת ספרי הצדיק, והיו שותפים בכל עותק שמחזק עוד נפש.</span></span><span class="btn">להצטרפות ←</span></a></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq"><p>מצוה גדולה להיות בשמחה תמיד</p><cite>ליקוטי מוהר״ן תנינא, סימן כ״ד</cite></blockquote></div></section>
<section class="band soft"><div class="wrap"><h2 class="sh">מתוך השו״ת</h2><p class="shsub">שאלות שנשאלו ותשובות שנכתבו, מלב אל לב</p><div class="grid">${shut.slice(0, 6).map((x) => card(x)).join('')}</div><p class="ctarow"><a class="btn ghost" href="/shut/">לכל השאלות והתשובות ←</a></p></div></section>`,
{ path: '/', full: true, head: `<section class="phead hero"><div class="wrap"><span class="mark big">${icon('flame')}</span><p class="kicker2">חסידות ברסלב</p><h1>${SITE}</h1><p class="sub">שאלות ותשובות בדרכו של רבינו הקדוש רבי נחמן מברסלב: אמונה, תפילה, התבודדות ושמחה.</p>${searchForm}<div class="chips">${chips}</div></div></section>` }));

// Site information pages: about, contact, accessibility statement, privacy and terms
const doc = (sections) => `<div class="doc">${sections.map(([h, ...ps]) => `<section><h2>${h}</h2>${ps.join('')}</section>`).join('')}</div>`;
const P = (t) => `<p>${t}</p>`, UL = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;
const clist = (items) => `<ul class="clist">${items.map(([ic, l, v]) => `<li>${icon(ic, 'ico')}<span><b>${l}</b>${v}</span></li>`).join('')}</ul>`;
const contactLink = '<a href="/contact/">בעמוד צור קשר</a>';

write('about/index.html', layout('אודות', doc([
  ['מה יש באתר', P(`${SITE} מרכז במקום אחד את שו״ת ברסלב של הצדיק מיבניאל זצ״ל, בדרכו של רבינו הקדוש רבי נחמן מברסלב, וכן מכתבים, הלכה ומידע על יבנאל ועל הקהילה.`), UL([
    `<a href="/shut/">שו״ת ברסלב</a>: ${shut.length.toLocaleString('he-IL')} שאלות ותשובות בעבודת ה׳, באמונה, בתפילה ובהתבודדות.`,
    `<a href="/letters/">מכתבים</a>: מכתבים כלליים לאנשי שלומנו.`,
    `<a href="/halacha/">שו״ת הלכתי</a>: שאלות ותשובות בהלכה.`,
    `<a href="/yeshiva/">ישיבת בית מנחם</a>: ישיבה חסידית בדרך רבינו.`,
    `<a href="/print/">הדפסת ״אשר בנחל״</a>: שותפות בהדפסת ספרי הצדיק והפצתם.`,
    `<a href="/moharash/">הצדיק מיבנאל</a>: תולדות חייו של מוהרא״ש, דרכו וספריו, ו<a href="/moharash/tziyun/">ציונו ביבנאל</a>.`,
    `<a href="/yavniel/">יבנאל</a> ו<a href="/mikveh-malka/">מקווה מלכה</a>: מידע על המקום, זמני תפילה ושירותים.`,
  ])],
  ['על התוכן', P('שו״ת ברסלב נכתב על ידי הצדיק מיבניאל זצ״ל, ופורסם ברשות להעתקה והפצה, והשאלות והתשובות מובאות כפי שנכתבו. שאר התכנים באתר אינם מאת הצדיק מיבניאל, ובחלקם הוא מוזכר.'), P(`מצאתם טעות, או שאלה שלכם מופיעה ואתם מבקשים להסיר פרט מזהה? כתבו לנו ${contactLink}.`)],
  ['שימוש בתשובות', P('התשובות נכתבו לשואלים מסוימים, לפי מצבם ושאלתם. בשאלה הלכתית או אישית למעשה, יש להתייעץ עם רב מורה הוראה.')],
]), { path: '', self: '/about/', desc: `על ${SITE}: שו״ת ברסלב של הצדיק מיבניאל זצ״ל, מכתבים ומידע על הקהילה`, head: phead('אור הצדיק לכל נפש', 'אודות האתר') }));

const ci = contactList(sc);
write('contact/index.html', layout('צור קשר', `${ci.length ? clist(ci) : `<div class="empty">${icon('letter', 'ico lg')}<h2>פרטי הקשר יעודכנו בקרוב</h2><p>בינתיים, שאלות על תרומה להדפסה אפשר לשאול בטופס התרומה עצמו.</p></div>`}
${doc([
  ['במה נוכל לעזור', UL([
    'תרומות, קבלות, תשלומים וביטול חיוב שבוצע בטעות.',
    'הקדשה בכרך ״אשר בנחל״: לרפואה, לפרנסה, לזיווג או לעילוי נשמה.',
    'ישיבת בית מנחם: רישום, ביקור ותמיכה.',
    'תיקון טעות באתר, או בקשה להסיר פרט מזהה משאלה שפורסמה.',
    'קושי בגלישה או בנגישות האתר. פרטים נוספים ב<a href="/accessibility/">הצהרת הנגישות</a>.',
  ])],
])}`, { path: '', self: '/contact/', desc: `יצירת קשר עם ${SITE}: תרומות, הקדשות, הישיבה ונגישות`, head: phead('נשמח לשמוע מכם', 'צור קשר', 'שאלות על התרומות, על הישיבה, על האתר או על הנגישות.') }));

const a11y = site.accessibility || {};
const coord = [a11y.coordinator && ['heart', 'רכז/ת נגישות', esc(a11y.coordinator)], a11y.phone && ['phone', 'טלפון', `<a href="tel:${tel(a11y.phone)}">${esc(a11y.phone)}</a>`], a11y.email && ['letter', 'דוא״ל', `<a href="${url('mailto:' + a11y.email, ['mailto:'])}">${esc(a11y.email)}</a>`]].filter(Boolean);
write('accessibility/index.html', layout('הצהרת נגישות', doc([
  ['מחויבות לנגישות', P(`אנו רואים חשיבות רבה בכך שכל אדם, כולל אנשים עם מוגבלות, יוכל לקרוא וללמוד באתר ${SITE} בקלות ובנוחות. האתר הונגש בהתאם לתקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע״ג-2013, ולתקן הישראלי ת״י 5568, המבוסס על הנחיות WCAG 2.0 ברמה AA.`)],
  ['מה עשינו באתר', UL([
    'מבנה תקני של כותרות, אזורים וניווט, שקורא מסך מזהה, וכיוון קריאה מימין לשמאל.',
    'קישור ״דלגו לתוכן״ בראש כל עמוד, וניווט מלא במקלדת עם סימון ברור של הרכיב שבפוקוס.',
    'ניגודיות צבעים מספקת, גם במצב כהה שמופעל לפי הגדרות המכשיר.',
    'כפתורי הגדלה והקטנה של הטקסט בעמודי הקריאה, ותמיכה בהגדלה של הדפדפן עד 200% בלי לאבד תוכן.',
    'כיבוי אנימציות למי שהגדיר במכשיר ״הפחתת תנועה״.',
    'טקסט חלופי לתמונות ותוויות לכפתורים ולשדות.',
    'התאמה מלאה לטלפון נייד, עם אזורי לחיצה גדולים.',
  ])],
  ['רכיבים שאינם בשליטתנו', P('טופס התרומה באשראי מוטמע מאתר ״נדרים פלוס״, ונגישותו באחריות מפעיליו. מתקשים להשתמש בו? פנו אלינו ונסייע בהשלמת התרומה בדרך אחרת.')],
  ['נתקלתם בבעיה?', P('אם מצאתם רכיב שאינו נגיש, נשמח שתספרו לנו. כדי שנוכל לטפל, ציינו את כתובת העמוד, תיאור הבעיה, ואת סוג המכשיר, הדפדפן ותוכנת ההקראה, אם יש. נשתדל להשיב בהקדם.'), coord.length ? clist(coord) : P(`פרטי רכז הנגישות יעודכנו בקרוב. בינתיים אפשר לפנות ${contactLink}.`)],
  ['עדכון ההצהרה', P(`ההצהרה עודכנה בתאריך ${esc(a11y.updated || '')}.`)],
]), { path: '', self: '/accessibility/', desc: `הצהרת הנגישות של ${SITE}`, head: phead('נגישות', 'הצהרת נגישות') }));

write('privacy/index.html', layout('מדיניות פרטיות ותנאי שימוש', doc([
  ['בקצרה', P('האתר אינו דורש הרשמה, אינו מציג פרסומות ואינו משתמש בכלי מעקב או בעוגיות פרסום. אנחנו לא אוספים עליכם מידע אישי בזמן הגלישה.')],
  ['מה נשמר במכשיר שלכם', UL([
    'גודל הטקסט שבחרתם בעמודי הקריאה, כדי שיישמר בביקור הבא.',
    'סימון שכבר ראיתם את מסך הפתיחה, לזמן הביקור בלבד.',
  ]), P('המידע הזה נשמר בדפדפן שלכם בלבד ואינו נשלח אלינו. אפשר למחוק אותו בכל עת דרך הגדרות הדפדפן.')],
  ['שירותים חיצוניים', UL([
    '<b>אחסון:</b> ספק האחסון של האתר שומר יומני גישה טכניים (כמו כתובת IP), לצורכי אבטחה ותפעול בלבד.',
    '<b>גופנים:</b> הגופנים נטענים מ-Google Fonts, ולכן הדפדפן פונה לשרתי Google.',
    '<b>תרומות:</b> טופס התרומה מופעל על ידי מערכת ״נדרים פלוס״. הפרטים שתמלאו בו (שם, פרטי קשר, אשראי, הקדשה) נמסרים ישירות להם ולגוף מקבל התרומה, ואינם עוברים דרך האתר. על פרטים אלה חלה גם מדיניות הפרטיות של ״נדרים פלוס״.',
    '<b>שיתוף:</b> לחיצה על ״שיתוף״ פותחת את אפליקציית השיתוף של המכשיר או את וואטסאפ, לפי בחירתכם.',
  ])],
  ['פניות אלינו', P(`פרטים שתשלחו לנו בפנייה (טלפון, דוא״ל או וואטסאפ) ישמשו רק כדי לטפל בפנייה, ולא יימסרו לאחרים. לפי חוק הגנת הפרטיות, התשמ״א-1981, אתם רשאים לבקש לעיין במידע עליכם ולתקן או למחוק אותו. פנו אלינו ${contactLink}.`)],
  ['תנאי שימוש', UL([
    'שו״ת ברסלב נכתב על ידי הצדיק מיבניאל זצ״ל ופורסם ברשות להעתקה והפצה. נשמח שתפיצו אותו, בתנאי שלא ישונה ושיצוין מקורו.',
    'התשובות נכתבו לשואלים מסוימים לפי מצבם. אין הן תחליף להתייעצות אישית עם רב, ובשאלה הלכתית למעשה יש לשאול רב מורה הוראה.',
    'תרומה להדפסה היא תרומה לצורך הדפסת ספרי הצדיק והפצתם, ואין בה התחייבות לתוצאה מסוימת.',
    'אנו משתדלים שהמידע באתר יהיה מדויק ועדכני, אך ייתכנו טעויות. האתר עשוי לקשר לאתרים חיצוניים, שאינם באחריותנו.',
  ])],
  ['עדכונים', P(`ייתכן שהמדיניות תעודכן מעת לעת. עדכון אחרון: ${esc(a11y.updated || '')}.`)],
]), { path: '', self: '/privacy/', desc: `מדיניות הפרטיות ותנאי השימוש של ${SITE}`, head: phead('שקיפות', 'מדיניות פרטיות ותנאי שימוש') }));

// 404: GitHub Pages serves this for any unknown path.
write('404.html', layout('הדף לא נמצא', `<div class="empty">${icon('search', 'ico lg')}<h2>הדף שחיפשתם לא נמצא</h2><p>ייתכן שהקישור שגוי, או שהדף הועבר. נסו לחפש:</p>${searchForm.replace('class="hsearch"', 'class="hsearch light"')}<p><a class="btn" href="/">לדף הבית</a> <a class="btn ghost" href="/shut/">לשו״ת ברסלב</a></p></div>`, { path: '', self: '/404.html', index: false, head: phead('שגיאה 404', 'הדף לא נמצא') }));

write('site.webmanifest', JSON.stringify({ name: SITE, short_name: SITE, description: DESC, lang: 'he', dir: 'rtl', start_url: `${BASE}/`, scope: `${BASE}/`, display: 'standalone', background_color: '#0b1d50', theme_color: '#0b1d50', icons: [192, 512].map((n) => ({ src: `${BASE}/img/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'any maskable' })) }));
// llms.txt: a plain summary of the site for AI engines (https://llmstxt.org)
write('llms.txt', `# ${SITE}

> אתר חסידות ברסלב של קהילת "היכל הקודש": שו״ת ברסלב מאת מוהרא״ש, רבי אליעזר שלמה שיק זצ״ל (הצדיק מיבנאל), מכתבים, ומידע על יבנאל ועל הקהילה.

## רבי נחמן מברסלב ואומן
- [רבי נחמן מברסלב](${ORIGIN + BASE}/rabbi-nachman/): ${nik(rn.short)}
- [אומן](${ORIGIN + BASE}/uman/): ${nik(um.short)}
- [התיקון הכללי](${ORIGIN + BASE}/tikkun-haklali/): ${nik(tk.short)} PDF: ${ORIGIN + BASE}/books/tikkun-haklali.pdf

## הצדיק מיבנאל
- [מוהרא״ש – הצדיק מיבנאל](${ORIGIN + BASE}/moharash/): ${nik(mo.lead)}
- [ציון מוהרא״ש – קבר הצדיק מיבנאל](${ORIGIN + BASE}/moharash/tziyun/): ${nik(mo.tziyun.lead)}
${lib.books.map((b) => `- [${b.title}](${ORIGIN + BASE}/library/${b.slug}/): ${nik(b.lead)} PDF: ${ORIGIN + BASE}${b.pdf}`).join('\n')}

## יבנאל
- [יבנאל](${ORIGIN + BASE}/yavniel/): ${nik(yv.lead)} תולדות, קהילה, זמני תפילה, שיעורים ומקוואות.
- [מקווה מלכה](${ORIGIN + BASE}/mikveh-malka/): ${nik(mk.lead)}

## תוכן
- [שו״ת ברסלב](${ORIGIN + BASE}/shut/): ${shut.length} שאלות ותשובות שכתב מוהרא״ש בעבודת ה׳, אמונה, תפילה והתבודדות.
- [מכתבים](${ORIGIN + BASE}/letters/): מכתבים כלליים לאנשי שלומנו.
- [הדפסת אשר בנחל](${ORIGIN + BASE}/print/): שותפות בהדפסת ספרי הצדיק.
- [ישיבת בית מנחם](${ORIGIN + BASE}/yeshiva/)
- [אודות](${ORIGIN + BASE}/about/)
`);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/print/', '/print/promise/', '/print/donate/', '/yeshiva/', '/shut/', '/letters/', '/halacha/', '/rabbi-nachman/', '/uman/', '/tikkun-haklali/', '/moharash/', '/moharash/tziyun/', '/library/', ...lib.books.map((b) => `/library/${b.slug}/`), ...Object.entries(bookChapters).flatMap(([slug, chs]) => chs.map((c) => `/library/${slug}/${c.id}/`)), '/yavniel/', '/mikveh-malka/', ...(institutions.length ? ['/institutions/'] : []), '/about/', '/contact/', '/accessibility/', '/privacy/', ...Array.from({ length: pages - 1 }, (_, i) => `/shut/page/${i + 2}/`), ...indexed.map(([b, x]) => `/${b}/${x.id}/`)].map((u) => `<url><loc>${esc(ORIGIN + BASE + u)}</loc></url>`).join('')}</urlset>`);
write('robots.txt', `User-agent: *\nAllow: /\n${ORIGIN ? `Sitemap: ${ORIGIN}${BASE}/sitemap.xml\n` : ''}`);
// HTTP security headers (honoured by Netlify; GitHub Pages ignores this file and relies on the meta CSP).
write('_headers', `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), payment=(self ${frames.map((o) => `"${o}"`).join(' ')})
`);
console.log(`built ${shut.length} Q&A pages, ${letters.length} letters, ${halacha.length} halacha, ${pages} list pages`);
