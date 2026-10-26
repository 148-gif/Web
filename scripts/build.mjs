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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

const nav = [['/', 'בית', 'home'], ['/print/', 'הדפסת אשר בנחל', 'print'], ['/yeshiva/', 'ישיבת בית מנחם', 'school'], ['/shut/', 'שו״ת ברסלב', 'book'], ['/letters/', 'מכתבים', 'letter'], ['/halacha/', 'שו״ת הלכתי', 'scale'], ['/yavniel/', 'יבנאל', 'pin'], ...(institutions.length ? [['/institutions/', 'מוסדות הקהילה', 'heart']] : []), ['/search/', 'חיפוש', 'search']];
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
<p>שו״ת ברסלב נכתב על ידי הצדיק מיבניאל זצ״ל, ופורסם ברשות להעתקה והפצה.</p>${orgLine ? `<p>${orgLine}</p>` : ''}</div></footer><script src="/app.js?v=${BUILD}" defer></script><script type="speculationrules">{"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}]}</script></body></html>`;

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


// Yavniel
const ul = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;
const navBtns = (q) => `<p class="ctarow"><a class="btn" href="${url(`https://www.waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`)}" rel="noopener">ניווט ב־Waze</a> <a class="btn ghost" href="${url(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`)}" rel="noopener">ניווט ב־Google Maps</a></p>`;
const ps = (xs) => xs.map((p) => `<p>${esc(p)}</p>`).join('');
const groups = (gs) => gs.map(([t, n, xs]) => `<h3>${esc(t)}</h3>${n ? `<p>${esc(n)}</p>` : ''}${ul(xs.map(esc))}`).join('');
write('yavniel/index.html', layout('יבנאל', `<section class="band"><div class="wrap narrow"><h2 class="sh">על היישוב</h2>${orn}<div class="about">${ps(yv.intro)}</div></div></section>
<section class="band soft"><div class="wrap"><h2 class="sh">מסע בזמן</h2><p class="shsub">תחנות בתולדות המושבה</p><div class="needs values">${yv.timeline.map(([t, d]) => `<div class="need"><span class="orn">✦</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div><p class="shsub">${esc(yv.livelihood)}</p></div></section>
<section class="band"><div class="wrap narrow"><h2 class="sh">קהילת ברסלב ביבנאל</h2>${orn}<div class="about">${ps(yv.community)}</div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">${esc(yv.cityTitle)}</h2><div class="about">${ps(yv.city)}${yv.quotes.map(([q, by]) => `<blockquote><p>${esc(q)}</p><footer>${esc(by)}</footer></blockquote>`).join('')}</div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">${esc(yv.fromShutTitle)}</h2><p class="shsub">${esc(yv.fromShutLead)}</p><div class="about">${yv.fromShut.map(([t, ids]) => `<p>${esc(t)} ${ids.map((i) => `<a href="/shut/${i}/">לתשובה ←</a>`).join(' · ')}</p>`).join('')}</div></div></section>
<section class="band"><div class="wrap narrow"><h2 class="sh">ציון הצדיק</h2>${orn}<div class="about">${ps(yv.zion)}<p>${esc(yv.promiseNote)}</p><blockquote><p>${esc(yv.promise)}</p></blockquote></div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">זמני תפילה בימי חול</h2><div class="about">${groups(yv.weekday)}<p>${esc(yv.weekdayNote)}</p><p>${esc(yv.prayerNote)}</p></div></div></section>
<section class="band"><div class="wrap narrow"><h2 class="sh">זמני תפילה בשבת</h2><div class="about">${groups(yv.shabbat)}<p>${esc(yv.shabbatNote)}</p></div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">שיעורי תורה</h2><div class="about">${groups(yv.lessons.map(([t, xs]) => [t, '', xs]))}<h3>אבות ובנים</h3><p>${esc(yv.fathers)}</p></div></div></section>
<section class="band"><div class="wrap narrow"><h2 class="sh">מקוואות</h2><div class="about"><h3>מקווה גברים</h3>${ul(yv.mikvehMen.map(esc))}<p>${esc(yv.mikvehMenNote)}</p><h3>מקווה נשים: מקווה מלכה</h3>${ul(yv.mikvehWomen.map(esc))}<p>${esc(yv.mikvehWomenNote)} <a href="/mikveh-malka/">לדף מקווה מלכה ←</a></p><p>לתיאום הגעה ולפרטים נוספים: <a href="tel:${tel(yv.mikvehWomenPhone)}">${esc(yv.mikvehWomenPhone)}</a></p></div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">בית התבשיל וערב שמחה לנשים</h2><div class="about">${ps(yv.kitchen)}<p>${esc(yv.womenEvening)}</p></div></div></section>
<section class="band"><div class="wrap narrow"><h2 class="sh">הגעה</h2><div class="about"><p>${esc(yv.directions)}</p>${navBtns(yv.navQuery)}</div><h2 class="sh">מקורות</h2>${ul(yv.sources.map(([t, u]) => `<a href="${url(u)}" rel="noopener">${esc(t)}</a>`))}</div></section>`,
  { desc: 'יבנאל עיר ברסלב: תולדות המושבה, קהילת חסידי ברסלב, ציון מוהרא״ש, זמני תפילה, מקוואות ושיעורים', path: '/yavniel/', full: true, head: phead('הגליל התחתון', 'יבנאל', esc(yv.lead)) }));

// Malka mikveh
write('mikveh-malka/index.html', layout('מקווה מלכה', `<section class="band"><div class="wrap narrow"><h2 class="sh">על המקווה</h2>${orn}<div class="about">${ps(mk.about)}</div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">${esc(mk.storyTitle)}</h2><div class="about">${ps(mk.story)}</div></div></section>
<section class="band"><div class="wrap narrow"><h2 class="sh">${esc(mk.promiseTitle)}</h2>${orn}<div class="about"><blockquote><p>${esc(mk.promise)}</p></blockquote>${ps(mk.promiseAfter)}</div></div></section>
<section class="band soft"><div class="wrap narrow"><h2 class="sh">${esc(mk.hoursTitle)}</h2><div class="about">${ul(mk.hours.map(esc))}<p>${esc(mk.phoneNote)} <a href="tel:${tel(mk.phone)}">${esc(mk.phone)}</a></p><h3>${esc(mk.attendantsTitle)}</h3>${ul(mk.attendants.map(([n, ts]) => `${esc(n)}: ${ts.map((t) => `<a href="tel:${tel(t)}">${esc(t)}</a>`).join(' · ')}`))}<p>כתובת: ${esc(mk.address)}</p>${navBtns(mk.navQuery)}<p><a href="/yavniel/">← לדף יבנאל</a></p></div></div></section>`,
  { desc: 'מקווה מלכה ביבנאל: מקווה טהרה לנשים, סיפור בנייתו, הבטחת הצדיק מיבנאל, שעות פעילות וטלפון', path: '/mikveh-malka/', full: true, head: phead('יבנאל', 'מקווה מלכה', esc(mk.lead)) }));

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
const indexed = [...shut.map((x) => ['shut', x]), ...letters.map((x) => ['letters', x]), ...halacha.map((x) => ['halacha', x])];
const shardSize = Math.ceil(indexed.length / SHARDS);
write('idx/titles.json', JSON.stringify({ n: SHARDS, size: shardSize, t: indexed.map(([b, x]) => [`${b}/${x.id}`, x.title]) }));
for (let k = 0; k < SHARDS; k++) write(`idx/${k}.json`, JSON.stringify(indexed.slice(k * shardSize, (k + 1) * shardSize).map(([, x]) => words((x.title + ' ' + x.q.join(' ') + ' ' + x.a.join(' ')).slice(0, 600), new Set(words(x.title).split(' '))))));
const preloads = ['titles', ...Array.from({ length: SHARDS }, (_, k) => k)].map((f) => `<link rel="preload" href="/idx/${f}.json?v=${BUILD}" as="fetch" crossorigin>`).join('');
write('search/index.html', layout('חיפוש', `${sr('תוצאות החיפוש')}<p id="count" class="small count" aria-live="polite"></p><div id="results" class="grid"></div><script src="/search.js?v=${BUILD}" defer></script>`, { path: '/search/', head_extra: preloads, head: phead('בכל אלפי השאלות והמכתבים', 'חיפוש באתר', '', `<div class="hsearch">${icon('search', 'ico sm')}<input id="q" type="search" placeholder="הקלידו מילה או ביטוי…" aria-label="חיפוש" autofocus></div><div class="chips">${chips}</div>`) }));

// Home
const tile = (href, ic, t, d) => `<a class="tile" href="${href}">${icon(ic, 'ico lg')}<b>${t}</b><span>${d}</span><i class="arr">${icon('arrow', 'ico sm')}</i></a>`;
write('index.html', layout(SITE, `<section class="band"><div class="wrap"><div class="tiles">
${tile('/shut/', 'book', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות`)}${tile('/letters/', 'letter', 'מכתבים', `${letters.length} מכתבים כלליים`)}${tile('/yeshiva/', 'school', 'ישיבת בית מנחם', 'ישיבה חסידית')}${tile('/halacha/', 'scale', 'שו״ת הלכתי', 'שאלות בהלכה')}${institutions.length ? tile('/institutions/', 'heart', 'מוסדות הקהילה', 'תמיכה ותרומות') : ''}</div>
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
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/print/', '/print/promise/', '/print/donate/', '/yeshiva/', '/shut/', '/letters/', '/halacha/', '/yavniel/', '/mikveh-malka/', ...(institutions.length ? ['/institutions/'] : []), '/about/', '/contact/', '/accessibility/', '/privacy/', ...Array.from({ length: pages - 1 }, (_, i) => `/shut/page/${i + 2}/`), ...indexed.map(([b, x]) => `/${b}/${x.id}/`)].map((u) => `<url><loc>${esc(ORIGIN + BASE + u)}</loc></url>`).join('')}</urlset>`);
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
