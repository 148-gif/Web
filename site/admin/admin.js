// Site editor (/admin/): dashboard, pages and topics, the site's content files, the Q&A archive and the editors list.
// Data lives in data/*.json in the GitHub repository; every save is a commit to the publishing branch, and the Pages
// workflow then tests, builds and publishes it. Sign-in: with Google through the editor server (cms-worker/, when
// config.json has "worker"), which holds the GitHub key and checks the email; otherwise with a personal GitHub token.
// Screens are addressed by the URL hash (#/pages, #/file/uman.json, #/shut/123 …), so the browser's back button works.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function el(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; if (Array.isArray(c)) c.forEach(function (x) { if (x) e.append(x); }); else e.append(c); }
    return e;
  }
  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/>',
    page: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h6"/>',
    chat: '<path d="M4 19.5 5.3 15A8 8 0 1 1 8.6 18.4Z"/><path d="M9 10h6M9 13h4"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5"/>',
    books: '<path d="M4 4h4v16H4zM9.5 4h4v16h-4z"/><path d="m15 5.2 3.8-1 3.2 15.6-3.8 1z"/>',
    crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><path d="M5 19h14"/>',
    pin: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
    lyre: '<path d="M7 3c-3 3-3 8 0 11M17 3c3 3 3 8 0 11"/><path d="M7 14h10v3a5 5 0 0 1-10 0z"/><path d="M10 6v8M14 6v8"/>',
    flame: '<path d="M12 2c.6 3.2 4.8 5.3 4.8 10.1A4.8 4.8 0 0 1 12 17a4.8 4.8 0 0 1-4.8-4.9c0-2.2 1.2-3.7 2.3-4.6 0 1.7.8 2.9 1.9 3.3C11 8.3 10.9 5 12 2Z"/><path d="M12 22c-2.8 0-5-1.2-5-2.7 0-.8.6-1.5 1.6-2"/><path d="M15.4 17.3c1 .5 1.6 1.2 1.6 2 0 1.5-2.2 2.7-5 2.7"/>',
    school: '<path d="M2 21h20M4 21V10l8-6 8 6v11"/><path d="M9 21v-5a3 3 0 0 1 6 0v5"/>',
    print: '<path d="M6 9V2h12v7"/><rect x="2" y="9" width="20" height="9" rx="2"/><path d="M6 14h12v8H6z"/>',
    mountain: '<path d="m2 20 7-12 4 6.5 3-4.5 6 10z"/><circle cx="17" cy="6" r="1.8"/>',
    drop: '<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z"/>',
    heart: '<path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6a5 5 0 1 1 7.5 6.6Z"/>',
    scale: '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.3A5 5 0 0 1 21.5 19"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    text: '<path d="M4 6h16M4 10h16M4 14h10M4 18h12"/>',
    cards: '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>',
    faq: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01"/>',
    quote: '<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    candle: '<path d="M12 2c1.5 2 2 3.2 2 4.2a2 2 0 0 1-4 0C10 5.2 10.5 4 12 2Z"/><rect x="8.5" y="10" width="7" height="11" rx="1"/>',
    letter: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    sparkle: '<path d="M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  function icon(n, cls) { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[n] || ICON.page; return s; }

  // ---- what the editor knows about the site ----
  // Sections of the site, as in its menus: [data file, name, icon, page on the site].
  var GROUPS = [
    ['לימוד', [['library.json', 'ספרייה', 'books', '/library/'], ['kuntresim.json', 'קונטרסים', 'book', '/library/kuntresim/'], ['halacha.json', 'שו״ת הלכתי', 'scale', '/halacha/']]],
    ['רבי נחמן מברסלב', [['rabbi-nachman.json', 'רבי נחמן', 'crown', '/rabbi-nachman/'], ['uman.json', 'אומן', 'pin', '/uman/'], ['tikkun.json', 'התיקון הכללי', 'lyre', '/tikkun-haklali/']]],
    ['הצדיק מיבנאל', [['moharash.json', 'הצדיק מיבנאל', 'flame', '/moharash/'], ['yeshiva.json', 'ישיבת בית מנחם', 'school', '/yeshiva/'], ['print.json', 'הדפסת אשר בנחל', 'print', '/print/']]],
    ['יבנאל', [['yavniel.json', 'יבנאל', 'mountain', '/yavniel/'], ['mikveh.json', 'מקווה מלכה', 'drop', '/mikveh-malka/'], ['institutions.json', 'מוסדות הקהילה', 'heart', '/institutions/']]],
  ];
  var FILE = {}; GROUPS.forEach(function (g) { g[1].forEach(function (f) { FILE[f[0]] = { name: f[1], icon: f[2], url: f[3] }; }); });
  FILE['site.json'] = { name: 'הגדרות האתר', icon: 'gear', url: '' };
  // Field names in Hebrew. Unknown fields fall back to their own name.
  var LABELS = {
    title: 'כותרת', lead: 'פתיח', short: 'תקציר קצר (לחיפוש)', desc: 'תיאור', text: 'טקסט', paragraphs: 'פסקאות', items: 'פריטים', q: 'שאלה', a: 'תשובה', by: 'מקור', url: 'קישור', name: 'שם',
    slug: 'מזהה בכתובת', topic: 'נושא', blocks: 'תוכן הדף', icon: 'סמל', phone: 'טלפון', email: 'דוא״ל', address: 'כתובת', hours: 'שעות', intro: 'פתיח', summary: 'תקציר', faq: 'שאלות נפוצות',
    sources: 'מקורות', path: 'נתיב', why: 'סיבה', hidden: 'חלקים מוסתרים מהגולשים', contact: 'פרטי קשר', whatsapp: 'וואטסאפ', subtitle: 'כותרת משנה', about: 'אודות', sub: 'כותרת משנה',
    goal: 'יעד', link: 'קישור', groups: 'קבוצות', group: 'קבוצה', pages: 'עמודים', size: 'גודל', categories: 'קטגוריות', books: 'ספרים', noCopyright: 'הצהרת ״אין זכויות יוצרים״', noCopyrightBy: 'מקור ההצהרה',
    parts: 'חלקים', facts: 'פרטים עיקריים', pdf: 'קובץ PDF', pdfSize: 'גודל הקובץ', category: 'קטגוריה', online: 'זמין באתר', soon: 'בקרוב', storyTitle: 'כותרת הסיפור', story: 'הסיפור',
    promiseTitle: 'כותרת ההבטחה', promise: 'ההבטחה', hoursTitle: 'כותרת השעות', phoneNote: 'הערה לטלפון', attendants: 'בלניות', attendantsTitle: 'כותרת הבלניות', navQuery: 'יעד לניווט (Waze)',
    hoursNote: 'הערה לשעות', features: 'מאפיינים', testimonials: 'המלצות', promiseAfter: 'אחרי ההבטחה', fromShutTitle: 'כותרת ״מתוך השו״ת״', fromShutLead: 'פתיח ״מתוך השו״ת״', fromShut: 'שאלות מתוך השו״ת',
    navLL: 'קואורדינטות לניווט', acronym: 'ראשי תיבות', life: 'תולדות חייו', community: 'הקהילה', teachings: 'תורתו', sources15: 'מקורות', passing: 'הסתלקותו', legacyQuote: 'ציטוט מורשת',
    legacyBy: 'מקור הציטוט', tziyun: 'הציון', quick: 'פרטים מהירים', vow: 'ההבטחה', vowNote: 'הערה להבטחה', promisesLead: 'פתיח להבטחות', promises: 'הבטחות', uman: 'אומן', hillula: 'ההילולא', nav: 'ניווט',
    routes: 'דרכי הגעה', transit: 'תחבורה ציבורית', lifeLead: 'פתיח לתולדות', donate: 'תרומה', iframeUrl: 'כתובת טופס התרומה', fallbackUrl: 'כתובת חלופית', hero: 'ראש העמוד', kicker: 'שורה עליונה',
    headline: 'כותרת ראשית', promiseText: 'נוסח ההבטחה', needs: 'בקשות', steps: 'שלבים', tiers: 'דרגות תרומה', amount: 'סכום', tag: 'תגית', tiersNote: 'הערה לדרגות', quote: 'ציטוט', quoteBy: 'מקור הציטוט',
    stats: 'מספרים', trust: 'אמון', finalCta: 'קריאה לפעולה בסוף', head: 'כותרת', raised: 'נאסף', target: 'יעד', label: 'תווית', works: 'ספריו', natan: 'רבי נתן', tikkun: 'התיקון הכללי', psalms: 'המזמורים',
    page: 'עמוד', stories: 'סיפורים', org: 'פרטי העמותה', number: 'מספר עמותה', section46: 'אישור סעיף 46', accessibility: 'נגישות', coordinator: 'רכז הנגישות', updated: 'עודכן בתאריך', origin: 'מקור',
    vowBy: 'מקור ההבטחה', strong: 'ציטוט מודגש', explanationTitle: 'כותרת ההסבר', explanationLead: 'פתיח ההסבר', textNote: 'הערה לנוסח', shut: 'שאלות מהשו״ת', history: 'היסטוריה', kibbutz: 'קיבוץ ראש השנה',
    sofia: 'גן סופיה', avraham: 'רבי אברהם', visit: 'לפני שנוסעים', sofiaStory: 'סיפור גן סופיה', holocaust: 'השואה', ironCurtain: 'מסך הברזל', today: 'היום', travel: 'נסיעה', note: 'הערה', warning: 'אזהרה',
    timeline: 'ציר זמן', livelihood: 'פרנסה', cityTitle: 'כותרת העיר', city: 'העיר', quotes: 'ציטוטים', zion: 'הציון', promiseNote: 'הערה להבטחה', prayerNote: 'הערה לתפילות', zmanimNote: 'הערה לזמנים',
    liveNote: 'הערה לשידור', weekday: 'תפילות ימי חול', rows: 'שורות', weekdayNote: 'הערה לימי חול', shabbat: 'תפילות שבת', shabbatNote: 'הערה לשבת', lessons: 'שיעורים', fathers: 'אבות ובנים',
    mikvehMen: 'מקווה גברים', mikvehMenNote: 'הערה למקווה גברים', mikvehWomen: 'מקווה נשים', mikvehWomenNote: 'הערה למקווה נשים', kitchen: 'מטבח', womenEvening: 'ערב נשים', directions: 'דרכי הגעה',
    mikvehWomenPhone: 'טלפון מקווה נשים', institutions: 'מוסדות', chesed: 'חסד', nachman: 'רבי נחמן', nachmanBy: 'מקור', banner: 'שורת פתיחה', values: 'ערכים', photos: 'תמונות', id: 'מספר', date: 'תאריך', kind: 'סוג',
  };
  // Lists of fixed-length rows (e.g. a question and its answer): a name for each position. "סמל" positions get an icon picker.
  var TUPLES = {
    groups: ['מזהה', 'שם'], categories: ['מזהה', 'שם'], facts: ['פרט', 'ערך'], online: ['מזהה', 'שם', 'קישור', 'תיאור'], soon: ['מזהה', 'תיאור'], hours: ['ימים', 'שעות'],
    mikvehMen: ['ימים', 'שעות'], mikvehWomen: ['ימים', 'שעות'], features: ['סמל', 'כותרת', 'טקסט'], chesed: ['סמל', 'כותרת', 'טקסט'], quick: ['סמל', 'כותרת', 'טקסט'],
    life: ['תאריך', 'אירוע'], history: ['תאריך', 'אירוע'], timeline: ['תאריך', 'אירוע'], teachings: ['נושא', 'תוכן', 'מקור'], books: ['שם הספר', 'תיאור'], works: ['שם הספר', 'תיאור'],
    faq: ['שאלה', 'תשובה'], items: ['כותרת', 'טקסט'], sources: ['שם המקור', 'קישור'], promises: ['ציטוט', 'מקור'], quotes: ['ציטוט', 'מקור'], routes: ['מאיפה', 'הוראות'], needs: ['נושא', 'תיאור'],
    steps: ['שלב', 'הסבר'], stats: ['מספר', 'תיאור'], shut: ['מספר שאלה', 'כותרת'], stories: ['כותרת', 'סיפור'], rows: ['שעה', 'מקום'], institutions: ['שם', 'פרטים'], values: ['ערך', 'הסבר'],
  };
  var ICON_NAMES = { book: 'ספר', books: 'ספרים', crown: 'כתר', lyre: 'כינור', candle: 'נר', flame: 'להבה', heart: 'לב', star: 'כוכב', users: 'אנשים', letter: 'מכתב', sparkle: 'ניצוץ', home: 'בית', mountain: 'הר', drop: 'טיפה', school: 'בית מדרש', scale: 'מאזניים', pin: 'מיקום', clock: 'שעון', chat: 'שיחה', check: 'וי' };
  // Templates for lists that are empty, so there is a shape to copy.
  var TEMPLATES = { 'halacha.json': { id: '', title: '', q: [''], a: [''], date: '' }, hidden: { path: '/', why: '' }, q: '', a: '', paragraphs: '' };
  var BLOCKS = {
    text: { name: 'טקסט', icon: 'text', hint: 'כותרת ופסקאות', make: function () { return { type: 'text', title: '', paragraphs: [''] }; } },
    cards: { name: 'כרטיסים', icon: 'cards', hint: 'רשת של כרטיסים קצרים', make: function () { return { type: 'cards', title: '', items: [{ title: '', text: '' }] }; } },
    faq: { name: 'שאלות ותשובות', icon: 'faq', hint: 'שאלות שנפתחות בלחיצה', make: function () { return { type: 'faq', title: '', items: [{ q: '', a: '' }] }; } },
    quote: { name: 'ציטוט', icon: 'quote', hint: 'משפט מודגש עם מקור', make: function () { return { type: 'quote', text: '', by: '' }; } },
    links: { name: 'קישורים', icon: 'link', hint: 'רשימת קישורים לאתרים אחרים', make: function () { return { type: 'links', title: '', items: [{ title: '', url: 'https://' }] }; } },
  };
  var RESERVED = ['admin', 'shut', 'letters', 'library', 'halacha', 'rabbi-nachman', 'uman', 'tikkun-haklali', 'moharash', 'yeshiva', 'print', 'yavniel', 'mikveh-malka', 'institutions', 'search', 'about', 'contact', 'accessibility', 'privacy', 'offline', 'fonts', 'img', 'books', 'idx', 'zmanim'];
  var SLUG = /^[a-z0-9-]+$/;

  var cfg, token, owner = false, me = '';
  var cur = null; // the open file: { path, sha, indent, data, orig }
  var cache = { topics: null, pages: null, shutIndex: null };

  // ---- GitHub, directly or through the editor server ----
  function api(path, opt) {
    opt = opt || {};
    var base = cfg.worker ? cfg.worker.replace(/\/$/, '') + '/gh' : 'https://api.github.com/repos/' + cfg.repo;
    var headers = cfg.worker ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } : { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    return fetch(base + (path ? '/' + path : ''), Object.assign({}, opt, { headers: headers })).then(function (r) {
      if (r.ok) return r.status === 204 ? null : r.json();
      if (r.status === 401 && cfg.worker) signout('פג תוקף ההתחברות. התחברו שוב.');
      return r.text().then(function (t) {
        var msg = ''; try { msg = JSON.parse(t).message; } catch { /* not JSON */ }
        var e = new Error(r.status === 409 || r.status === 422 ? 'מישהו אחר שמר את אותו תוכן בינתיים. טענו את הדף מחדש ונסו שוב.' : cfg.worker && msg && r.status !== 404 ? msg : r.status === 401 ? 'המפתח לא תקין או שפג תוקפו' : r.status === 404 ? 'לא נמצא' : 'שגיאה ' + r.status);
        e.status = r.status; throw e;
      });
    });
  }
  var ref = function () { return '?ref=' + encodeURIComponent(cfg.branch); };
  function b64e(s) { var b = new TextEncoder().encode(s), r = ''; for (var i = 0; i < b.length; i += 0x8000) r += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(r); }
  function b64d(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), function (c) { return c.charCodeAt(0); })); }
  function getFile(path) { return api('contents/' + path + ref()).then(function (f) { var text = b64d(f.content); var m = /^\n?( +)"/m.exec(text); var data = JSON.parse(text); return { path: path, sha: f.sha, indent: m ? m[1].length : 2, data: data, orig: JSON.stringify(data) }; }); }
  function putFile(path, data, indent, sha, msg) {
    var body = { message: msg, content: b64e(JSON.stringify(data, null, indent) + '\n'), branch: cfg.branch };
    if (sha) body.sha = sha;
    return api('contents/' + path, { method: 'PUT', body: JSON.stringify(body) });
  }
  function delFile(path, sha, msg) { return api('contents/' + path, { method: 'DELETE', body: JSON.stringify({ message: msg, sha: sha, branch: cfg.branch }) }); }
  function exists(path) { return api('contents/' + path + ref()).then(function () { return true; }, function (e) { if (e.status === 404) return false; throw e; }); }

  // ---- messages and unsaved changes ----
  var tm;
  function say(t, kind) { var m = $('#msg'); m.textContent = t; m.className = 'toast' + (kind ? ' ' + kind : ''); m.hidden = false; clearTimeout(tm); tm = setTimeout(function () { m.hidden = true; }, kind === 'bad' ? 10000 : 5000); }
  function dirty() { return !!cur && JSON.stringify(cur.data) !== cur.orig; }
  window.addEventListener('beforeunload', function (e) { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  function leave() { return !dirty() || confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?'); }
  var stT;
  function touch() { clearTimeout(stT); stT = setTimeout(status, 120); }
  function status() { var s = $('#savestate'); if (!s) return; var d = dirty(); s.textContent = d ? 'יש שינויים שלא נשמרו' : 'כל השינויים שמורים'; s.className = 'state' + (d ? ' dirty' : ''); var u = $('#undo'); if (u) u.hidden = !d; }

  // ---- web addresses from Hebrew titles ----
  var TR = { 'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z', 'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'p', 'ף': 'f', 'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't' };
  function slugify(s) { var r = String(s).toLowerCase().split('').map(function (c) { return TR[c] != null ? TR[c] : /[a-z0-9]/.test(c) ? c : '-'; }).join('').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40); return r || 'page-' + Date.now().toString(36); }

  // ---- form fields ----
  var isObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
  function blank(v) {
    if (typeof v === 'string') return '';
    if (typeof v === 'number') return 0;
    if (typeof v === 'boolean') return false;
    if (Array.isArray(v)) return v.length && typeof v[0] !== 'object' ? (v.length > 4 ? [''] : v.map(blank)) : [];
    if (isObj(v)) { var o = {}; Object.keys(v).forEach(function (k) { o[k] = blank(v[k]); }); return o; }
    return '';
  }
  var uid = 0;
  var LTR = /url|link|email|pdf|iframe|slug|path|navLL|^id$/i;
  function textInput(parent, key, label, opts) {
    opts = opts || {};
    var v = parent[key] == null ? '' : String(parent[key]);
    var long = opts.long || v.length > 60 || v.indexOf('\n') > -1;
    var id = 'f' + (++uid);
    var inp = long ? el('textarea', { id: id, rows: Math.min(12, Math.max(2, Math.ceil(v.length / 70))) }) : el('input', { id: id, type: 'text' });
    inp.value = v;
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.cls) inp.className = opts.cls;
    if (LTR.test(String(opts.k || key))) { inp.dir = 'ltr'; inp.classList.add('ltr'); }
    inp.addEventListener('input', function () { parent[key] = inp.value; touch(); });
    return el('div', { class: 'fld' }, label ? el('label', { for: id, text: label }) : null, inp, opts.help ? el('small', { class: 'help', text: opts.help }) : null);
  }
  function iconPicker(parent, key, label) {
    var id = 'f' + (++uid), sel = el('select', { id: id });
    var names = Object.keys(ICON_NAMES); if (parent[key] && names.indexOf(parent[key]) < 0) names.push(parent[key]);
    names.forEach(function (n) { sel.append(el('option', { value: n, text: ICON_NAMES[n] || n })); });
    sel.value = parent[key];
    var prev = el('span', { class: 'iprev' }, icon(parent[key]));
    sel.addEventListener('change', function () { parent[key] = sel.value; prev.textContent = ''; prev.append(icon(sel.value)); touch(); });
    return el('div', { class: 'fld' }, el('label', { for: id, text: label }), el('div', { class: 'irow' }, prev, sel));
  }
  function field(parent, key, label, ctx) {
    var v = parent[key];
    if (Array.isArray(v)) return listField(parent, key, label, ctx);
    if (isObj(v)) return group(v, label, ctx);
    if (typeof v === 'boolean') { var cb = el('input', { type: 'checkbox' }); cb.checked = v; cb.addEventListener('change', function () { parent[key] = cb.checked; touch(); }); return el('div', { class: 'fld' }, el('label', { class: 'chk' }, cb, label)); }
    if (typeof v === 'number') { var id = 'f' + (++uid), n = el('input', { id: id, type: 'number', step: 'any', class: 'num' }); n.value = v; n.addEventListener('input', function () { parent[key] = n.value === '' ? 0 : Number(n.value); touch(); }); return el('div', { class: 'fld' }, el('label', { for: id, text: label }), n); }
    if (label === 'סמל' || key === 'icon') return iconPicker(parent, key, label);
    return textInput(parent, key, label, { long: key === 'a' || key === 'text' || ctx.long });
  }
  function group(o, label, ctx) {
    var box = el('div', { class: 'grp' }, label ? el('h4', { text: label }) : null);
    Object.keys(o).forEach(function (k) { box.append(field(o, k, LABELS[k] || k, { rerender: ctx.rerender })); });
    return box;
  }
  function summary(v) {
    if (typeof v === 'string') return v;
    var vals = Array.isArray(v) ? v : Object.keys(v || {}).filter(function (k) { return ['type', 'icon', 'slug', 'id'].indexOf(k) < 0; }).map(function (k) { return v[k]; });
    for (var i = 0; i < vals.length; i++) if (typeof vals[i] === 'string' && vals[i] && !SLUG.test(vals[i])) return vals[i];
    return '';
  }
  function move(arr, i, d) { var j = i + d; if (j < 0 || j >= arr.length) return false; var t = arr[i]; arr[i] = arr[j]; arr[j] = t; return true; }
  function tools(arr, i, rerender, what) {
    return el('span', { class: 'tools' },
      el('button', { type: 'button', class: 'ib', title: 'הזזה למעלה', 'aria-label': 'הזזה למעלה', disabled: i === 0, onclick: function (e) { e.preventDefault(); if (move(arr, i, -1)) { touch(); rerender(); } } }, icon('up')),
      el('button', { type: 'button', class: 'ib', title: 'הזזה למטה', 'aria-label': 'הזזה למטה', disabled: i === arr.length - 1, onclick: function (e) { e.preventDefault(); if (move(arr, i, 1)) { touch(); rerender(); } } }, icon('down')),
      el('button', { type: 'button', class: 'ib dng', title: 'מחיקה', 'aria-label': 'מחיקת ה' + what, onclick: function (e) { e.preventDefault(); if (confirm('למחוק את ה' + what + '?')) { arr.splice(i, 1); touch(); rerender(); } } }, icon('trash')));
  }
  var PARAS = ['paragraphs', 'a', 'q', 'about', 'summary', 'intro', 'text', 'story', 'community', 'city', 'zion', 'tziyun', 'kibbutz', 'passing', 'sofiaStory'];
  function listField(parent, key, label, ctx) {
    var arr = parent[key], rerender = ctx.rerender;
    var box = el('div', { class: 'lst' }, label ? el('h4', {}, label, el('span', { class: 'cnt', text: String(arr.length) })) : null);
    var tpl = arr.length ? arr[0] : ctx.top && TEMPLATES[ctx.file] ? TEMPLATES[ctx.file] : TEMPLATES[key];
    if (!arr.length && tpl === undefined) {
      box.append(el('p', { class: 'help', text: 'הרשימה ריקה. כדי להוסיף לה פריטים, פנו למי שמתחזק את האתר.' }));
      return box;
    }
    if (typeof tpl !== 'object') {
      // A list of paragraphs or short lines.
      var para = PARAS.indexOf(key) > -1;
      arr.forEach(function (_, i) { box.append(el('div', { class: 'prow' }, textInput(arr, i, '', { long: para || String(arr[i]).length > 60, k: key }), tools(arr, i, rerender, para ? 'פסקה' : 'שורה'))); });
      box.append(el('button', { type: 'button', class: 'add', onclick: function () { arr.push(''); touch(); rerender(); } }, icon('plus'), para ? 'הוספת פסקה' : 'הוספת שורה'));
      return box;
    }
    var names = TUPLES[key];
    arr.forEach(function (item, i) {
      var d = el('details', { class: 'item' });
      d.append(el('summary', {}, el('span', { class: 'n', text: String(i + 1) }), el('span', { class: 't', text: summary(item).slice(0, 90) || '(ריק)' }), tools(arr, i, rerender, 'פריט')));
      var bd = el('div', { class: 'bd' });
      if (Array.isArray(item)) item.forEach(function (_, j) { bd.append(field(item, j, names && names[j] || 'שדה ' + (j + 1), { rerender: rerender, long: j > 0 && String(item[j]).length > 40 })); });
      else Object.keys(item).forEach(function (k) { bd.append(field(item, k, LABELS[k] || k, { rerender: rerender })); });
      d.append(bd);
      if (arr.length <= 3 || (ctx.openLast && i === arr.length - 1)) d.open = true;
      box.append(d);
    });
    box.append(el('button', { type: 'button', class: 'add', onclick: function () { var x = blank(tpl); if (ctx.file === 'halacha.json' && ctx.top) x.id = 'h' + Date.now().toString(36); arr.push(x); ctx.openLast = true; touch(); rerender(); } }, icon('plus'), 'הוספת פריט'));
    return box;
  }

  // ---- layout ----
  function shell() {
    var nav = $('#nav'); nav.textContent = '';
    var link = function (hash, ic, text) { return el('a', { href: hash, 'data-h': hash }, icon(ic), el('span', { text: text })); };
    nav.append(link('#/', 'home', 'לוח בקרה'), link('#/pages', 'page', 'דפים ונושאים'), link('#/shut', 'chat', 'שו״ת ברסלב'));
    GROUPS.forEach(function (g) { nav.append(el('h3', { text: g[0] })); g[1].forEach(function (f) { nav.append(link('#/file/' + f[0], f[2], f[1])); }); });
    nav.append(el('h3', { text: 'ניהול' }), link('#/file/site.json', 'gear', 'הגדרות האתר'));
    if (owner) nav.append(link('#/editors', 'users', 'עורכים'));
  }
  function mark(hash) {
    document.querySelectorAll('#nav a').forEach(function (a) { var h = a.getAttribute('data-h'); a.classList.toggle('cur', h === hash || (h !== '#/' && hash.indexOf(h + '/') === 0) || (h === '#/pages' && /^#\/page\//.test(hash))); });
    document.body.classList.remove('navopen');
  }
  function main() { var m = $('#main'); m.textContent = ''; window.scrollTo(0, 0); return m; }
  function head(title, sub, actions) { return el('header', { class: 'phd' }, el('div', {}, el('h1', { text: title }), sub ? el('p', { class: 'sub', text: sub }) : null), actions ? el('div', { class: 'acts' }, actions) : null); }
  function viewLink(p, text, cls) { return el('a', { class: 'btn ghost' + (cls ? ' ' + cls : ''), href: '..' + p, target: '_blank', rel: 'noopener' }, icon('eye'), text || 'צפייה באתר'); }
  function loading(m) { m.append(el('p', { class: 'loading', text: 'טוען…' })); }

  // Publish box, shared by every editing screen: state, save, undo.
  function saveBox(onSave) {
    return el('div', { class: 'card pub' },
      el('h3', { text: 'פרסום' }),
      el('p', { id: 'savestate', class: 'state', text: 'כל השינויים שמורים' }),
      el('button', { type: 'button', class: 'btn pri wide', id: 'savebtn', onclick: onSave }, 'שמירה ופרסום'),
      el('button', { type: 'button', class: 'btn ghost wide', id: 'undo', hidden: true, onclick: function () { if (confirm('לבטל את כל השינויים שלא נשמרו?')) { cur.data = JSON.parse(cur.orig); route(true); } } }, 'ביטול השינויים'),
      el('p', { class: 'help', text: 'אחרי השמירה האתר מתעדכן תוך דקה או שתיים. קיצור מקלדת: Ctrl+S' }));
  }
  var saving = false;
  function commit(path, data, indent, sha, msg) {
    if (saving) return Promise.reject(new Error('השמירה הקודמת עוד לא הסתיימה'));
    saving = true; var b = $('#savebtn'); if (b) { b.disabled = true; b.textContent = 'שומר…'; }
    return putFile(path, data, indent, sha, msg).then(function (r) { published(r.commit.sha); return r; }).finally(function () { saving = false; if (b) { b.disabled = false; b.textContent = 'שמירה ופרסום'; } });
  }
  // After a save: follow the publishing run, so the editor hears whether the site was actually updated.
  function published(sha) {
    say('נשמר. האתר מתעדכן, זה לוקח דקה או שתיים…', 'ok');
    var tries = 0;
    (function poll() {
      if (++tries > 40) return;
      setTimeout(function () {
        api('actions/runs?head_sha=' + sha).then(function (r) {
          var runs = r.workflow_runs || [];
          var run = runs.filter(function (x) { return /Pages/.test(x.name); })[0] || runs[0];
          if (!run || run.status !== 'completed') return poll();
          if (run.conclusion === 'success') say('האתר עודכן ✓', 'ok');
          else say('הפרסום נכשל, והאתר נשאר כמו שהיה. כנראה יש בעיה בתוכן ששמרתם. פנו למי שמתחזק את האתר.', 'bad');
        }, function () { /* no permission to read runs: nothing more to report */ });
      }, 10000);
    })();
  }
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ד')) { var b = $('#savebtn'); if (b) { e.preventDefault(); b.click(); } } });

  // ---- data shared by several screens ----
  function topics(force) { if (cache.topics && !force) return Promise.resolve(cache.topics); return getFile('data/topics.json').then(function (f) { cache.topics = f; return f; }); }
  function pages(force) {
    if (cache.pages && !force) return Promise.resolve(cache.pages);
    return api('contents/data/pages' + ref()).catch(function () { return []; }).then(function (fs) {
      return Promise.all(fs.filter(function (x) { return /\.json$/.test(x.name); }).map(function (x) { var slug = x.name.replace(/\.json$/, ''); return getFile('data/pages/' + x.name).then(function (p) { return { slug: slug, title: p.data.title, topic: p.data.topic }; }); }));
    }).then(function (ps) { cache.pages = ps; return ps; });
  }

  // ---- screens ----
  function home() {
    var m = main();
    m.append(head('שלום' + (me ? ', ' + me.split('@')[0] : ''), 'מה תרצו לעשות היום?'));
    var tile = function (hash, ic, t, d, fn) { return el('a', { class: 'tile', href: hash || '#/', onclick: fn ? function (e) { e.preventDefault(); fn(); } : null }, el('span', { class: 'tic' }, icon(ic)), el('b', { text: t }), el('span', { text: d })); };
    m.append(el('div', { class: 'tiles' },
      tile(null, 'plus', 'דף חדש', 'יצירת דף חדש באתר, בתוך נושא', newPage),
      tile('#/pages', 'page', 'הדפים שלי', 'כל הדפים והנושאים שיצרתם'),
      tile('#/shut', 'chat', 'שו״ת ברסלב', 'חיפוש, עריכה והוספה של שאלות ותשובות'),
      tile('#/file/yavniel.json', 'mountain', 'זמני תפילות ושיעורים', 'עדכון המידע על יבנאל'),
      owner ? tile('#/editors', 'users', 'עורכים', 'הוספה והסרה של מי שיכול לערוך') : null,
      el('a', { class: 'tile', href: '../', target: '_blank', rel: 'noopener' }, el('span', { class: 'tic' }, icon('eye')), el('b', { text: 'צפייה באתר' }), el('span', { text: 'נפתח בלשונית חדשה' }))));
    m.append(el('section', { class: 'card how' }, el('h2', { text: 'איך זה עובד' }), el('ol', {},
      el('li', {}, el('b', { text: 'בוחרים' }), ' מהתפריט מה לערוך: דף שיצרתם, חלק קיים באתר, או שאלה מהשו״ת.'),
      el('li', {}, el('b', { text: 'משנים' }), ' את הטקסט בטופס. אפשר להוסיף, למחוק ולהזיז פריטים בחצים.'),
      el('li', {}, el('b', { text: 'לוחצים ״שמירה ופרסום״' }), '. תוך דקה או שתיים השינוי מופיע באתר, ותופיע כאן הודעה שהאתר עודכן.'))));
    var recent = el('section', { class: 'card' }, el('h2', { text: 'הדפים שלכם' }));
    m.append(recent); loading(recent);
    pages().then(function (ps) {
      recent.querySelector('.loading').remove();
      if (!ps.length) recent.append(el('p', { class: 'help', text: 'עדיין לא יצרתם דפים. לחצו על ״דף חדש״ כדי להתחיל.' }));
      ps.slice(0, 8).forEach(function (p) { recent.append(el('a', { class: 'row', href: '#/page/' + p.slug }, icon('page'), el('span', { text: p.title }))); });
    }, function (e) { say(e.message, 'bad'); });
  }

  function pagesScreen() {
    var m = main();
    m.append(head('דפים ונושאים', 'כל דף שייך לנושא. נושא מופיע בתפריט של האתר כשיש בו לפחות דף אחד.', [
      el('button', { type: 'button', class: 'btn ghost', onclick: function () { topicDialog(); } }, icon('plus'), 'נושא חדש'),
      el('button', { type: 'button', class: 'btn pri', onclick: function () { newPage(); } }, icon('plus'), 'דף חדש')]));
    var box = el('div'); m.append(box); loading(box);
    Promise.all([topics(true), pages(true)]).then(function (r) {
      box.textContent = '';
      var ts = r[0].data, ps = r[1];
      if (!ts.length) box.append(el('div', { class: 'empty card' }, el('p', { text: 'עדיין אין נושאים. נושא הוא קבוצה של דפים, למשל ״פרשת השבוע״ או ״חגים״.' }), el('button', { type: 'button', class: 'btn pri', onclick: function () { topicDialog(); } }, icon('plus'), 'יצירת נושא ראשון')));
      ts.forEach(function (t) {
        var mine = ps.filter(function (p) { return p.topic === t.slug; });
        var card = el('section', { class: 'card topic' },
          el('header', {}, el('span', { class: 'tic' }, icon(t.icon || 'book')), el('div', { class: 'grow' }, el('h2', { text: t.title }), el('p', { class: 'help', text: (t.desc ? t.desc + ' · ' : '') + (mine.length ? mine.length + ' דפים' : 'אין עדיין דפים, ולכן הנושא לא מופיע באתר') })),
            el('span', { class: 'acts' },
              mine.length ? viewLink('/' + t.slug + '/', 'באתר', 'sm') : null,
              el('button', { type: 'button', class: 'btn ghost sm', onclick: function () { topicDialog(t); } }, 'עריכה'),
              mine.length ? null : el('button', { type: 'button', class: 'btn ghost sm dng', onclick: function () { delTopic(t); } }, 'מחיקה'))));
        mine.forEach(function (p) { card.append(el('a', { class: 'row', href: '#/page/' + p.slug }, icon('page'), el('span', { text: p.title }), el('small', { class: 'ltr', text: '/' + t.slug + '/' + p.slug + '/' }))); });
        card.append(el('button', { type: 'button', class: 'add', onclick: function () { newPage(t.slug); } }, icon('plus'), 'דף חדש בנושא הזה'));
        box.append(card);
      });
    }, function (e) { box.textContent = ''; say(e.message, 'bad'); });
  }

  function topicDialog(t) {
    var edit = !!t;
    var title = el('input', { type: 'text', required: true }); title.value = edit ? t.title : '';
    var desc = el('textarea', { rows: 2 }); desc.value = edit ? t.desc || '' : '';
    var slug = el('input', { type: 'text', class: 'ltr', dir: 'ltr', disabled: edit }); slug.value = edit ? t.slug : '';
    var picked = edit ? t.icon || 'book' : 'book';
    var grid = el('div', { class: 'igrid', role: 'radiogroup', 'aria-label': 'סמל' });
    Object.keys(ICON_NAMES).forEach(function (n) { var b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(n === picked), title: ICON_NAMES[n], 'aria-label': ICON_NAMES[n], onclick: function () { picked = n; grid.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); } }, icon(n)); grid.append(b); });
    if (!edit) title.addEventListener('input', function () { if (!slug.dataset.touched) slug.value = slugify(title.value); });
    slug.addEventListener('input', function () { slug.dataset.touched = 1; });
    dialog(edit ? 'עריכת נושא' : 'נושא חדש', [
      ['שם הנושא', title, 'כך הוא יופיע בתפריט של האתר'], ['תיאור קצר', desc], ['סמל', grid],
      ['כתובת באתר', slug, edit ? 'אי אפשר לשנות כתובת של נושא קיים' : 'באותיות לועזיות. נוצרת לבד מהשם, ואפשר לשנות.'],
    ], edit ? 'שמירה' : 'יצירה', function () {
      var s = slug.value.trim();
      if (!title.value.trim()) return 'חסר שם לנושא';
      if (!SLUG.test(s)) return 'הכתובת יכולה להכיל רק אותיות לועזיות קטנות, ספרות ומקף';
      if (!edit && RESERVED.indexOf(s) > -1) return 'הכתובת הזאת תפוסה על ידי חלק קיים באתר. בחרו אחרת.';
      return topics(true).then(function (f) {
        if (!edit && f.data.some(function (x) { return x.slug === s; })) throw new Error('כבר יש נושא עם הכתובת הזאת');
        var row = { slug: s, title: title.value.trim(), desc: desc.value.trim(), icon: picked };
        if (edit) f.data = f.data.map(function (x) { return x.slug === s ? row : x; }); else f.data.push(row);
        return commit('data/topics.json', f.data, 2, f.sha, (edit ? 'עריכת נושא: ' : 'נושא חדש: ') + row.title);
      }).then(function () { cache.topics = null; say(edit ? 'הנושא עודכן.' : 'הנושא נוצר. עכשיו הוסיפו לו דף.', 'ok'); if (location.hash === '#/pages') pagesScreen(); else location.hash = '#/pages'; });
    });
  }
  function delTopic(t) {
    if (!confirm('למחוק את הנושא ״' + t.title + '״?')) return;
    Promise.all([topics(true), pages(true)]).then(function (r) {
      if (r[1].some(function (p) { return p.topic === t.slug; })) throw new Error('יש דפים בנושא הזה. מחקו או העבירו אותם קודם.');
      var f = r[0]; f.data = f.data.filter(function (x) { return x.slug !== t.slug; });
      return commit('data/topics.json', f.data, 2, f.sha, 'מחיקת נושא: ' + t.title);
    }).then(function () { cache.topics = null; say('הנושא נמחק.', 'ok'); pagesScreen(); }, function (e) { say(e.message, 'bad'); });
  }
  function newPage(topicSlug) {
    if (!leave()) return;
    topics().then(function (tf) {
      if (!tf.data.length) { say('קודם צרו נושא, ואז אפשר להוסיף לו דפים.', 'bad'); topicDialog(); return; }
      var topic = el('select'); tf.data.forEach(function (t) { topic.append(el('option', { value: t.slug, text: t.title })); });
      if (typeof topicSlug === 'string') topic.value = topicSlug;
      var title = el('input', { type: 'text', required: true }), slug = el('input', { type: 'text', class: 'ltr', dir: 'ltr' });
      title.addEventListener('input', function () { if (!slug.dataset.touched) slug.value = slugify(title.value); });
      slug.addEventListener('input', function () { slug.dataset.touched = 1; });
      dialog('דף חדש', [['כותרת הדף', title], ['נושא', topic], ['כתובת באתר', slug, 'באותיות לועזיות. נוצרת לבד מהכותרת, ואפשר לשנות.']], 'יצירת הדף', function () {
        var s = slug.value.trim();
        if (!title.value.trim()) return 'חסרה כותרת';
        if (!SLUG.test(s)) return 'הכתובת יכולה להכיל רק אותיות לועזיות קטנות, ספרות ומקף';
        var path = 'data/pages/' + s + '.json';
        return exists(path).then(function (yes) {
          if (yes) throw new Error('כבר יש דף עם הכתובת הזאת. שנו אותה מעט.');
          var data = { topic: topic.value, title: title.value.trim(), lead: '', desc: '', blocks: [BLOCKS.text.make()] };
          return commit(path, data, 2, null, 'דף חדש: ' + data.title);
        }).then(function () { cache.pages = null; cur = null; say('הדף נוצר. עכשיו כתבו את התוכן.', 'ok'); location.hash = '#/page/' + s; });
      });
    }, function (e) { say(e.message, 'bad'); });
  }

  // Page editor, in the spirit of WordPress: title and lead on top, content blocks below, publishing and settings on the side.
  function pageScreen(slug) {
    var m = main(); loading(m);
    Promise.all([getFile('data/pages/' + slug + '.json'), topics()]).then(function (r) {
      cur = r[0]; var p = cur.data, ts = r[1].data;
      if (!Array.isArray(p.blocks)) p.blocks = [];
      if (p.desc == null) p.desc = '';
      cur.orig = JSON.stringify(p);
      m.textContent = '';
      var t = ts.filter(function (x) { return x.slug === p.topic; })[0];
      m.append(el('p', { class: 'crumbs' }, el('a', { href: '#/pages', text: 'דפים ונושאים' }), ' › ', t ? t.title : p.topic));
      var col = el('div', { class: 'col' }), side = el('aside', { class: 'side' });
      m.append(el('div', { class: 'split' }, col, side));
      col.append(textInput(p, 'title', '', { cls: 'bigtitle', placeholder: 'כותרת הדף' }), textInput(p, 'lead', 'פתיח', { long: true, placeholder: 'משפט או שניים שמופיעים מתחת לכותרת' }));
      var blocks = el('div', { class: 'blocks' }); col.append(blocks);
      var draw = function () {
        blocks.textContent = '';
        var ins = function (at) { return inserter(function (type) { p.blocks.splice(at, 0, BLOCKS[type].make()); touch(); draw(); }); };
        p.blocks.forEach(function (b, i) {
          blocks.append(ins(i));
          var def = BLOCKS[b.type] || { name: b.type, icon: 'text' };
          var body = el('div', { class: 'bbody' });
          if (b.type === 'text') body.append(textInput(b, 'title', 'כותרת המקטע (לא חובה)'), listField(b, 'paragraphs', '', { rerender: draw }));
          else if (b.type === 'quote') body.append(textInput(b, 'text', 'הציטוט', { long: true }), textInput(b, 'by', 'מקור (לא חובה)'));
          else {
            body.append(textInput(b, 'title', 'כותרת המקטע (לא חובה)'));
            var keys = b.type === 'faq' ? [['q', 'שאלה'], ['a', 'תשובה']] : b.type === 'links' ? [['title', 'שם הקישור'], ['url', 'כתובת']] : [['title', 'כותרת הכרטיס'], ['text', 'טקסט']];
            var list = el('div', { class: 'lst' });
            (b.items || (b.items = [])).forEach(function (it, j) {
              list.append(el('div', { class: 'subitem' }, el('div', { class: 'subh' }, el('span', { class: 'n', text: String(j + 1) }), tools(b.items, j, draw, 'פריט')), keys.map(function (k) { return textInput(it, k[0], k[1], { long: k[0] === 'a' || k[0] === 'text', k: k[0] }); })));
            });
            list.append(el('button', { type: 'button', class: 'add', onclick: function () { var x = {}; keys.forEach(function (k) { x[k[0]] = k[0] === 'url' ? 'https://' : ''; }); b.items.push(x); touch(); draw(); } }, icon('plus'), b.type === 'faq' ? 'הוספת שאלה' : b.type === 'links' ? 'הוספת קישור' : 'הוספת כרטיס'));
            body.append(list);
          }
          blocks.append(el('section', { class: 'block' }, el('header', {}, el('span', { class: 'bname' }, icon(def.icon), def.name), tools(p.blocks, i, draw, 'מקטע')), body));
        });
        blocks.append(ins(p.blocks.length));
        if (!p.blocks.length) blocks.append(el('p', { class: 'help center', text: 'הדף ריק. לחצו על ״הוספת מקטע״ כדי להתחיל.' }));
      };
      draw();
      var topicSel = el('select', { id: 'ptopic' }); ts.forEach(function (x) { topicSel.append(el('option', { value: x.slug, text: x.title })); }); topicSel.value = p.topic;
      topicSel.addEventListener('change', function () { p.topic = topicSel.value; touch(); });
      var url = '/' + p.topic + '/' + slug + '/';
      side.append(saveBox(function () { savePage(slug); }),
        el('div', { class: 'card' }, el('h3', { text: 'הגדרות הדף' }),
          el('div', { class: 'fld' }, el('label', { for: 'ptopic', text: 'נושא' }), topicSel),
          textInput(p, 'desc', 'תיאור לחיפוש ולשיתוף', { long: true, help: 'מה יופיע בגוגל ובוואטסאפ. אם ריק, משתמשים בפתיח.' }),
          el('p', { class: 'help' }, 'כתובת: ', el('span', { class: 'ltr', text: url }))),
        el('div', { class: 'card stack' },
          el('button', { type: 'button', class: 'btn ghost wide', onclick: function () { preview(p); } }, icon('eye'), 'תצוגה מקדימה'),
          viewLink(url, 'צפייה בדף באתר', 'wide'),
          el('button', { type: 'button', class: 'btn ghost wide dng', onclick: delPage }, icon('trash'), 'מחיקת הדף')));
      status();
    }, function (e) { m.textContent = ''; say(e.message === 'לא נמצא' ? 'הדף לא נמצא. אולי הוא נמחק.' : e.message, 'bad'); });
  }
  function closeMenus() { document.querySelectorAll('.insmenu').forEach(function (x) { x.hidden = true; }); document.querySelectorAll('.insbtn').forEach(function (x) { x.setAttribute('aria-expanded', 'false'); }); }
  document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.insmenu')) closeMenus(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });
  function inserter(onPick) {
    var menu = el('div', { class: 'insmenu', hidden: true });
    var btn = el('button', { type: 'button', class: 'insbtn', 'aria-expanded': 'false', onclick: function (e) { e.stopPropagation(); var open = menu.hidden; closeMenus(); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); } }, icon('plus'), 'הוספת מקטע');
    Object.keys(BLOCKS).forEach(function (k) { menu.append(el('button', { type: 'button', onclick: function () { menu.hidden = true; onPick(k); } }, icon(BLOCKS[k].icon), el('b', { text: BLOCKS[k].name }), el('small', { text: BLOCKS[k].hint }))); });
    return el('div', { class: 'ins' }, btn, menu);
  }
  function savePage(slug) {
    var p = cur.data;
    if (!p.title || !p.title.trim()) return say('חסרה כותרת לדף', 'bad');
    if (p.blocks.some(function (b) { return b.type === 'links' && (b.items || []).some(function (l) { return !/^https:\/\/\S+$/.test(l.url || ''); }); })) return say('כל קישור צריך להתחיל ב־https://', 'bad');
    var f = cur, oldTopic = JSON.parse(f.orig).topic;
    commit(f.path, p, f.indent, f.sha, 'עריכת דף: ' + p.title).then(function (r) {
      f.sha = r.content.sha; f.orig = JSON.stringify(p); cache.pages = null; status();
      if (oldTopic !== p.topic) say('נשמר. שימו לב: הכתובת של הדף השתנתה ל־/' + p.topic + '/' + slug + '/', 'ok');
    }, function (e) { say(e.message, 'bad'); });
  }
  function delPage() {
    if (!confirm('למחוק את הדף ״' + cur.data.title + '״ מהאתר? אי אפשר לבטל את זה מכאן.')) return;
    delFile(cur.path, cur.sha, 'מחיקת דף: ' + cur.data.title).then(function () { cur = null; cache.pages = null; say('הדף נמחק. האתר יתעדכן תוך דקה או שתיים.', 'ok'); location.hash = '#/pages'; }, function (e) { say(e.message, 'bad'); });
  }
  // Preview with the site's own stylesheet, in the markup the build uses (scripts/lib/sections/pages.mjs).
  function preview(p) {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var ps = function (xs) { return (xs || []).map(function (x) { return '<p>' + esc(x) + '</p>'; }).join(''); };
    var sect = function (i, inner, b, wide) { return '<section class="band' + (i % 2 ? ' soft' : '') + '"><div class="wrap' + (wide ? '' : ' narrow') + '">' + (b.title ? '<h2 class="sh">' + esc(b.title) + '</h2>' : '') + inner + '</div></section>'; };
    var html = p.blocks.map(function (b, i) {
      if (b.type === 'text') return sect(i, '<div class="about">' + ps(b.paragraphs) + '</div>', b);
      if (b.type === 'cards') return sect(i, '<div class="grid notes">' + (b.items || []).map(function (c) { return '<div class="card"><h3>' + esc(c.title) + '</h3><p>' + esc(c.text) + '</p></div>'; }).join('') + '</div>', b, true);
      if (b.type === 'faq') return sect(i, '<div class="faqs">' + (b.items || []).map(function (x, n) { return '<details class="faq"' + (n ? '' : ' open') + '><summary>' + esc(x.q) + '</summary><p>' + esc(x.a) + '</p></details>'; }).join('') + '</div>', b);
      if (b.type === 'quote') return '<section class="band quoteband"><div class="wrap"><blockquote class="pq small"><p>' + esc(b.text) + '</p>' + (b.by ? '<cite>' + esc(b.by) + '</cite>' : '') + '</blockquote></div></section>';
      if (b.type === 'links') return sect(i, '<ul>' + (b.items || []).map(function (l) { return '<li><a>' + esc(l.title) + '</a></li>'; }).join('') + '</ul>', b);
      return '';
    }).join('');
    var doc = '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><link rel="stylesheet" href="' + esc(new URL('../style.css', location.href).href) + '"></head><body><main><section class="phead"><div class="wrap"><h1>' + esc(p.title) + '</h1>' + (p.lead ? '<p class="sub">' + esc(p.lead) + '</p>' : '') + '</div></section>' + html + '</main></body></html>';
    var frame = el('iframe', { title: 'תצוגה מקדימה', sandbox: 'allow-same-origin' }); frame.srcdoc = doc;
    var dlg = el('dialog', { class: 'pv' }, el('header', {}, el('b', { text: 'תצוגה מקדימה' }), el('span', { class: 'help grow', text: 'כך הדף ייראה באתר (בלי התפריט). השינויים עוד לא שמורים.' }), el('button', { type: 'button', class: 'btn ghost sm', onclick: function () { dlg.close(); } }, 'סגירה')), frame);
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  }

  // A content file of the site (uman.json …): its simple fields first, then each list or section in a card that opens.
  function fileScreen(name) {
    var meta = FILE[name] || { name: name, url: '' };
    var m = main(); loading(m);
    getFile('data/' + name).then(function (f) {
      cur = f;
      m.textContent = '';
      var find = el('input', { type: 'search', placeholder: 'חיפוש בטקסט של העמוד…', 'aria-label': 'חיפוש בטקסט של העמוד' });
      m.append(head(meta.name, name === 'site.json' ? 'פרטי קשר, פרטי העמותה, נגישות, וחלקים שמוסתרים מהגולשים' : 'עריכת התוכן של העמוד הזה באתר', meta.url ? [viewLink(meta.url)] : null));
      var col = el('div', { class: 'col' }), side = el('aside', { class: 'side' });
      m.append(el('div', { class: 'split' }, col, side));
      col.append(el('div', { class: 'findbar' }, icon('search'), find));
      var body = el('div'); col.append(body);
      var draw = function () {
        var y = window.scrollY, open = {}; body.querySelectorAll('details.sec').forEach(function (s) { open[s.getAttribute('data-k')] = s.open; });
        body.textContent = '';
        var d = cur.data;
        if (Array.isArray(d)) { body.append(el('section', { class: 'card' }, listField({ d: d }, 'd', '', { rerender: draw, file: name, top: true }))); window.scrollTo(0, y); return; }
        var simple = el('section', { class: 'card sec' }, el('h2', { text: 'פרטים כלליים' }));
        var any = false;
        Object.keys(d).forEach(function (k) {
          var v = d[k];
          if (v === null || typeof v !== 'object') { simple.append(field(d, k, LABELS[k] || k, { rerender: draw })); any = true; return; }
          var cnt = Array.isArray(v) ? v.length : Object.keys(v).length;
          var sec = el('details', { class: 'card sec', 'data-k': k }, el('summary', {}, el('h2', { text: LABELS[k] || k }), el('span', { class: 'cnt', text: String(cnt) })));
          sec.append(Array.isArray(v) ? listField(d, k, '', { rerender: draw, file: name }) : group(v, '', { rerender: draw }));
          if (open[k]) sec.open = true;
          body.append(sec);
        });
        if (any) body.prepend(simple);
        applyFind();
        window.scrollTo(0, y);
      };
      var has = function (s, q) { return Array.prototype.some.call(s.querySelectorAll('input,textarea'), function (i) { return i.value.indexOf(q) > -1; }); };
      var applyFind = function () {
        var q = find.value.trim();
        body.querySelectorAll('.sec').forEach(function (s) {
          if (!q) { s.hidden = false; return; }
          var hit = has(s, q); s.hidden = !hit;
          if (hit && s.tagName === 'DETAILS') { s.open = true; s.querySelectorAll('details').forEach(function (x) { if (has(x, q)) x.open = true; }); }
        });
      };
      find.addEventListener('input', applyFind);
      draw();
      side.append(saveBox(function () { saveFile(name); }), el('div', { class: 'card' }, el('h3', { text: 'מתקדם' }), el('button', { type: 'button', class: 'btn ghost wide', onclick: function () { rawEditor(draw); } }, 'עריכת הקובץ כ־JSON'), el('p', { class: 'help', text: 'רק למי שמכיר את מבנה הקבצים.' })));
      status();
    }, function (e) { m.textContent = ''; say(e.message, 'bad'); });
  }
  function rawEditor(after) {
    var ta = el('textarea', { class: 'raw', dir: 'ltr', spellcheck: 'false' }); ta.value = JSON.stringify(cur.data, null, 2);
    var err = el('p', { class: 'err', role: 'alert' });
    var dlg = el('dialog', { class: 'dlg wide' }, el('h2', { text: 'עריכה כ־JSON' }), ta, err, el('p', { class: 'acts' },
      el('button', { type: 'button', class: 'btn pri', onclick: function () { try { cur.data = JSON.parse(ta.value); dlg.close(); after(); touch(); } catch (x) { err.textContent = 'ה־JSON לא תקין: ' + x.message; } } }, 'החלה'),
      el('button', { type: 'button', class: 'btn ghost', onclick: function () { dlg.close(); } }, 'ביטול')));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  }
  function saveFile(name) {
    var f = cur;
    if (name === 'halacha.json' && f.data.some(function (x) { return !/^[\w-]+$/.test(String(x.id)) || !x.title; })) return say('לכל שאלה צריכה להיות כותרת', 'bad');
    if (name === 'site.json' && (f.data.hidden || []).some(function (h) { return !/^\/[\w/-]*$/.test(h.path || ''); })) return say('כל נתיב מוסתר צריך להתחיל ב־/', 'bad');
    commit(f.path, f.data, f.indent, f.sha, 'עריכת תוכן: ' + (FILE[name] ? FILE[name].name : name)).then(function (r) { f.sha = r.content.sha; f.orig = JSON.stringify(f.data); status(); }, function (e) { say(e.message, 'bad'); });
  }

  // ---- the Q&A archive: search in a light list, edit one entry at a time (data/shut-edits/<id>.json) ----
  function shutIndex() {
    if (cache.shutIndex) return Promise.resolve(cache.shutIndex);
    return fetch('shut/index.json').then(function (r) { if (!r.ok) throw new Error('רשימת השאלות עוד לא זמינה. נסו שוב בעוד כמה דקות.'); return r.json(); }).then(function (x) { cache.shutIndex = x; return x; });
  }
  function shutScreen() {
    var m = main();
    var q = el('input', { type: 'search', placeholder: 'חיפוש לפי מילים מהכותרת, או מספר שאלה…', 'aria-label': 'חיפוש שאלה' });
    var kind = el('select', { 'aria-label': 'סוג' }, el('option', { value: 'shut', text: 'שו״ת' }), el('option', { value: 'letters', text: 'מכתבים' }));
    m.append(head('שו״ת ברסלב', 'חפשו שאלה כדי לערוך אותה, או הוסיפו שאלה חדשה.', [el('a', { class: 'btn pri', href: '#/shut/new' }, icon('plus'), 'שאלה חדשה')]));
    m.append(el('div', { class: 'findbar big' }, icon('search'), q, kind));
    var res = el('div', { class: 'card results' }); m.append(res); loading(res);
    shutIndex().then(function (idx) {
      var draw = function () {
        res.textContent = '';
        var words = q.value.trim().split(/\s+/).filter(Boolean);
        var hits = idx.filter(function (x) { return x[1] === kind.value && (!words.length || words.every(function (w) { return String(x[0]) === w || x[2].indexOf(w) > -1; })); });
        res.append(el('p', { class: 'help', text: words.length ? (hits.length ? hits.length + ' תוצאות' + (hits.length > 60 ? ' (מוצגות 60 הראשונות)' : '') : 'לא נמצאו תוצאות') : 'השאלות האחרונות שנוספו. ' + hits.length.toLocaleString('he-IL') + ' בסך הכול.' }));
        (words.length ? hits : hits.slice().reverse()).slice(0, 60).forEach(function (x) { res.append(el('a', { class: 'row', href: '#/shut/' + x[0] }, el('span', { class: 'num', text: '#' + x[0] }), el('span', { class: 'grow', text: x[2] }), el('small', { text: x[3] }))); });
      };
      var t; q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(draw, 150); }); kind.addEventListener('change', draw);
      draw(); q.focus();
    }, function (e) { res.textContent = ''; res.append(el('p', { class: 'help', text: e.message })); });
  }
  function shutItem(id) {
    var m = main(); loading(m);
    var isNew = id === 'new';
    var path = function (x) { return 'data/shut-edits/' + x + '.json'; };
    shutIndex().then(function (idx) {
      if (isNew) {
        // Another new entry may have been saved since the list was built: take the first free number.
        var next = idx.reduce(function (a, x) { return Math.max(a, +x[0] || 0); }, 0) + 1;
        var free = function (n) { return exists(path(n)).then(function (yes) { return yes ? free(n + 1) : n; }); };
        return free(next).then(function (n) { var x = { id: n, kind: 'shut', title: '', q: [''], a: [''], date: '' }; return { path: path(n), sha: null, indent: 2, data: x, orig: JSON.stringify(x) }; });
      }
      var row = idx.filter(function (x) { return String(x[0]) === id; })[0];
      // An entry edited before (data/shut-edits) is newer than the published list; otherwise take it from the published chunk.
      return getFile(path(id)).catch(function (e) {
        if (e.status !== 404) throw e;
        if (!row) throw new Error('השאלה לא נמצאה');
        return fetch('shut/' + row[4] + '.json').then(function (r) { return r.json(); }).then(function (chunk) {
          var x = chunk.filter(function (y) { return String(y.id) === id; })[0];
          if (!x) throw new Error('השאלה לא נמצאה');
          return { path: path(id), sha: null, indent: 2, data: x, orig: JSON.stringify(x) };
        });
      });
    }).then(function (f) {
      cur = f; var x = f.data;
      m.textContent = '';
      m.append(el('p', { class: 'crumbs' }, el('a', { href: '#/shut', text: 'שו״ת ברסלב' }), ' › ', isNew ? 'שאלה חדשה' : '#' + x.id));
      if (x.deleted) {
        cur = null;
        m.append(el('section', { class: 'card' }, el('h2', { text: 'השאלה הזאת מוסתרת מהאתר' }), el('button', { type: 'button', class: 'btn pri', onclick: function () { delFile(f.path, f.sha, 'החזרת שאלה ' + x.id).then(function () { cache.shutIndex = null; say('השאלה תחזור לאתר תוך דקה או שתיים.', 'ok'); location.hash = '#/shut'; }, function (e) { say(e.message, 'bad'); }); } }, 'החזרה לאתר')));
        return;
      }
      var base = x.kind === 'letters' ? '/letters/' : '/shut/';
      var col = el('div', { class: 'col' }), side = el('aside', { class: 'side' });
      m.append(el('div', { class: 'split' }, col, side));
      var body = el('div'); col.append(body);
      var draw = function () {
        body.textContent = '';
        body.append(textInput(x, 'title', '', { cls: 'bigtitle', placeholder: 'כותרת השאלה' }),
          el('section', { class: 'card' }, el('h2', { text: 'השאלה' }), listField(x, 'q', '', { rerender: draw })),
          el('section', { class: 'card' }, el('h2', { text: 'התשובה' }), listField(x, 'a', '', { rerender: draw })));
      };
      draw();
      var kindSel = el('select', { id: 'skind' }, el('option', { value: 'shut', text: 'שו״ת' }), el('option', { value: 'letters', text: 'מכתב' })); kindSel.value = x.kind;
      kindSel.addEventListener('change', function () { x.kind = kindSel.value; touch(); });
      side.append(saveBox(function () { saveShut(isNew); }),
        el('div', { class: 'card' }, el('h3', { text: 'פרטים' }), textInput(x, 'date', 'תאריך', { placeholder: 'למשל: ה׳ שבט תשע״ה' }), el('div', { class: 'fld' }, el('label', { for: 'skind', text: 'סוג' }), kindSel), el('p', { class: 'help', text: 'מספר: ' + x.id })),
        isNew ? null : el('div', { class: 'card stack' }, viewLink(base + x.id + '/', 'צפייה באתר', 'wide'), el('button', { type: 'button', class: 'btn ghost wide dng', onclick: hideShut }, icon('trash'), 'הסתרה מהאתר')));
      status();
    }).catch(function (e) { m.textContent = ''; say(e.message, 'bad'); });
  }
  function saveShut(isNew) {
    var f = cur, x = f.data;
    if (!String(x.title || '').trim()) return say('חסרה כותרת', 'bad');
    var clean = Object.assign({}, x, { q: x.q.filter(function (p) { return p.trim(); }), a: x.a.filter(function (p) { return p.trim(); }) });
    if (!clean.a.length) return say('חסרה תשובה', 'bad');
    commit(f.path, clean, 2, f.sha, (isNew ? 'שאלה חדשה ' : 'עריכת שאלה ') + x.id + ': ' + x.title).then(function (r) {
      f.sha = r.content.sha; f.data = clean; f.orig = JSON.stringify(clean); cache.shutIndex = null; status();
      if (isNew) { cur = null; location.hash = '#/shut/' + x.id; }
    }, function (e) { say(e.message, 'bad'); });
  }
  function hideShut() {
    var f = cur;
    if (!confirm('להסתיר את השאלה ״' + f.data.title + '״ מהאתר? אפשר להחזיר אותה אחר כך.')) return;
    var id = f.data.id;
    commit(f.path, { id: id, deleted: true }, 2, f.sha, 'הסתרת שאלה ' + id).then(function () { cur = null; cache.shutIndex = null; say('השאלה תוסתר מהאתר תוך דקה או שתיים.', 'ok'); location.hash = '#/shut'; }, function (e) { say(e.message, 'bad'); });
  }

  // ---- editors (site owners only; the server checks this too) ----
  function editorsApi(method, email) {
    return fetch(cfg.worker.replace(/\/$/, '') + '/editors', { method: method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: email ? JSON.stringify({ email: email }) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (r.status === 401) signout('פג תוקף ההתחברות. התחברו שוב.'); if (!r.ok) throw new Error(j.message || 'שגיאה ' + r.status); return j.editors; }); });
  }
  function editorsScreen() {
    var m = main();
    m.append(head('עורכים', 'מי שברשימה יכול להתחבר עם חשבון ה־Google שלו ולערוך את האתר. בעלי האתר תמיד יכולים להיכנס, ורק הם רואים את המסך הזה.'));
    var card = el('section', { class: 'card' }); m.append(card); loading(card);
    var drawList = function (list) {
      card.textContent = '';
      var inp = el('input', { id: 'newed', type: 'email', class: 'ltr', dir: 'ltr', autocomplete: 'off', placeholder: 'name@gmail.com', required: true });
      var form = el('form', { class: 'addrow' }, el('div', { class: 'fld grow' }, el('label', { for: 'newed', text: 'הוספת עורך: כתובת Gmail (או חשבון Google אחר)' }), inp), el('button', { type: 'submit', class: 'btn pri' }, icon('plus'), 'הוספה'));
      form.addEventListener('submit', function (e) { e.preventDefault(); var v = inp.value.trim(); if (!v) return; editorsApi('PUT', v).then(function (l) { say('העורך נוסף: ' + v, 'ok'); drawList(l); }, function (x) { say(x.message, 'bad'); }); });
      card.append(form, el('p', { class: 'help', text: 'כל עוד אפליקציית ההתחברות ב־Google במצב בדיקה, צריך להוסיף את העורך גם שם: Google Auth Platform › Audience › Test users.' }));
      if (!list.length) card.append(el('p', { class: 'help', text: 'עדיין אין עורכים נוספים.' }));
      var ul = el('ul', { class: 'eds' });
      list.forEach(function (mail) { ul.append(el('li', {}, el('span', { class: 'ltr', text: mail }), el('button', { type: 'button', class: 'btn ghost sm dng', onclick: function () { if (confirm('להסיר את ' + mail + ' מהעורכים?')) editorsApi('DELETE', mail).then(function (l) { say('העורך הוסר: ' + mail, 'ok'); drawList(l); }, function (x) { say(x.message, 'bad'); }); } }, 'הסרה'))); });
      card.append(ul);
    };
    editorsApi('GET').then(drawList, function (e) { card.textContent = ''; say(e.message, 'bad'); });
  }

  // ---- router ----
  var here = '';
  function route(force) {
    var h = location.hash || '#/';
    if (!force && h === here) return;
    if (!force && here && !leave()) { history.replaceState(null, '', here); return; }
    if (!force) cur = null;
    here = h; mark(h);
    var m;
    if ((m = /^#\/page\/([a-z0-9-]+)$/.exec(h))) pageScreen(m[1]);
    else if ((m = /^#\/file\/([\w.-]+\.json)$/.exec(h))) fileScreen(m[1]);
    else if ((m = /^#\/shut\/(new|[\w-]+)$/.exec(h))) shutItem(m[1]);
    else if (h === '#/shut') shutScreen();
    else if (h === '#/pages') pagesScreen();
    else if (h === '#/editors' && owner) editorsScreen();
    else home();
  }
  window.addEventListener('hashchange', function () { route(); });

  // ---- dialogs ----
  function dialog(title, fields, okText, ok) {
    var dlg = el('dialog', { class: 'dlg' }, el('h2', { text: title }));
    var form = el('form', { method: 'dialog' });
    fields.forEach(function (f) { var id = 'd' + (++uid); f[1].id = id; form.append(el('div', { class: 'fld' }, el('label', { for: id, text: f[0] }), f[1], f[2] ? el('small', { class: 'help', text: f[2] }) : null)); });
    var errp = el('p', { class: 'err', role: 'alert' });
    form.append(errp, el('p', { class: 'acts' }, el('button', { type: 'submit', class: 'btn pri' }, okText), el('button', { type: 'button', class: 'btn ghost', onclick: function () { dlg.close(); } }, 'ביטול')));
    form.addEventListener('submit', function (e) {
      e.preventDefault(); errp.textContent = '';
      var r = ok(); if (typeof r === 'string') { errp.textContent = r; return; }
      if (r) r.then(function () { dlg.close(); }, function (x) { errp.textContent = x.message; });
    });
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.append(form); document.body.append(dlg); dlg.showModal();
    var first = form.querySelector('input,select,textarea'); if (first) first.focus();
  }

  // ---- sign-in ----
  function enter(who) {
    return api('').then(function (r) {
      if (!r.permissions || !r.permissions.push) throw new Error(cfg.worker ? 'לשרת העריכה אין הרשאת כתיבה למאגר' : 'למפתח אין הרשאת כתיבה למאגר');
      me = who || ''; $('#login').hidden = true; $('#app').hidden = false; $('#out').hidden = false; $('#burger').hidden = false; $('#who').textContent = who || cfg.repo;
      shell(); here = ''; route(true);
    }).catch(function (e) { $('#login').hidden = false; $('#app').hidden = true; $('#lerr').textContent = e.message; if (cfg.worker) google(); });
  }
  function remember(v, persist) {
    try { localStorage.removeItem('cms-token'); sessionStorage.removeItem('cms-token'); if (v) (persist ? localStorage : sessionStorage).setItem('cms-token', JSON.stringify(v)); } catch { /* storage blocked: kept for this page only */ }
  }
  function saved() { try { return JSON.parse(localStorage.getItem('cms-token') || sessionStorage.getItem('cms-token') || 'null'); } catch { return null; } }
  function signout(why) {
    cur = null; remember(null); token = '';
    if (!why) return location.reload();
    $('#lerr').textContent = why; $('#login').hidden = false; $('#app').hidden = true; $('#out').hidden = true; $('#burger').hidden = true;
    if (cfg.worker) google();
  }
  // Google sign-in: Google's button gives an ID token; the editor server checks it and the email, and returns a 12-hour session.
  var gStarted = false;
  function google() {
    $('#gbox').hidden = false;
    if (gStarted) return;
    gStarted = true;
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onerror = function () { $('#lerr').textContent = 'לא הצלחנו לטעון את ההתחברות של Google. בדקו את החיבור לאינטרנט.'; };
    s.onload = function () {
      window.google.accounts.id.initialize({ client_id: cfg.googleClientId, ux_mode: 'popup', callback: function (resp) {
        $('#lerr').textContent = '';
        fetch(cfg.worker.replace(/\/$/, '') + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'ההתחברות נכשלה'); return j; }); })
          .then(function (j) { token = j.token; owner = !!j.owner; remember({ token: j.token, email: j.email, owner: owner }, $('#grem').checked); return enter(j.email); })
          .catch(function (e) { $('#lerr').textContent = e.message; });
      } });
      window.google.accounts.id.renderButton($('#gbtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', locale: 'he', width: 280 });
    };
    document.head.append(s);
  }
  fetch('config.json').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c;
    var st = saved();
    $('#out').addEventListener('click', function () { if (leave()) signout(); });
    $('#burger').addEventListener('click', function () { document.body.classList.toggle('navopen'); });
    $('#scrim').addEventListener('click', function () { document.body.classList.remove('navopen'); });
    if (cfg.worker) {
      if (st && st.email) { token = st.token; owner = !!st.owner; enter(st.email); } else google();
      return;
    }
    $('#tokbox').hidden = false;
    $('#go').addEventListener('click', function () {
      token = $('#tok').value.trim(); if (!token) return;
      remember({ token: token }, $('#rem').checked);
      $('#lerr').textContent = ''; enter();
    });
    $('#tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#go').click(); });
    if (st && st.token) { token = st.token; enter(); }
  });
})();
