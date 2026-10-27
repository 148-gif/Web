// Page shell: security policy, menus, icons and the layout every page is built with.
import { createHash } from 'node:crypto';
import { SITE, BASE, ORIGIN, BUILD, font, escAttr, esc, url, tel, nik, gist, shut, letters, institutions, pr, site, isHidden, topics, cmsPages } from './core.mjs';

// Security policy. Inline scripts (head bootstrap, speculation rules) and the splash styles are allowed by hash.
const CSS_URL = `${BASE}/style.css?v=${BUILD}`;
// Head bootstrap, inlined at the top of every page.
// The stylesheet is added from here rather than as a <link> in the HTML, so it never blocks the first paint.
// Until it is in, the page stays hidden: behind the branded splash on the first page of a visit (which also waits
// for the fonts), otherwise only for the moment it takes to come from the cache. Either way it appears once, styled.
const HEAD_JS = [
  // Wrapped in a function so none of its variables leak into the page's global scope (where site scripts live too).
  "(function(){var d=document.documentElement,sp=0,ready=function(){d.classList.add('ready')};d.classList.add('js');",
  // Saved text size, and whether the splash was already shown this visit; storage may be blocked, so both are optional.
  "try{var rs=parseFloat(localStorage.getItem('rs'));if(rs>=0.85&&rs<=1.5)d.style.setProperty('--rs',rs);if(!sessionStorage.getItem('seen')){sp=1;sessionStorage.setItem('seen',1)}}catch(e){}",
  `d.classList.add(sp?'splash':'wait');var l=document.createElement('link'),f=document.fonts;l.rel='stylesheet';l.href='${CSS_URL}';`,
  `l.onload=l.onerror=function(){(sp&&f&&f.load?Promise.all([f.load('1em Assistant','א1'),f.load('900 1em "Frank Ruhl Libre"','א1')]):Promise.resolve()).then(ready,ready)};`,
  // Never leave the page hidden: show it after 6 seconds even if the stylesheet is still on its way.
  'document.head.appendChild(l);setTimeout(ready,6000)})()',
].join('');
// Prefetch same-site pages on hover/touch so navigation feels instant.
// PDFs are left out: a hover would otherwise download the whole book.
const SPEC = '{"prefetch":[{"where":{"and":[{"href_matches":"/*"},{"not":{"href_matches":"/*.pdf"}}]},"eagerness":"moderate"}]}';
const sha = (t) => `'sha256-${createHash('sha256').update(t).digest('base64')}'`;
const frames = [pr.donate.iframeUrl].filter(Boolean).map((u) => new URL(u).origin);
// First page of a visit: a branded splash shows until the stylesheet and the fonts are in (see HEAD_JS).
// The page itself stays out of layout until then, so it appears once, styled, instead of jumping (CLS).
const SPLASH_CSS = '#splash{display:none}.wait:not(.ready) body{visibility:hidden}.splash:not(.ready) body>:not(#splash){display:none}.splash #splash{display:flex;position:fixed;inset:0;z-index:100;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:radial-gradient(120% 90% at 50% 0,#1a46a3,#0b1d50 55%,#071338);color:#e6c466;font:900 1.7rem/1.2 "Frank Ruhl Libre",David,serif;transition:opacity .45s;animation:spout .4s 6s forwards}#splash small{font:600 .8rem Assistant,Arial,sans-serif;letter-spacing:.14em;color:#c9d3ef}#splash .spm{width:88px;height:88px;border-radius:50%;display:grid;place-items:center;border:1.5px solid #e6c466;background:radial-gradient(circle at 50% 35%,#2a5bc4,#0d2466 70%);animation:spp 1.6s infinite}#splash svg{width:46px;height:46px}#splash i{width:140px;height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,#e6c466,transparent) 0 0/50% 100% no-repeat;animation:sps 1.1s ease-in-out infinite alternate}html.ready #splash{opacity:0;visibility:hidden;transition:opacity .45s,visibility 0s .45s}@keyframes spp{0%{box-shadow:0 0 0 0 rgba(230,196,102,.55)}70%,100%{box-shadow:0 0 0 20px rgba(230,196,102,0)}}@keyframes sps{to{background-position:100% 0}}@keyframes spout{to{opacity:0;visibility:hidden}}@media (prefers-reduced-motion:reduce){#splash,#splash *{animation:none!important}}';
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${sha(HEAD_JS)} ${sha(SPEC)}`,
  // No inline style attributes anywhere; the one <style> block (the splash) is allowed by its hash.
  `style-src 'self' ${sha(SPLASH_CSS)}`,
  "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  `frame-src ${frames.join(' ') || "'none'"}`,
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

// Site sections in four groups: drives the header dropdowns, the mobile menu, the home tiles and the footer.
const groups = [
  ['לימוד', [['/shut/', 'שו״ת ברסלב', 'chat', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות`], ['/letters/', 'מכתבים', 'letter', `${letters.length} מכתבים כלליים`], ['/library/', 'ספרייה', 'books', 'ספרי הצדיק לקריאה ולהורדה'], ['/halacha/', 'שו״ת הלכתי', 'scale', 'שאלות בהלכה']]],
  ['רבי נחמן מברסלב', [['/rabbi-nachman/', 'רבי נחמן', 'crown', 'רבינו, חייו, תורתו ודרכו'], ['/uman/', 'אומן', 'pin', 'ציון רבינו וקיבוץ ראש השנה'], ['/tikkun-haklali/', 'התיקון הכללי', 'lyre', 'עשרה מזמורי תהלים']]],
  ['הצדיק מיבנאל', [['/moharash/', 'הצדיק מיבנאל', 'flame', 'מוהרא״ש: חייו ודרכו'], ['/moharash/tziyun/', 'ציון הצדיק', 'candle', 'ההבטחות ודרכי הגעה'], ['/yeshiva/', 'ישיבת בית מנחם', 'school', 'ישיבה חסידית בנשיאותו'], ['/print/', 'הדפסת אשר בנחל', 'print', 'שותפות בהדפסת ספריו']]],
  ['יבנאל עיר ברסלב', [['/yavniel/', 'יבנאל', 'mountain', 'קהילה, תפילות ומידע'], ['/mikveh-malka/', 'מקווה מלכה', 'drop', 'מקווה טהרה לנשים'], ...(institutions.length ? [['/institutions/', 'מוסדות הקהילה', 'heart', 'תמיכה ותרומות']] : [])]],
  // Topics from the editor: a menu group per topic, but only once it has pages (an empty topic is never shown).
  ...topics.map((t) => [t.title, cmsPages.filter((p) => p.topic === t.slug).map((p) => [`/${t.slug}/${p.slug}/`, p.title, t.icon || 'book', p.lead || ''])]),
].map(([g, xs]) => [g, xs.filter(([h]) => !isHidden(h))]).filter(([, xs]) => xs.length);
const nav = [['/', 'בית', 'home'], ...groups.flatMap(([, xs]) => xs), ['/search/', 'חיפוש', 'search']];
const inGroup = (xs, path) => xs.some(([h]) => h === path || (h !== '/' && path.startsWith(h)));
const menuLink = ([h, t, ic], path) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${icon(ic, 'ico sm')}${t}</a>`;
const mainMenu = (path) => `<a class="solo" href="/"${path === '/' ? ' aria-current="page"' : ''}>${icon('home', 'ico sm')}בית</a>${groups.map(([g, xs], k) => `<div class="dd${inGroup(xs, path) ? ' cur' : ''}" data-label="${g}"><button type="button" class="ddb" aria-expanded="false" aria-controls="dd${k}">${g}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="ddp" id="dd${k}">${xs.map((x) => menuLink(x, path)).join('')}</div></div>`).join('')}<a class="solo" href="/search/"${path === '/search/' ? ' aria-current="page"' : ''}>${icon('search', 'ico sm keep')}חיפוש</a>`;
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
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><path d="M5 19h14"/>',
  lyre: '<path d="M7 3c-3 3-3 8 0 11M17 3c3 3 3 8 0 11"/><path d="M7 14h10v3a5 5 0 0 1-10 0z"/><path d="M10 6v8M14 6v8"/>',
  candle: '<path d="M12 2c1.5 2 2 3.2 2 4.2a2 2 0 0 1-4 0C10 5.2 10.5 4 12 2Z"/><rect x="8.5" y="10" width="7" height="11" rx="1"/><path d="M5 21h14"/>',
  books: '<path d="M4 4h4v16H4zM9.5 4h4v16h-4z"/><path d="m15 5.2 3.8-1 3.2 15.6-3.8 1z"/>',
  heart: '<path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6a5 5 0 1 1 7.5 6.6Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  arrow: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  sunrise: '<path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 4v5M9 6l3-3 3 3M4.2 12.2l1.4 1.4M19.8 12.2l-1.4 1.4"/>',
  sunset: '<path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 3v5M9 6l3 3 3-3M4.2 12.2l1.4 1.4M19.8 12.2l-1.4 1.4"/>',
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
  sparkle: '<path d="M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  mountain: '<path d="m2 20 7-12 4 6.5 3-4.5 6 10z"/><circle cx="17" cy="6" r="1.8"/>',
};
const icon = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const orn = `<div class="orn-rule" aria-hidden="true"><i></i>${icon('flame')}<i></i></div>`;
const phead = (kicker, title, lead = '', extra = '') => `<section class="phead"><div class="wrap">${kicker ? `<p class="kicker2">${kicker}</p>` : ''}<h1>${title.replace(/ ([–—]) /g, '\u00a0$1 ')}</h1>${lead ? `<p class="sub">${lead}</p>` : ''}${extra}</div></section>`;
const splash = `<div id="splash" aria-hidden="true"><span class="spm">${icon('flame')}</span><span>${SITE}</span><small>חסידות ברסלב</small><i></i></div>`;
// Every page needs both subsets of both fonts: Hebrew for the letters, Latin for spaces, digits and punctuation.
// Preloading all four lets them arrive together, so text is not laid out again when a late subset swaps in (CLS).
const PRELOAD_FONTS = ['assistant-hebrew', 'assistant-latin', 'frank-ruhl-libre-hebrew', 'frank-ruhl-libre-latin'].map((f) => `${f}.woff2`);
// Default description, used by the home page: only sections that are live (letters, halacha and institutions are hidden for now).
const DESC = 'היכל הקודש, חסידות ברסלב: שו״ת ברסלב של מוהרא״ש, ספרי הצדיק לקריאה, רבי נחמן ואומן, התיקון הכללי, יבנאל והדפסת ״אשר בנחל״.';
// Share previews (WhatsApp, Facebook) need absolute URLs, so canonical/og:url/og:image appear only when SITE_ORIGIN is set.
const abs = (p) => esc(ORIGIN + BASE + p);
const layout = (title, body, { desc = '', path = '/', self = path, head = '', full = false, reading = false, head_extra = '', index = true } = {}) => `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="strict-origin-when-cross-origin"><script>${HEAD_JS}</script>
<title>${escAttr(nik(title))}${title === SITE ? '' : ' | ' + SITE}</title><meta name="description" content="${escAttr(nik(desc || DESC))}">${index ? '' : '<meta name="robots" content="noindex">'}
<meta name="theme-color" content="#0b1d50"><meta property="og:title" content="${escAttr(nik(title))}"><meta property="og:description" content="${escAttr(nik(desc || DESC))}"><meta property="og:site_name" content="${SITE}"><meta property="og:locale" content="he_IL"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">${ORIGIN && index ? `<link rel="canonical" href="${abs(self)}"><meta property="og:url" content="${abs(self)}"><meta property="og:image" content="${abs('/img/og.png')}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : ''}
<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/img/icon-180.png"><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0b1d50"/><g fill="none" stroke="#e6c466" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON.flame}</g></svg>`)}">
${PRELOAD_FONTS.map((f) => `<link rel="preload" href="/${font(f)}" as="font" type="font/woff2" crossorigin>`).join('')}
<noscript><link rel="stylesheet" href="/style.css?v=${BUILD}"></noscript><style>${SPLASH_CSS}</style>
${head_extra}</head><body>
${splash}<a class="skip" href="#main">דלגו לתוכן</a>
<header class="top"><div class="bar"><a class="brand" href="/"><span class="mark">${icon('flame')}</span><span>${SITE}<small>חסידות ברסלב</small></span></a><div class="hacts"><a class="iconbtn" href="/search/" aria-label="חיפוש">${icon('search')}</a><button class="iconbtn mbtn" type="button" aria-expanded="false" aria-controls="mainnav" aria-label="תפריט">${icon('menu', 'ico i-open')}${icon('close', 'ico i-close')}</button></div><nav id="mainnav" aria-label="ניווט ראשי">${mainMenu(path)}</nav></div>${reading ? '<div class="readbar" aria-hidden="true"><i></i></div>' : ''}</header>
<main id="main">${head}${full ? body : `<div class="page">${body}</div>`}</main>
<footer class="foot"><div class="wrap"><div class="fbrand"><span class="mark">${icon('flame')}</span><div><b>${SITE}</b><span>אור הצדיק לכל נפש</span></div></div>
<nav aria-label="ניווט תחתון">${nav.slice(1, -1).map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
<nav class="finfo" aria-label="מידע על האתר">${infoNav.map(([h, t]) => `<a href="${h}"${h === self ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
<p>שו״ת ברסלב נכתב על ידי <a href="/moharash/">הצדיק מיבניאל זצ״ל</a>, ופורסם ברשות להעתקה והפצה.</p>${orgLine ? `<p>${orgLine}</p>` : ''}</div></footer><button type="button" class="totop" aria-label="חזרה לראש העמוד" hidden><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button><script src="/app.js?v=${BUILD}" defer></script><script type="speculationrules">${SPEC}</script></body></html>`;

const sr = (t) => `<h2 class="sr">${t}</h2>`;
const card = (x, base = '/shut/') => `<a class="card qcard" href="${base}${x.id}/"><h3>${esc(x.title)}</h3><p>${esc(gist(x.a).slice(0, 150))}…</p><span class="go">לקריאת התשובה ←</span></a>`;

export { CSS_URL, HEAD_JS, PRELOAD_FONTS, SPEC, sha, frames, CSP, groups, nav, inGroup, menuLink, mainMenu, org, sc, orgLine, wa, contactList, infoNav, ICON, icon, orn, phead, SPLASH_CSS, splash, DESC, abs, layout, sr, card };
