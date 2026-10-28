// Site editor (/admin/): dashboard, pages and topics, the site's content files, the Q&A archive and the editors list.
// Data lives in data/*.json in the GitHub repository. Through the editor server (cms-worker/, when config.json has "worker";
// sign-in with Google) a save is a draft that the site does not show; a publisher then publishes chosen drafts in one commit,
// and the Pages workflow tests, builds and publishes it. Without a server (a personal GitHub token) every save is a commit
// straight to the publishing branch.
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
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/>',
    file: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h6"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  };
  function icon(n, cls) { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[n] || ICON.page; return s; }

  // ---- what the editor knows about the site ----
  // Sections of the site, as in its menus: [data file, name, icon, page on the site].
  var GROUPS = [
    ['לימוד', [['library.json', 'ספרייה', 'books', '/library/'], ['kuntresim.json', 'קונטרסים', 'book', '/library/kuntresim/'], ['halacha.json', 'שו״ת הלכתי', 'scale', '/halacha/']]],
    ['רבי נחמן מברסלב', [['rabbi-nachman.json', 'רבי נחמן', 'crown', '/rabbi-nachman/'], ['uman.json', 'אומן', 'pin', '/uman/'], ['tikkun.json', 'התיקון הכללי', 'lyre', '/tikkun-haklali/']]],
    ['הצדיק מיבנאל', [['moharash.json', 'הצדיק מיבנאל', 'flame', '/moharash/'], ['yeshiva.json', 'ישיבת בית מנחם', 'school', '/yeshiva/'], ['print.json', 'הדפסת אשר בנחל', 'print', '/print/']]],
    ['יבנאל עיר ברסלב', [['yavniel.json', 'יבנאל', 'mountain', '/yavniel/'], ['mikveh.json', 'מקווה מלכה', 'drop', '/mikveh-malka/'], ['institutions.json', 'מוסדות הקהילה', 'heart', '/institutions/']]],
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
    image: { name: 'תמונה', icon: 'image', hint: 'תמונה מהספרייה או מקישור', make: function () { return { type: 'image', src: '', alt: '', caption: '' }; } },
    video: { name: 'סרטון', icon: 'film', hint: 'סרטון מהספרייה או מקישור', make: function () { return { type: 'video', src: '', title: '', caption: '' }; } },
    audio: { name: 'שמע', icon: 'music', hint: 'קובץ שמע להאזנה', make: function () { return { type: 'audio', src: '', title: '' }; } },
    file: { name: 'מסמך להורדה', icon: 'file', hint: 'PDF, Word, Excel ועוד', make: function () { return { type: 'file', src: '', title: '', desc: '' }; } },
    links: { name: 'קישורים', icon: 'link', hint: 'רשימת קישורים לאתרים אחרים', make: function () { return { type: 'links', title: '', items: [{ title: '', url: 'https://' }] }; } },
  };
  var RESERVED = ['admin', 'shut', 'letters', 'library', 'halacha', 'rabbi-nachman', 'uman', 'tikkun-haklali', 'moharash', 'yeshiva', 'print', 'yavniel', 'mikveh-malka', 'institutions', 'search', 'about', 'contact', 'accessibility', 'privacy', 'offline', 'fonts', 'img', 'books', 'idx', 'zmanim'];
  var SLUG = /^[a-z0-9-]+$/;

  var OTHER = 'נושאים נוספים'; // the menu group of a topic that names none
  var KINDS = { page: ['דף יחיד', 'דף אחד, כמו ״אומן״. בתפריט של האתר הוא נפתח ישר'], collection: ['אוסף', 'הרבה פריטים מאותו סוג, כמו הספרייה. אפשר לחלק לנושאים'] };
  // "pages" is the old name of a collection without categories.
  var kindOf = function (t) { return t && t.kind === 'page' ? 'page' : 'collection'; };
  var cfg, token, owner = false, publisher = false, me = '', myName = '';
  var draft = false; // saves go to drafts (editor server) instead of straight to the branch
  var pending = { list: [], at: 0 }; // unpublished drafts, as the server last said
  var cur = null; // the open file: { path, sha, indent, data, orig }
  var cache = { topics: null, pages: null, shutIndex: null };
  // What was just created, changed or removed here. The published lists (pages/index.json, shut/index.json) lag a minute or two
  // behind a save, so these notes are laid over them; they are kept in the browser, so a reload does not lose them, and
  // dropped once the published list agrees (or after 15 minutes).
  var RECENT_MS = 15 * 60000, recent = { pages: {}, shut: {} };
  try {
    var rr = JSON.parse(localStorage.getItem('cms-recent') || '{}');
    ['pages', 'shut'].forEach(function (k) { Object.keys(rr[k] || {}).forEach(function (id) { if (Date.now() - rr[k][id].t < RECENT_MS) recent[k][id] = rr[k][id]; }); });
  } catch { /* nothing kept */ }
  function recentSave() { try { localStorage.setItem('cms-recent', JSON.stringify(recent)); } catch { /* storage blocked: kept for this page only */ } }
  function note(kind, id, entry) { recent[kind][id] = { t: Date.now(), e: entry }; recentSave(); }

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
        e.status = r.status; try { e.body = JSON.parse(t); } catch { e.body = {}; } throw e;
      });
    });
  }
  // The editor server's own calls (changes, publish, history, log, names …).
  function wapi(method, path, body) {
    return fetch(cfg.worker.replace(/\/$/, '') + path, { method: method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = {}; try { j = t ? JSON.parse(t) : {}; } catch { /* not JSON */ }
          if (r.status === 401) signout('פג תוקף ההתחברות. התחברו שוב.');
          if (!r.ok) { var e = new Error(j.message || 'שגיאה ' + r.status); e.status = r.status; e.body = j; throw e; }
          return j;
        });
      });
  }
  var ref = function () { return '?ref=' + encodeURIComponent(cfg.branch); };
  function b64e(s) { var b = new TextEncoder().encode(s), r = ''; for (var i = 0; i < b.length; i += 0x8000) r += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(r); }
  function b64d(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), function (c) { return c.charCodeAt(0); })); }
  function getFile(path) { return api('contents/' + path + ref()).then(function (f) { var text = b64d(f.content); var m = /^\n?( +)"/m.exec(text); var data = JSON.parse(text); return { path: path, sha: f.sha, indent: m ? m[1].length : 2, data: data, orig: JSON.stringify(data), draft: !!f.draft }; }); }
  function putFile(path, data, indent, sha, msg, auto) {
    var body = { message: msg, content: b64e(JSON.stringify(data, null, indent) + '\n'), branch: cfg.branch };
    if (sha) body.sha = sha;
    if (auto) body.auto = true;
    return api('contents/' + path, { method: 'PUT', body: JSON.stringify(body) });
  }
  function delFile(path, sha, msg) { return api('contents/' + path, { method: 'DELETE', body: JSON.stringify({ message: msg, sha: sha, branch: cfg.branch }) }).then(function (r) { if (r && r.commit) published(r.commit.sha, null); return r; }); }
  function exists(path) { return api('contents/' + path + ref()).then(function () { return true; }, function (e) { if (e.status === 404) return false; throw e; }); }

  // ---- messages and unsaved changes ----
  var tm;
  function say(t, kind, link) {
    var m = $('#msg'); m.textContent = t; m.className = 'toast' + (kind ? ' ' + kind : ''); m.hidden = false;
    if (link) m.append(' ', el('a', { href: '..' + link, target: '_blank', rel: 'noopener', text: 'לצפייה באתר ←' }));
    clearTimeout(tm); tm = setTimeout(function () { m.hidden = true; }, kind === 'bad' || link ? 10000 : 5000);
  }
  function dirty() { return !!cur && JSON.stringify(cur.data) !== cur.orig; }
  window.addEventListener('beforeunload', function (e) { if (dirty()) { keepLocal(); e.preventDefault(); e.returnValue = ''; } });
  function leave() { if (!dirty()) return true; if (!confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?')) return false; dropLocal(cur); return true; }
  var stT, locT, autoT;
  var AUTO_MS = 30000; // idle time before a long session is saved to the server as a draft (config.json "autosaveSeconds")
  function touch() {
    clearTimeout(stT); stT = setTimeout(status, 120);
    clearTimeout(locT); locT = setTimeout(keepLocal, 2000);
    clearTimeout(autoT); if (draft) autoT = setTimeout(autosave, AUTO_MS);
  }
  function status() {
    var s = $('#savestate'); if (!s) return; var d = dirty();
    s.textContent = d ? 'יש שינויים שלא נשמרו' : draft && cur && cur.draft ? 'נשמר כטיוטה, עוד לא פורסם' : 'כל השינויים שמורים'; s.className = 'state' + (d ? ' dirty' : '');
    var u = $('#undo'); if (u) u.hidden = !d;
    var dd = $('#undraft'); if (dd) dd.hidden = d || !(cur && cur.draft);
  }
  // A copy of what is being typed is kept in this browser every couple of seconds (and offered back if the tab was closed or
  // the computer crashed); after ~30 seconds without typing it is also saved to the server as a draft, without a log entry.
  var localKey = function (f) { return 'cms-draft:' + f.path; };
  function keepLocal() {
    if (!cur || cur.fresh) return;
    try { if (dirty()) localStorage.setItem(localKey(cur), JSON.stringify({ base: cur.sha, t: Date.now(), data: cur.data })); else localStorage.removeItem(localKey(cur)); } catch { /* storage blocked: nothing kept */ }
  }
  function dropLocal(f) { try { if (f) localStorage.removeItem(localKey(f)); } catch { /* storage blocked */ } }
  // Called when a screen has loaded a file: offer the copy kept in this browser, if it holds something the server does not.
  function applyLocal(f) {
    if (!f || f.fresh) return;
    var k = localKey(f), v = null;
    try { v = JSON.parse(localStorage.getItem(k) || 'null'); } catch { /* unreadable */ }
    if (!v) return;
    if (JSON.stringify(v.data) === JSON.stringify(f.data)) { dropLocal(f); return; }
    var changed = v.base !== f.sha;
    if (confirm('נמצאו שינויים שלא נשמרו מ־' + new Date(v.t).toLocaleString('he-IL') + '.' + (changed ? '\n\nשימו לב: מישהו שמר את הקובץ הזה מאז, ושמירה תדרוס את השינוי שלו.' : '') + '\n\nלשחזר אותם?')) f.data = v.data;
    else dropLocal(f);
  }
  function autosave() {
    var f = cur;
    if (!draft || !f || saving || !dirty() || (f.check && f.check())) return;
    var body = f.clean ? f.clean(f.data) : f.data, snapshot = JSON.stringify(f.data);
    saving = true;
    putFile(f.path, body, f.indent, f.sha, 'שמירה אוטומטית', true).then(function (r) {
      f.sha = r.content.sha; f.draft = true; f.fresh = false;
      if (cur === f) f.orig = snapshot; // typed since: still unsaved
      dropLocal(f); refreshPending(); status();
    }, function () { /* silent: the next edit tries again, and the copy in this browser stays */ }).then(function () { saving = false; });
  }

  // ---- web addresses from Hebrew titles ----
  var TR = { 'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z', 'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'p', 'ף': 'f', 'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't' };
  // With the editor server the address is also translated by meaning (Workers AI): the sound-based version shows at once and is
  // replaced when the translation arrives, unless the editor already typed their own address.
  function suggestSlug(titleEl, slugEl) {
    var t;
    titleEl.addEventListener('input', function () {
      if (slugEl.dataset.touched) return;
      slugEl.value = slugify(titleEl.value);
      if (!draft) return;
      clearTimeout(t);
      var asked = titleEl.value.trim();
      if (!asked) return;
      t = setTimeout(function () {
        wapi('POST', '/translate', { text: asked }).then(function (r) { if (r.slug && !slugEl.dataset.touched && titleEl.value.trim() === asked) slugEl.value = r.slug; }, function () { /* keeps the sound-based address */ });
      }, 600);
    });
    slugEl.addEventListener('input', function () { slugEl.dataset.touched = 1; });
  }
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
    var ts = (cache.topics && cache.topics.data) || [];
    nav.append(link('#/', 'home', 'לוח בקרה'), link('#/pages', 'page', 'נושאים ודפים'));
    groupTitles().forEach(function (title) {
      var built = GROUPS.filter(function (g) { return g[0] === title; })[0];
      var mine = ts.filter(function (t) { return (t.group || OTHER) === title; });
      if (!built && !mine.length) return;
      nav.append(el('h3', { text: title }));
      if (title === 'לימוד') nav.append(link('#/shut', 'chat', 'שו״ת ברסלב'));
      if (built) built[1].forEach(function (f) { nav.append(link('#/file/' + f[0], f[2], f[1])); });
      mine.forEach(function (t) { nav.append(link('#/topic/' + t.slug, t.icon || 'book', t.title)); });
    });
    nav.append(el('h3', { text: 'ניהול' }));
    if (draft) {
      var pl = link('#/changes', 'list', 'שינויים ממתינים'); pl.append(el('b', { id: 'hi-count', class: 'nb', text: String(pending.list.length) })); nav.append(pl);
      nav.append(link('#/media', 'image', 'ספריית מדיה'));
      if (publisher) nav.append(link('#/log', 'clock', 'יומן פעילות'));
    }
    nav.append(link('#/file/site.json', 'gear', 'הגדרות האתר'));
    if (owner) nav.append(link('#/editors', 'users', 'עורכים'));
    // On a phone the header keeps only the essentials; the rest is here.
    nav.append(el('div', { class: 'navfoot' },
      draft ? el('button', { type: 'button', onclick: nameDialog, text: 'השם שלי' }) : null,
      el('a', { href: '../', target: '_blank', rel: 'noopener', text: 'לאתר' }),
      el('button', { type: 'button', onclick: function () { $('#out').click(); }, text: 'יציאה' })));
    mark(location.hash || '#/');
  }
  function mark(hash) {
    document.querySelectorAll('#nav a').forEach(function (a) { var h = a.getAttribute('data-h'); a.classList.toggle('cur', h === hash || (h !== '#/' && hash.indexOf(h + '/') === 0) || (h === '#/pages' && /^#\/page\//.test(hash))); });
    document.body.classList.remove('navopen');
  }
  function main() { var m = $('#main'); m.textContent = ''; window.scrollTo(0, 0); return m; }
  function head(title, sub, actions) { return el('header', { class: 'phd' }, el('div', {}, el('h1', { text: title }), sub ? el('p', { class: 'sub', text: sub }) : null), actions ? el('div', { class: 'acts' }, actions) : null); }
  function viewLink(p, text, cls) { return el('a', { class: 'btn ghost' + (cls ? ' ' + cls : ''), href: '..' + p, target: '_blank', rel: 'noopener' }, icon('eye'), text || 'צפייה באתר'); }
  function loading(m) { m.append(el('p', { class: 'loading', text: 'טוען…' })); }

  // Save box, shared by every editing screen. With the editor server a save is a draft and publishing is a separate step.
  var preselect = null; // the file to tick first on the changes screen
  function saveBox(onSave) {
    saveBoxState();
    var box = el('div', { class: 'card pub' },
      el('h3', { text: draft ? 'שמירה ופרסום' : 'פרסום' }),
      el('p', { id: 'savestate', class: 'state', text: 'כל השינויים שמורים' }),
      el('button', { type: 'button', class: 'btn pri wide', id: 'savebtn', onclick: onSave }, draft ? 'שמירה' : 'שמירה ופרסום'));
    if (draft) {
      box.append(
        publisher ? el('button', { type: 'button', class: 'btn ghost wide', id: 'topub', onclick: function () { if (dirty()) return say('שמרו קודם, ואז לחצו על ״לפרסום״.', 'bad'); preselect = cur && cur.path; location.hash = '#/changes'; } }, 'לפרסום…') : null,
        el('button', { type: 'button', class: 'btn ghost wide', id: 'hist', onclick: function () { if (cur && !cur.fresh) historyDialog(cur); } }, icon('clock'), 'גרסאות קודמות'),
        el('button', { type: 'button', class: 'btn ghost wide dng', id: 'undraft', hidden: true, onclick: dropDraft }, 'ביטול הטיוטה, חזרה למה שבאתר'));
    }
    box.append(
      el('button', { type: 'button', class: 'btn ghost wide', id: 'undo', hidden: true, onclick: function () { if (confirm('לבטל את כל השינויים שלא נשמרו?')) { dropLocal(cur); cur.data = JSON.parse(cur.orig); route(true); } } }, 'ביטול השינויים'),
      el('p', { id: 'pubstate', class: 'pubstate', hidden: true }),
      el('p', { class: 'help', text: draft ? 'השמירה לא משנה את האתר: השינוי נשמר כטיוטה ומחכה לפרסום' + (publisher ? '.' : ' על ידי מי שמורשה לפרסם.') + ' קיצור מקלדת: Ctrl+S' : 'אחרי השמירה האתר מתעדכן תוך דקה או שתיים. קיצור מקלדת: Ctrl+S' }));
    return box;
  }
  // The publish state belongs to the last publish, not to the screen: show it again on whichever screen opens next.
  function saveBoxState() { setTimeout(function () { showPub(); status(); }, 0); }
  function dropDraft() {
    var f = cur;
    if (!f || !confirm('לבטל את הטיוטה ולחזור למה שמופיע עכשיו באתר? אפשר יהיה לשחזר אותה רק מהגרסאות שפורסמו.')) return;
    wapi('POST', '/discard', { paths: [f.path] }).then(function () { forget(); say('הטיוטה בוטלה.', 'ok'); refreshPending(); route(true); }, function (e) { say(e.message, 'bad'); });
  }
  // Lists built from the repository may now be out of date.
  function forget() { cache.topics = null; cache.pages = null; cache.shutIndex = null; }
  var saving = false;
  function commit(path, data, indent, sha, msg, url) {
    if (saving) return Promise.reject(new Error('השמירה הקודמת עוד לא הסתיימה'));
    saving = true; var b = $('#savebtn'); if (b) { b.disabled = true; b.textContent = 'שומר…'; }
    return putFile(path, data, indent, sha, msg).then(function (r) {
      clearTimeout(locT); clearTimeout(autoT); dropLocal({ path: path });
      if (draft) { refreshPending(); say('נשמר כטיוטה. האתר עוד לא השתנה, והשינוי יופיע בו אחרי פרסום.', 'ok'); } else published(r.commit.sha, url);
      return r;
    }).finally(function () { saving = false; if (b) { b.disabled = false; b.textContent = draft ? 'שמירה' : 'שמירה ופרסום'; } });
  }
  // A save that found the file changed meanwhile: the editor's text is kept; they choose to reload (their text is offered back)
  // or to save over the other change.
  function saveFail(retry) {
    return function (e) {
      if (!(draft && e.status === 409)) return say(e.message, 'bad');
      keepLocal();
      var dlg = el('dialog', { class: 'dlg' }, el('h2', { text: 'הקובץ השתנה בינתיים' }),
        el('p', { text: 'מישהו אחר שמר את הקובץ הזה אחרי שפתחתם אותו. הטקסט שכתבתם נשמר בדפדפן ולא אבד.' }),
        el('p', { class: 'acts' },
          el('button', { type: 'button', class: 'btn pri', onclick: function () { dlg.close(); route(true); } }, 'טעינה מחדש (ואז אפשר לשחזר את הטקסט שלי)'),
          el('button', { type: 'button', class: 'btn ghost dng', onclick: function () {
            dlg.close();
            api('contents/' + cur.path + ref()).then(function (f) { cur.sha = f.sha; retry(); }, function (x) { if (x.status === 404) { cur.sha = null; retry(); } else say(x.message, 'bad'); });
          } }, 'שמירה בכל זאת, על חשבון השינוי של האחר'),
          el('button', { type: 'button', class: 'btn ghost', onclick: function () { dlg.close(); } }, 'ביטול')));
      dlg.addEventListener('close', function () { dlg.remove(); });
      document.body.append(dlg); dlg.showModal();
    };
  }
  // Header chip: how many drafts wait to be published, and a warning when they have waited for days.
  var OLD_DAYS = 3;
  function drawPend() {
    var c = $('#pend'); if (!c) return;
    c.hidden = !draft;
    var n = pending.list.length, oldest = pending.list.reduce(function (a, x) { return Math.min(a, x.created || a); }, Date.now()), old = n && Date.now() - oldest > OLD_DAYS * 86400000;
    c.textContent = '';
    c.append(el('span', { class: 'lg', text: n ? n + ' שינויים ממתינים לפרסום' : 'אין שינויים ממתינים' }), el('span', { class: 'sh', text: n ? n + ' ממתינים' : 'מעודכן' }));
    c.className = 'hl pend' + (n ? ' has' : '') + (old ? ' old' : '');
    c.title = old ? 'יש שינויים שממתינים לפרסום כבר ' + Math.floor((Date.now() - oldest) / 86400000) + ' ימים' : '';
    var h = $('#hi-count'); if (h) h.textContent = String(n);
  }
  function refreshPending() {
    if (!draft) return Promise.resolve();
    return wapi('GET', '/changes').then(function (j) {
      pending = { list: j.changes || [], at: Date.now() };
      if (cur) cur.draft = pending.list.some(function (x) { return x.path === cur.path; });
      drawPend(); status();
    }, function () { /* the chip keeps its last number */ });
  }
  // After a save: follow it until it is really on the site, as Decap and CloudCannon show the state of the build.
  // The site's run for the commit says whether it waits, runs, failed, or was folded into a newer save (deploys are never cut
  // short; saves made meanwhile wait, and only the newest is built). Then admin/build.json, written by each build, says which
  // commit the site now serves: only then is it "on the site".
  var pub = { state: '', url: null }, mine = []; // mine: the commits saved from this page, oldest first
  function showPub() {
    var p = $('#pubstate'); if (!p) return;
    var text = { wait: '⏳ ממתין לפרסום…', run: '⏳ מתפרסם באתר… בדרך כלל דקה-שתיים', live: '✓ האתר עודכן', bad: '✕ הפרסום נכשל, והאתר נשאר כמו שהיה', slow: 'הפרסום לוקח יותר מהרגיל. אפשר להמשיך לעבוד, והאתר יתעדכן כשיסתיים.' }[pub.state];
    p.hidden = !text; p.className = 'pubstate ' + (pub.state || ''); p.textContent = text || '';
    if (pub.state === 'live' && pub.url) p.append(' · ', el('a', { href: '..' + pub.url, target: '_blank', rel: 'noopener', text: 'צפייה באתר' }));
  }
  function setPub(state, url) { pub = { state: state, url: url === undefined ? pub.url : url }; showPub(); }
  function published(sha, url) {
    mine.push(sha);
    say(draft ? 'פורסם. האתר מתעדכן, זה לוקח דקה או שתיים…' : 'נשמר. האתר מתעדכן, זה לוקח דקה או שתיים…', 'ok');
    setPub('wait', url || null);
    var t0 = Date.now(), done = false;
    var newest = function () { return mine[mine.length - 1] === sha; };
    var live = function () {
      return fetch('build.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (b) {
        var i = mine.indexOf(b.sha); return i >= mine.indexOf(sha) && i > -1; // this commit, or a later one from this page, is what the site serves
      }, function () { return false; });
    };
    (function poll() {
      if (done) return;
      if (Date.now() - t0 > 8 * 60000) { if (newest()) setPub('slow'); return; }
      setTimeout(function () {
        Promise.all([api('actions/runs?head_sha=' + sha).catch(function () { return {}; }), live()]).then(function (r) {
          if (r[1]) { done = true; if (newest()) { setPub('live'); say('האתר עודכן ✓', 'ok', pub.url); } return; }
          var runs = (r[0] && r[0].workflow_runs) || [], run = runs.filter(function (x) { return /Pages/.test(x.name); })[0];
          if (run && run.status === 'completed' && run.conclusion === 'failure') { done = true; if (newest()) { setPub('bad'); say('הפרסום נכשל, והאתר נשאר כמו שהיה. כנראה יש בעיה בתוכן ששמרתם. פנו למי שמתחזק את האתר.', 'bad'); } return; }
          // cancelled: a newer save carries this change too, and its own poll reports it
          if (run && run.status === 'completed' && run.conclusion === 'cancelled' && !newest()) { done = true; return; }
          if (newest()) setPub(run && run.status === 'in_progress' ? 'run' : run && run.status === 'completed' ? 'run' : 'wait');
          poll();
        });
      }, 6000);
    })();
  }
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ד')) { var b = $('#savebtn'); if (b) { e.preventDefault(); b.click(); } } });

  // ---- data shared by several screens ----
  function topics(force) { if (cache.topics && !force) return Promise.resolve(cache.topics); return getFile('data/topics.json').then(function (f) { cache.topics = f; return f; }); }
  function pageFromFile(slug) { return getFile('data/pages/' + slug + '.json').then(function (p) { return { slug: slug, title: p.data.title, topic: p.data.topic, category: p.data.category || '', draft: !!p.draft }; }); }
  // Which pages exist comes from the repository itself (always current, and a deleted page is gone at once); the published list
  // only supplies their titles and categories, and the notes above cover what changed since it was built.
  function pages(force) {
    if (cache.pages && !force) return Promise.resolve(cache.pages);
    var published = fetch('pages/index.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('no index'); return r.json(); })
      .then(function (rows) { var m = {}; rows.forEach(function (r) { m[r[0]] = { slug: r[0], topic: r[1], title: r[2], category: r[3] || '' }; }); return m; }, function () { return null; });
    var drafts = {};
    var listing = api('contents/data/pages' + ref()).then(function (fs) { return fs.filter(function (x) { return /\.json$/.test(x.name); }).map(function (x) { var n = x.name.replace(/\.json$/, ''); if (x.draft) drafts[n] = 1; return n; }); }, function () { return null; });
    return Promise.all([published, listing]).then(function (r) {
      var base = r[0] || {}, names = r[1];
      if (!names) names = Object.keys(base).filter(function (k) { return !(recent.pages[k] && recent.pages[k].e === null); }).concat(Object.keys(recent.pages).filter(function (k) { return recent.pages[k].e && !base[k]; }));
      var out = [], missing = [];
      names.forEach(function (slug) {
        var n = recent.pages[slug], mine = n && n.e;
        if (mine && base[slug] && base[slug].title === mine.title && base[slug].topic === mine.topic && base[slug].category === mine.category) { delete recent.pages[slug]; mine = null; } // the published list has caught up
        var e = mine || base[slug];
        if (drafts[slug]) missing.push(slug); // an unpublished draft: its title and place come from the draft itself
        else if (e) out.push(e); else missing.push(slug);
      });
      Object.keys(recent.pages).forEach(function (k) { if (recent.pages[k].e === null && names.indexOf(k) < 0) delete recent.pages[k]; });
      recentSave();
      return Promise.all(missing.map(pageFromFile)).then(function (more) { cache.pages = out.concat(more); return cache.pages; });
    });
  }
  function pageEntry(slug, p) { note('pages', slug, { slug: slug, title: p.title, topic: p.topic, category: p.category || '' }); cache.pages = null; }
  function groupTitles() {
    var list = GROUPS.map(function (g) { return g[0]; }), ts = (cache.topics && cache.topics.data) || [];
    ts.forEach(function (t) { var g = t.group || OTHER; if (list.indexOf(g) < 0) list.push(g); });
    if (list.indexOf(OTHER) < 0) list.push(OTHER);
    return list;
  }

  // ---- screens ----
  function home() {
    var m = main();
    m.append(head('שלום' + (myName || me ? ', ' + (myName || me.split('@')[0]) : ''), 'מה תרצו לעשות היום?'));
    var tile = function (hash, ic, t, d, fn) { return el('a', { class: 'tile', href: hash || '#/', onclick: fn ? function (e) { e.preventDefault(); fn(); } : null }, el('span', { class: 'tic' }, icon(ic)), el('b', { text: t }), el('span', { text: d })); };
    m.append(el('div', { class: 'tiles' },
      tile(null, 'plus', 'נושא חדש', 'דף יחיד או אוסף חדש באתר', function () { topicDialog(); }),
      tile('#/pages', 'page', 'נושאים ודפים', 'הנושאים שיצרתם, והדפים בכל אחד'),
      tile('#/shut', 'chat', 'שו״ת ברסלב', 'חיפוש, עריכה והוספה של שאלות ותשובות'),
      tile('#/file/yavniel.json', 'mountain', 'זמני תפילות ושיעורים', 'עדכון המידע על יבנאל'),
      draft ? tile('#/changes', 'list', 'שינויים ממתינים', publisher ? 'מה נשמר ועוד לא באתר, ופרסום' : 'מה נשמר ועוד לא פורסם') : null,
      owner ? tile('#/editors', 'users', 'עורכים', 'הוספה והסרה של מי שיכול לערוך, ומי מפרסם') : null,
      el('a', { class: 'tile', href: '../', target: '_blank', rel: 'noopener' }, el('span', { class: 'tic' }, icon('eye')), el('b', { text: 'צפייה באתר' }), el('span', { text: 'נפתח בלשונית חדשה' }))));
    m.append(el('section', { class: 'card how' }, el('h2', { text: 'איך זה עובד' }), el('ol', {},
      el('li', {}, el('b', { text: 'בוחרים' }), ' מהתפריט מה לערוך: דף שיצרתם, חלק קיים באתר, או שאלה מהשו״ת.'),
      el('li', {}, el('b', { text: 'משנים' }), ' את הטקסט בטופס. אפשר להוסיף, למחוק ולהזיז פריטים בחצים.'),
      draft ? el('li', {}, el('b', { text: 'שומרים' }), ' כטיוטה, ואחר כך ב״שינויים ממתינים״ בוחרים מה לפרסם. רק אחרי הפרסום השינוי מופיע באתר (תוך דקה או שתיים).')
        : el('li', {}, el('b', { text: 'לוחצים ״שמירה ופרסום״' }), '. תוך דקה או שתיים השינוי מופיע באתר, ותופיע כאן הודעה שהאתר עודכן.'))));
    var recent = el('section', { class: 'card' }, el('h2', { text: 'הדפים שלכם' }));
    m.append(recent); loading(recent);
    pages().then(function (ps) {
      recent.querySelector('.loading').remove();
      if (!ps.length) recent.append(el('p', { class: 'help', text: 'עדיין לא יצרתם דפים. לחצו על ״דף חדש״ כדי להתחיל.' }));
      ps.slice(0, 8).forEach(function (p) { recent.append(el('a', { class: 'row', href: '#/page/' + p.slug }, icon('page'), el('span', { text: p.title }))); });
    }, function (e) { say(e.message, 'bad'); });
  }

  function kindLabel(t) { return KINDS[kindOf(t)][0]; }
  function pagesScreen() {
    var m = main();
    m.append(head('נושאים ודפים', 'כל נושא נמצא בקבוצה בתפריט של האתר, והוא דף יחיד או אוסף של פריטים.', [
      el('button', { type: 'button', class: 'btn pri', onclick: function () { topicDialog(); } }, icon('plus'), 'נושא חדש')]));
    var box = el('div'); m.append(box); loading(box);
    Promise.all([topics(true), pages(true)]).then(function (r) {
      box.textContent = '';
      var ts = r[0].data, ps = r[1];
      shell();
      if (!ts.length) box.append(el('div', { class: 'empty card' }, el('p', { text: 'עדיין אין נושאים. נושא הוא מקום חדש באתר, למשל ״מתכונים״ או ״פרשת השבוע״.' }), el('button', { type: 'button', class: 'btn pri', onclick: function () { topicDialog(); } }, icon('plus'), 'יצירת נושא ראשון')));
      ts.forEach(function (t) {
        var mine = ps.filter(function (p) { return p.topic === t.slug; });
        var count = kindOf(t) === 'page' ? (mine.length ? 'פורסם' : '') : mine.length ? mine.length + ' פריטים' : '';
        var card = el('section', { class: 'card topic' },
          el('header', {}, el('span', { class: 'tic' }, icon(t.icon || 'book')),
            el('div', { class: 'grow' }, el('h2', {}, el('a', { href: '#/topic/' + t.slug, text: t.title })),
              el('p', { class: 'help', text: kindLabel(t) + ' · בקבוצה ״' + (t.group || OTHER) + '״ · ' + (count || 'עדיין ריק, ולכן לא מופיע באתר') })),
            el('span', { class: 'acts' }, el('a', { class: 'btn ghost sm', href: '#/topic/' + t.slug }, 'פתיחה'))));
        box.append(card);
      });
    }, function (e) { box.textContent = ''; say(e.message, 'bad'); });
  }

  // A topic: its items or pages, with search and (for a collection) a filter by category.
  function topicScreen(slug) {
    var m = main(); loading(m);
    Promise.all([topics(true), pages(true)]).then(function (r) {
      var t = r[0].data.filter(function (x) { return x.slug === slug; })[0];
      m.textContent = '';
      shell();
      if (!t) { say('הנושא לא נמצא. אולי הוא נמחק.', 'bad'); location.hash = '#/pages'; return; }
      if (kindOf(t) === 'page') {
        var own = r[1].filter(function (p) { return p.topic === slug; })[0];
        if (own) { here = '#/page/' + own.slug; history.replaceState(null, '', here); pageScreen(own.slug); mark('#/topic/' + slug); return; }
        m.append(head(t.title, 'דף יחיד · עדיין אין לו תוכן', [el('button', { type: 'button', class: 'btn ghost', onclick: function () { topicDialog(t); } }, 'הגדרות הנושא'), el('button', { type: 'button', class: 'btn ghost dng', onclick: function () { delTopic(t); } }, icon('trash'), 'מחיקת הנושא')]),
          el('div', { class: 'empty card' }, el('p', { text: 'הדף של הנושא הזה עוד לא נכתב.' }), el('button', { type: 'button', class: 'btn pri', onclick: function () { singlePage(t).then(function (ps) { location.hash = '#/page/' + ps; }, function (e) { say(e.message, 'bad'); }); } }, icon('plus'), 'כתיבת הדף')));
        return;
      }
      var coll = true, all = r[1].filter(function (p) { return p.topic === slug; }).sort(function (a, b) { return a.title.localeCompare(b.title, 'he'); });
      var cats = t.categories || [], word = 'פריט';
      m.append(el('p', { class: 'crumbs' }, t.group || OTHER, ' › ', t.title));
      m.append(head(t.title, (t.desc ? t.desc + ' · ' : '') + kindLabel(t) + ' · ' + all.length + ' פריטים', [
        all.length ? viewLink('/' + slug + '/', 'באתר') : null,
        el('button', { type: 'button', class: 'btn ghost', onclick: function () { topicDialog(t); } }, 'הגדרות הנושא'),
        all.length ? null : el('button', { type: 'button', class: 'btn ghost dng', onclick: function () { delTopic(t); } }, icon('trash'), 'מחיקת הנושא'),
        el('button', { type: 'button', class: 'btn pri', onclick: function () { newPage(slug, sel.cat); } }, icon('plus'), word + ' חדש')]));
      var sel = { cat: '', q: '' };
      var q = el('input', { type: 'search', placeholder: 'חיפוש ב' + (coll ? 'פריטים' : 'דפים') + '…', 'aria-label': 'חיפוש' });
      m.append(el('div', { class: 'findbar' }, icon('search'), q));
      var chips = el('div', { class: 'chipbar' }); if (coll && cats.length) m.append(chips);
      var res = el('div', { class: 'card results' }); m.append(res);
      var drawChips = function () {
        chips.textContent = '';
        [['', 'הכול']].concat(cats.map(function (c) { return [c.id, c.title]; })).concat(cats.length ? [['-', 'ללא חלוקה']] : []).forEach(function (c) {
          chips.append(el('button', { type: 'button', class: 'chipb', 'aria-pressed': String(sel.cat === c[0]), onclick: function () { sel.cat = c[0]; drawChips(); draw(); } }, c[1]));
        });
      };
      var draw = function () {
        res.textContent = '';
        var words = q.value.trim().split(/\s+/).filter(Boolean);
        var hits = all.filter(function (p) {
          var okc = !sel.cat || (sel.cat === '-' ? !cats.some(function (c) { return c.id === p.category; }) : p.category === sel.cat);
          return okc && words.every(function (w) { return p.title.indexOf(w) > -1; });
        });
        if (!hits.length) res.append(el('div', { class: 'empty' }, el('p', { class: 'help', text: all.length ? 'לא נמצא מה שחיפשתם.' : 'עדיין אין כאן ' + (coll ? 'פריטים' : 'דפים') + '.' }), all.length ? null : el('button', { type: 'button', class: 'btn pri', onclick: function () { newPage(slug); } }, icon('plus'), word + ' ראשון')));
        hits.forEach(function (p) {
          var c = cats.filter(function (x) { return x.id === p.category; })[0];
          res.append(el('a', { class: 'row', href: '#/page/' + p.slug }, icon('page'), el('span', { class: 'grow', text: p.title }), p.draft ? el('span', { class: 'tag draft', text: 'טיוטה' }) : null, c ? el('span', { class: 'tag', text: c.title }) : null));
        });
      };
      q.addEventListener('input', draw);
      drawChips(); draw();
    }, function (e) { m.textContent = ''; say(e.message, 'bad'); });
  }

  // Create or edit a topic: where it is in the site's menu, whether it is a few pages or a collection, and its categories.
  function topicDialog(t) {
    var edit = !!t;
    var title = el('input', { type: 'text', required: true }); title.value = edit ? t.title : '';
    var desc = el('textarea', { rows: 2 }); desc.value = edit ? t.desc || '' : '';
    var slug = el('input', { type: 'text', class: 'ltr', dir: 'ltr', disabled: edit }); slug.value = edit ? t.slug : '';
    var picked = edit ? t.icon || 'book' : 'book', kind = edit ? kindOf(t) : 'page';
    var grid = el('div', { class: 'igrid', role: 'radiogroup', 'aria-label': 'סמל' });
    Object.keys(ICON_NAMES).forEach(function (n) { var b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(n === picked), title: ICON_NAMES[n], 'aria-label': ICON_NAMES[n], onclick: function () { picked = n; grid.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); } }, icon(n)); grid.append(b); });
    if (!edit) suggestSlug(title, slug);
    // kind
    var kinds = el('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'סוג הנושא' }), catsBody;
    Object.keys(KINDS).forEach(function (k) {
      var b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(k === kind), onclick: function () { kind = k; kinds.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); if (catsBody && catsBody.parentNode) catsBody.parentNode.hidden = kind !== 'collection'; } }, el('b', { text: KINDS[k][0] }), el('small', { text: KINDS[k][1] }));
      kinds.append(b);
    });
    // menu group
    var groupSel = el('select'), groupNew = el('input', { type: 'text', placeholder: 'שם הקבוצה החדשה', hidden: true, maxlength: '40' });
    groupTitles().forEach(function (g) { groupSel.append(el('option', { value: g, text: g })); });
    groupSel.append(el('option', { value: '\u0000new', text: '＋ קבוצה חדשה בתפריט…' }));
    groupSel.value = edit ? t.group || OTHER : 'לימוד';
    groupSel.addEventListener('change', function () { groupNew.hidden = groupSel.value !== '\u0000new'; if (!groupNew.hidden) groupNew.focus(); });
    var groupBox = el('div', {}, groupSel, groupNew);
    // categories of a collection
    var rows = ((edit && t.categories) || []).map(function (c) { return { id: c.id, title: c.title }; });
    var list = el('div', { class: 'catrows' });
    var drawRows = function () {
      list.textContent = '';
      rows.forEach(function (c, i) {
        var inp = el('input', { type: 'text', placeholder: 'שם הנושא' }); inp.value = c.title; inp.addEventListener('input', function () { c.title = inp.value; });
        list.append(el('div', { class: 'catrow' }, inp, tools(rows, i, drawRows, 'נושא')));
      });
      list.append(el('button', { type: 'button', class: 'add', onclick: function () { rows.push({ id: '', title: '' }); drawRows(); var all = list.querySelectorAll('input'); all[all.length - 1].focus(); } }, icon('plus'), 'הוספת נושא'));
    };
    drawRows();
    catsBody = el('div', {}, list);
    dialog(edit ? 'הגדרות הנושא' : 'נושא חדש', [
      ['שם הנושא', title, 'כך הוא יופיע בתפריט של האתר'], ['סוג הנושא', kinds], ['איפה בתפריט', groupBox, 'תחת איזו כותרת בתפריט הנושא יופיע'],
      ['חלוקה לנושאים (לא חובה)', catsBody, 'כל פריט שייך לאחד הנושאים, והאתר מציג אותם מחולקים, כמו בספרייה.'],
      ['תיאור קצר', desc], ['סמל', grid],
      ['כתובת באתר', slug, edit ? 'אי אפשר לשנות כתובת של נושא קיים' : 'באותיות לועזיות. נוצרת לבד מהשם, ואפשר לשנות.'],
    ], edit ? 'שמירה' : 'יצירה', function () {
      var s = slug.value.trim();
      if (!title.value.trim()) return 'חסר שם לנושא';
      if (!SLUG.test(s)) return 'הכתובת יכולה להכיל רק אותיות לועזיות קטנות, ספרות ומקף';
      if (!edit && RESERVED.indexOf(s) > -1) return 'הכתובת הזאת תפוסה על ידי חלק קיים באתר. בחרו אחרת.';
      var group = groupSel.value === '\u0000new' ? groupNew.value.trim() : groupSel.value;
      if (!group) return 'כתבו שם לקבוצה החדשה';
      // categories: keep the id of a row that has one, make one for a new row
      var cats = [], used = {};
      if (kind === 'collection') {
        rows.filter(function (c) { return c.title.trim(); }).forEach(function (c) { if (c.id) used[c.id] = 1; });
        rows.filter(function (c) { return c.title.trim(); }).forEach(function (c) {
          var id = c.id;
          if (!id) { var base = slugify(c.title); id = base; for (var n = 2; used[id]; n++) id = base + '-' + n; used[id] = 1; }
          cats.push({ id: id, title: c.title.trim() });
        });
      }
      return Promise.all([topics(true), pages(true)]).then(function (r) {
        var f = r[0], ps = r[1];
        if (!edit && f.data.some(function (x) { return x.slug === s; })) throw new Error('כבר יש נושא עם הכתובת הזאת');
        // a category that still has items cannot be removed
        var mine = ps.filter(function (p) { return p.topic === s; });
        if (kind === 'page' && mine.length > 1) throw new Error('יש באוסף ' + mine.length + ' פריטים, ודף יחיד יכול להכיל רק דף אחד. מחקו או העבירו פריטים קודם.');
        var gone = (edit && t.categories || []).filter(function (c) { return !cats.some(function (x) { return x.id === c.id; }) && ps.some(function (p) { return p.topic === s && p.category === c.id; }); });
        if (gone.length) throw new Error('יש פריטים בנושא ״' + gone[0].title + '״. העבירו אותם לנושא אחר לפני שמסירים אותו.');
        var row = Object.assign({}, edit ? t : {}, { slug: s, title: title.value.trim(), desc: desc.value.trim(), icon: picked, kind: kind });
        if (group === OTHER) delete row.group; else row.group = group;
        if (kind === 'collection' && cats.length) row.categories = cats; else delete row.categories;
        if (edit) f.data = f.data.map(function (x) { return x.slug === s ? row : x; }); else f.data.push(row);
        return commit('data/topics.json', f.data, 2, f.sha, (edit ? 'עריכת נושא: ' : 'נושא חדש: ') + row.title).then(function () { return [row, mine]; });
      }).then(function (x) {
        cache.topics = null;
        var row = x[0], mine = x[1];
        return topics(true).then(function () {
          shell();
          // A new single page gets its page right away, so the editor opens on it.
          if (kind === 'page' && !mine.length) return singlePage(row).then(function (ps) { say('נוצר. עכשיו כתבו את הדף.', 'ok'); location.hash = '#/page/' + ps; });
          say(edit ? 'הנושא עודכן.' : 'הנושא נוצר. עכשיו הוסיפו לו פריט.', 'ok');
          if (edit) route(true); else location.hash = '#/topic/' + s;
        });
      });
    });
    catsBody.parentNode.hidden = kind !== 'collection';
  }
  function delTopic(t) {
    if (!confirm('למחוק את הנושא ״' + t.title + '״?')) return;
    Promise.all([topics(true), pages(true)]).then(function (r) {
      if (r[1].some(function (p) { return p.topic === t.slug; })) throw new Error(kindOf(t) === 'page' ? 'קודם מחקו את הדף של הנושא.' : 'יש באוסף הזה פריטים. מחקו או העבירו אותם קודם.');
      var f = r[0]; f.data = f.data.filter(function (x) { return x.slug !== t.slug; });
      return commit('data/topics.json', f.data, 2, f.sha, 'מחיקת נושא: ' + t.title);
    }).then(function () { cache.topics = null; say('הנושא נמחק.', 'ok'); return topics(true).then(function () { shell(); location.hash = '#/pages'; }); }, function (e) { say(e.message, 'bad'); });
  }
  function singlePage(t) {
    var try_ = function (name, n) { return exists('data/pages/' + name + '.json').then(function (yes) { return yes ? try_(t.slug + '-' + (n + 1), n + 1) : name; }); };
    return try_(t.slug, 1).then(function (name) {
      var data = { topic: t.slug, title: t.title, lead: t.desc || '', desc: '', blocks: [BLOCKS.text.make()] };
      return commit('data/pages/' + name + '.json', data, 2, null, 'דף חדש: ' + data.title, '/' + t.slug + '/').then(function () { pageEntry(name, data); cur = null; return name; });
    });
  }
  function newPage(topicSlug, category) {
    if (!leave()) return;
    topics().then(function (tf) {
      var colls = tf.data.filter(function (t) { return kindOf(t) === 'collection'; });
      if (!colls.length) { say('פריטים מוסיפים לאוסף. קודם צרו נושא מסוג ״אוסף״.', 'bad'); topicDialog(); return; }
      var topic = el('select'); colls.forEach(function (t) { topic.append(el('option', { value: t.slug, text: t.title })); });
      if (typeof topicSlug === 'string') topic.value = topicSlug;
      var catSel = el('select'), catField = el('div', {}, catSel);
      var fillCats = function () {
        var tp = tf.data.filter(function (x) { return x.slug === topic.value; })[0], cs = (tp && tp.kind === 'collection' && tp.categories) || [];
        catSel.textContent = ''; catSel.append(el('option', { value: '', text: 'ללא חלוקה' })); cs.forEach(function (c) { catSel.append(el('option', { value: c.id, text: c.title })); });
        catSel.value = cs.some(function (c) { return c.id === category; }) ? category : '';
        catField.parentNode && (catField.parentNode.hidden = !cs.length);
      };
      topic.addEventListener('change', function () { category = ''; fillCats(); });
      var title = el('input', { type: 'text', required: true }), slug = el('input', { type: 'text', class: 'ltr', dir: 'ltr' });
      suggestSlug(title, slug);
      dialog('פריט חדש', [['כותרת', title], ['אוסף', topic], ['חלוקה', catField], ['כתובת באתר', slug, 'באותיות לועזיות. נוצרת לבד מהכותרת, ואפשר לשנות.']], 'יצירה', function () {
        var s = slug.value.trim();
        if (!title.value.trim()) return 'חסרה כותרת';
        if (!SLUG.test(s)) return 'הכתובת יכולה להכיל רק אותיות לועזיות קטנות, ספרות ומקף';
        var path = 'data/pages/' + s + '.json';
        return exists(path).then(function (yes) {
          if (yes) throw new Error('כבר יש דף עם הכתובת הזאת. שנו אותה מעט.');
          var data = { topic: topic.value, title: title.value.trim(), lead: '', desc: '', blocks: [BLOCKS.text.make()] };
          if (catSel.value) data.category = catSel.value;
          return commit(path, data, 2, null, 'דף חדש: ' + data.title, '/' + data.topic + '/' + s + '/').then(function () { pageEntry(s, data); });
        }).then(function () { cur = null; say('נוצר. עכשיו כתבו את התוכן.', 'ok'); location.hash = '#/page/' + s; });
      });
      fillCats();
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
      cur.check = function () { return pageProblem(cur.data); };
      applyLocal(cur); p = cur.data;
      m.textContent = '';
      var t = ts.filter(function (x) { return x.slug === p.topic; })[0];
      var single = kindOf(t) === 'page';
      m.append(el('p', { class: 'crumbs' }, el('a', { href: '#/pages', text: 'נושאים ודפים' }), ' › ', t && !single ? el('a', { href: '#/topic/' + t.slug, text: t.title }) : (t ? t.title : p.topic)));
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
          else if (MEDIA_BLOCK[b.type]) body.append(mediaFields(b, draw));
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
      // An item can move to another collection; a single page stays with its topic.
      var topicSel = el('select', { id: 'ptopic' }); ts.filter(function (x) { return kindOf(x) === 'collection' || x.slug === p.topic; }).forEach(function (x) { topicSel.append(el('option', { value: x.slug, text: x.title })); }); topicSel.value = p.topic;
      // The category field exists only for a collection that has categories; moving to another topic clears it.
      var catWrap = el('div');
      var drawCat = function () {
        catWrap.textContent = '';
        var tp = ts.filter(function (x) { return x.slug === p.topic; })[0], cs = (tp && tp.kind === 'collection' && tp.categories) || [];
        if (!cs.length) { delete p.category; return; }
        var sel = el('select', { id: 'pcat' }, el('option', { value: '', text: 'ללא חלוקה' }));
        cs.forEach(function (c) { sel.append(el('option', { value: c.id, text: c.title })); });
        sel.value = cs.some(function (c) { return c.id === p.category; }) ? p.category : '';
        sel.addEventListener('change', function () { if (sel.value) p.category = sel.value; else delete p.category; touch(); });
        catWrap.append(el('div', { class: 'fld' }, el('label', { for: 'pcat', text: 'חלוקה' }), sel));
      };
      topicSel.addEventListener('change', function () { p.topic = topicSel.value; delete p.category; drawCat(); touch(); });
      drawCat();
      var url = single ? '/' + p.topic + '/' : '/' + p.topic + '/' + slug + '/';
      side.append(saveBox(function () { savePage(slug); }),
        el('div', { class: 'card' }, el('h3', { text: 'הגדרות הדף' }),
          single ? el('p', { class: 'help' }, 'דף יחיד של הנושא ״' + t.title + '״. ', el('button', { type: 'button', class: 'btn ghost sm', onclick: function () { topicDialog(t); } }, 'הגדרות הנושא'))
            : el('div', { class: 'fld' }, el('label', { for: 'ptopic', text: 'אוסף' }), topicSel), catWrap,
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
  function pageProblem(p) {
    if (!p.title || !p.title.trim()) return 'חסרה כותרת לדף';
    var mb_ = (p.blocks || []).filter(function (b) { return MEDIA_BLOCK[b.type]; });
    for (var i = 0; i < mb_.length; i++) {
      var b = mb_[i], what = BLOCKS[b.type].name;
      if (!/^(\/media\/[\w.-]+|https:\/\/\S+)$/.test(b.src || '')) return 'בחרו קובץ למקטע ה' + what + ', או הדביקו קישור שמתחיל ב־https://';
      if (b.type === 'image' ? !String(b.alt || '').trim() : !String(b.title || '').trim()) return b.type === 'image' ? 'חסר תיאור לתמונה (לקוראי מסך)' : 'חסרה כותרת למקטע ה' + what;
    }
    if ((p.blocks || []).some(function (b) { return b.type === 'links' && (b.items || []).some(function (l) { return !/^https:\/\/\S+$/.test(l.url || ''); }); })) return 'כל קישור צריך להתחיל ב־https://';
    return '';
  }
  function savePage(slug) {
    var p = cur.data, bad = pageProblem(p);
    if (bad) return say(bad, 'bad');
    var f = cur, oldTopic = JSON.parse(f.orig).topic;
    var tp = (cache.topics && cache.topics.data || []).filter(function (x) { return x.slug === p.topic; })[0];
    commit(f.path, p, f.indent, f.sha, 'עריכת דף: ' + p.title, kindOf(tp) === 'page' ? '/' + p.topic + '/' : '/' + p.topic + '/' + slug + '/').then(function (r) {
      f.sha = r.content.sha; f.orig = JSON.stringify(p); pageEntry(slug, p); status();
      if (oldTopic !== p.topic) say('נשמר. שימו לב: הכתובת של הפריט השתנתה ל־/' + p.topic + '/' + slug + '/', 'ok');
    }, saveFail(function () { savePage(slug); }));
  }
  function delPage() {
    if (!confirm('למחוק את ״' + cur.data.title + '״ מהאתר? אי אפשר לבטל את זה מכאן.')) return;
    delFile(cur.path, cur.sha, 'מחיקת דף: ' + cur.data.title).then(function () { refreshPending(); var gone = cur.path.replace(/^data\/pages\/|\.json$/g, ''), tp = cur.data.topic; note('pages', gone, null); cache.pages = null; cur = null; say(draft ? 'נמחק בטיוטה. הדף יוסר מהאתר אחרי פרסום.' : 'נמחק. האתר יתעדכן תוך דקה או שתיים.', 'ok'); location.hash = kindOf((cache.topics && cache.topics.data || []).filter(function (x) { return x.slug === tp; })[0]) === 'page' ? '#/pages' : '#/topic/' + tp; }, function (e) { say(e.message, 'bad'); });
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
      if (MEDIA_BLOCK[b.type]) {
        var u = esc(/^\//.test(b.src || '') ? new URL('..' + b.src, location.href).href : b.src || '');
        if (b.type === 'image') return sect(i, '<figure class="media"><img src="' + u + '" alt="' + esc(b.alt) + '">' + (b.caption ? '<figcaption>' + esc(b.caption) + '</figcaption>' : '') + '</figure>', b);
        if (b.type === 'video') return sect(i, '<figure class="media"><video controls preload="metadata" src="' + u + '"></video><figcaption>' + esc(b.caption || b.title) + '</figcaption></figure>', b);
        if (b.type === 'audio') return sect(i, '<figure class="media audio"><figcaption>' + esc(b.title) + '</figcaption><audio controls src="' + u + '"></audio></figure>', b);
        return sect(i, '<a class="filecard"><span class="ftxt"><b>' + esc(b.title) + '</b>' + (b.desc ? '<span>' + esc(b.desc) + '</span>' : '') + '</span><span class="btn">הורדה</span></a>', b);
      }
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
      cur.check = function () { return fileProblem(name, cur.data); };
      applyLocal(cur);
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
  function fileProblem(name, d) {
    if (name === 'halacha.json' && d.some(function (x) { return !/^[\w-]+$/.test(String(x.id)) || !x.title; })) return 'לכל שאלה צריכה להיות כותרת';
    if (name === 'site.json' && (d.hidden || []).some(function (h) { return !/^\/[\w/-]*$/.test(h.path || ''); })) return 'כל נתיב מוסתר צריך להתחיל ב־/';
    return '';
  }
  function saveFile(name) {
    var f = cur, bad = fileProblem(name, f.data);
    if (bad) return say(bad, 'bad');
    commit(f.path, f.data, f.indent, f.sha, 'עריכת תוכן: ' + (FILE[name] ? FILE[name].name : name), FILE[name] && FILE[name].url || '/').then(function (r) { f.sha = r.content.sha; f.orig = JSON.stringify(f.data); status(); }, saveFail(function () { saveFile(name); }));
  }

  // ---- the Q&A archive: search in a light list, edit one entry at a time (data/shut-edits/<id>.json) ----
  function shutIndex() {
    if (cache.shutIndex) return Promise.resolve(cache.shutIndex);
    return fetch('shut/index.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('רשימת השאלות עוד לא זמינה. נסו שוב בעוד כמה דקות.'); return r.json(); }).then(function (x) { cache.shutIndex = x; return x; });
  }
  // The published Q&A list with the notes laid over it: hidden questions are left out, edited ones show their new title, new ones are added.
  function shutDrafts() {
    if (!draft) return Promise.resolve({});
    return refreshPending().then(function () {
      var its = pending.list.filter(function (x) { return /^data\/shut-edits\//.test(x.path) && x.status !== 'removed'; });
      return Promise.all(its.map(function (it) { return getFile(it.path).then(function (f) { return [f.data.id, f.data.deleted ? { e: null } : { e: { kind: f.data.kind, title: f.data.title, date: f.data.date || '' } }]; }, function () { return null; }); }));
    }).then(function (rows) { var o = {}; (Array.isArray(rows) ? rows : []).forEach(function (r) { if (r) o[String(r[0])] = r[1]; }); return o; });
  }
  function shutRows(idx, extra) {
    var byId = {}; idx.forEach(function (x) { byId[String(x[0])] = x; });
    Object.keys(recent.shut).forEach(function (id) {
      var n = recent.shut[id], row = byId[id];
      if (n.e === null) { if (!row) delete recent.shut[id]; return; } // hidden; once the published list lacks it, nothing is left to cover
      if (row && row[2] === n.e.title && row[3] === (n.e.date || '') && row[1] === n.e.kind) { delete recent.shut[id]; return; }
    });
    recentSave();
    var ov = Object.assign({}, recent.shut, extra || {}); // drafts are newer than what was just published
    var out = idx.filter(function (x) { var n = ov[String(x[0])]; return !(n && n.e === null); }).map(function (x) { var n = ov[String(x[0])]; return n && n.e ? [x[0], n.e.kind, n.e.title, n.e.date || '', x[4]] : x; });
    Object.keys(ov).forEach(function (id) { if (ov[id].e && !byId[id]) out.push([+id || id, ov[id].e.kind, ov[id].e.title, ov[id].e.date || '', -1]); });
    return out;
  }
  function shutScreen() {
    var m = main();
    var q = el('input', { type: 'search', placeholder: 'חיפוש לפי מילים מהכותרת, או מספר שאלה…', 'aria-label': 'חיפוש שאלה' });
    var kind = el('select', { 'aria-label': 'סוג' }, el('option', { value: 'shut', text: 'שו״ת' }), el('option', { value: 'letters', text: 'מכתבים' }));
    m.append(head('שו״ת ברסלב', 'חפשו שאלה כדי לערוך אותה, או הוסיפו שאלה חדשה.', [el('a', { class: 'btn pri', href: '#/shut/new' }, icon('plus'), 'שאלה חדשה')]));
    m.append(el('div', { class: 'findbar big' }, icon('search'), q, kind));
    var res = el('div', { class: 'card results' }); m.append(res); loading(res);
    Promise.all([shutIndex(), shutDrafts()]).then(function (r) {
      var idx = shutRows(r[0], r[1]);
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
      cur = f; cur.check = function () { return shutProblem(cur.data); }; cur.clean = shutClean; cur.fresh = isNew;
      applyLocal(cur);
      var x = f.data;
      m.textContent = '';
      m.append(el('p', { class: 'crumbs' }, el('a', { href: '#/shut', text: 'שו״ת ברסלב' }), ' › ', isNew ? 'שאלה חדשה' : '#' + x.id));
      if (x.deleted) {
        cur = null;
        m.append(el('section', { class: 'card' }, el('h2', { text: 'השאלה הזאת מוסתרת מהאתר' }), el('button', { type: 'button', class: 'btn pri', onclick: function () { delFile(f.path, f.sha, 'החזרת שאלה ' + x.id).then(function () { refreshPending(); cache.shutIndex = null; delete recent.shut[String(x.id)]; recentSave(); say('השאלה תחזור לאתר תוך דקה או שתיים.', 'ok'); location.hash = '#/shut'; }, function (e) { say(e.message, 'bad'); }); } }, 'החזרה לאתר')));
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
  function shutClean(x) { return Object.assign({}, x, { q: x.q.filter(function (p) { return p.trim(); }), a: x.a.filter(function (p) { return p.trim(); }) }); }
  function shutProblem(x) {
    if (!String(x.title || '').trim()) return 'חסרה כותרת';
    return shutClean(x).a.length ? '' : 'חסרה תשובה';
  }
  function saveShut(isNew) {
    var f = cur, x = f.data, bad = shutProblem(x);
    if (bad) return say(bad, 'bad');
    var clean = shutClean(x);
    commit(f.path, clean, 2, f.sha, (isNew ? 'שאלה חדשה ' : 'עריכת שאלה ') + x.id + ': ' + x.title, (x.kind === 'letters' ? '/letters/' : '/shut/') + x.id + '/').then(function (r) {
      f.sha = r.content.sha; f.data = clean; f.orig = JSON.stringify(clean); note('shut', String(x.id), { kind: clean.kind, title: clean.title, date: clean.date || '' }); status();
      if (isNew) { cur = null; location.hash = '#/shut/' + x.id; }
    }, saveFail(function () { saveShut(isNew); }));
  }
  function hideShut() {
    var f = cur;
    if (!confirm('להסתיר את השאלה ״' + f.data.title + '״ מהאתר? אפשר להחזיר אותה אחר כך.')) return;
    var id = f.data.id;
    commit(f.path, { id: id, deleted: true }, 2, f.sha, 'הסתרת שאלה ' + id).then(function () { note('shut', String(id), null); cur = null; say(draft ? 'השאלה תוסתר מהאתר אחרי פרסום.' : 'השאלה תוסתר מהאתר תוך דקה או שתיים.', 'ok'); location.hash = '#/shut'; }, function (e) { say(e.message, 'bad'); });
  }

  // ---- editors (site owners only; the server checks this too) ----
  function editorsApi(method, body) { return wapi(method, '/editors', body).then(function (j) { return j.editors; }); }
  function editorsScreen() {
    var m = main();
    m.append(head('עורכים', 'מי שברשימה יכול להתחבר עם חשבון ה־Google שלו ולערוך את האתר. בעלי האתר תמיד יכולים להיכנס ולפרסם, ורק הם רואים את המסך הזה.'));
    var card = el('section', { class: 'card' }); m.append(card); loading(card);
    var fail = function (x) { say(x.message, 'bad'); };
    var drawList = function (list) {
      card.textContent = '';
      var inp = el('input', { id: 'newed', type: 'email', class: 'ltr', dir: 'ltr', autocomplete: 'off', placeholder: 'name@gmail.com', required: true });
      var nm = el('input', { id: 'newname', type: 'text', maxlength: '40', placeholder: 'למשל: יעקב' });
      var pb = el('input', { id: 'newpub', type: 'checkbox' });
      var form = el('form', { class: 'addrow' },
        el('div', { class: 'fld grow' }, el('label', { for: 'newed', text: 'הוספת עורך: כתובת Gmail (או חשבון Google אחר)' }), inp),
        el('div', { class: 'fld grow' }, el('label', { for: 'newname', text: 'שם תצוגה (יופיע בהיסטוריה הציבורית)' }), nm),
        el('label', { class: 'chk' }, pb, 'מפרסם'),
        el('button', { type: 'submit', class: 'btn pri' }, icon('plus'), 'הוספה'));
      form.addEventListener('submit', function (e) { e.preventDefault(); var v = inp.value.trim(); if (!v) return; editorsApi('PUT', { email: v, name: nm.value.trim(), publisher: pb.checked }).then(function (l) { say('העורך נוסף: ' + v, 'ok'); drawList(l); }, fail); });
      card.append(form, el('p', { class: 'help', text: 'כל עוד אפליקציית ההתחברות ב־Google במצב בדיקה, צריך להוסיף את העורך גם שם: Google Auth Platform › Audience › Test users. מפרסם יכול לפרסם שינויים לאתר; עורך רגיל רק שומר טיוטות.' }));
      if (!list.length) card.append(el('p', { class: 'help', text: 'עדיין אין עורכים נוספים.' }));
      var ul = el('ul', { class: 'eds' });
      list.forEach(function (ed) {
        var name = el('input', { type: 'text', maxlength: '40', placeholder: 'שם תצוגה', 'aria-label': 'שם התצוגה של ' + ed.email }); name.value = ed.name || '';
        name.addEventListener('change', function () { editorsApi('PUT', { email: ed.email, name: name.value.trim() }).then(function () { say('השם נשמר.', 'ok'); }, fail); });
        var pub = el('input', { type: 'checkbox', 'aria-label': 'מפרסם: ' + ed.email }); pub.checked = !!ed.publisher;
        pub.addEventListener('change', function () { editorsApi('PUT', { email: ed.email, publisher: pub.checked }).then(function () { say(pub.checked ? 'העורך יכול עכשיו לפרסם.' : 'העורך כבר לא יכול לפרסם.', 'ok'); }, function (x) { pub.checked = !pub.checked; fail(x); }); });
        ul.append(el('li', {}, el('span', { class: 'ltr grow', text: ed.email }), name, el('label', { class: 'chk' }, pub, 'מפרסם'),
          el('button', { type: 'button', class: 'btn ghost sm dng', onclick: function () { if (confirm('להסיר את ' + ed.email + ' מהעורכים?')) editorsApi('DELETE', { email: ed.email }).then(function (l) { say('העורך הוסר: ' + ed.email, 'ok'); drawList(l); }, fail); } }, 'הסרה')));
      });
      card.append(ul);
    };
    editorsApi('GET').then(drawList, function (e) { card.textContent = ''; say(e.message, 'bad'); });
  }

  // ---- media: images, video, audio and documents ----
  // Small files are kept in the site's repository and published with everything else; large files and video go to R2 (the
  // server decides, by type and size, and counts the free allowance of each place). A page points at a file by its link.
  var MEDIA_KINDS = { image: ['תמונה', 'image'], video: ['סרטון', 'film'], audio: ['שמע', 'music'], doc: ['מסמך', 'file'] };
  var MEDIA_BLOCK = { image: 'image', video: 'video', audio: 'audio', file: 'doc' }; // page block type -> media kind
  var MEDIA_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.avif,.mp4,.webm,.mov,.mp3,.m4a,.wav,.ogg,.aac,.pdf,.docx,.xlsx,.pptx,.txt,.epub';
  var PIECE = 393216;
  function mbytes(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }
  function readB64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).replace(/^data:[^,]*,/, '')); }; r.onerror = function () { rej(new Error('לא הצלחנו לקרוא את הקובץ')); }; r.readAsDataURL(blob); }); }
  // Uploads one file; onProgress gets 0..1. Resolves with the new library item.
  function uploadMedia(file, onProgress) {
    return wapi('POST', '/media/init', { name: file.name, size: file.size }).then(function (init) {
      if (init.store === 'r2') {
        return new Promise(function (res, rej) {
          var x = new XMLHttpRequest();
          x.open('PUT', cfg.worker.replace(/\/$/, '') + '/media/r2?id=' + init.id);
          x.setRequestHeader('Authorization', 'Bearer ' + token);
          x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
          x.onload = function () { var j = {}; try { j = JSON.parse(x.responseText); } catch { /* not JSON */ } if (x.status === 401) signout('פג תוקף ההתחברות. התחברו שוב.'); if (x.status < 300) res(j.item); else rej(new Error(j.message || 'שגיאה ' + x.status)); };
          x.onerror = function () { rej(new Error('החיבור נפסק. נסו שוב.')); };
          x.send(file);
        });
      }
      var n = Math.ceil(file.size / PIECE);
      var piece = function (i) {
        if (i >= n) return wapi('POST', '/media/done', { id: init.id }).then(function (j) { return j.item; });
        return readB64(file.slice(i * PIECE, (i + 1) * PIECE)).then(function (d) { return wapi('POST', '/media/chunk', { id: init.id, n: i, data: d }); }).then(function () { onProgress((i + 1) / n); return piece(i + 1); });
      };
      return piece(0);
    });
  }
  // Uploads several files one after another, with a progress row for each; calls done(item) for each success.
  function uploadMany(files, list, done) {
    return Array.prototype.reduce.call(files, function (chain, file) {
      var bar = el('span', { class: 'bar' }), msg = el('small', { class: 'help' }), row = el('li', {}, el('span', { class: 'grow', text: file.name }), el('span', { class: 'prog' }, bar), msg);
      list.append(row);
      return chain.then(function () {
        return uploadMedia(file, function (f) { bar.setAttribute('data-p', String(Math.round(f * 10))); msg.textContent = Math.round(f * 100) + '%'; }).then(function (item) { row.className = 'okrow'; msg.textContent = 'הועלה'; if (done) done(item); }, function (e) { row.className = 'badrow'; msg.textContent = e.message; });
      });
    }, Promise.resolve());
  }
  // A staged image (not yet published) is shown from the pieces the server holds.
  function stagedSrc(item) {
    var n = Math.ceil(item.size / PIECE), got = [];
    for (var i = 0; i < n; i++) got.push(wapi('GET', '/media/' + item.id + '/chunk?n=' + i).then(function (j) { return j.data; }));
    return Promise.all(got).then(function (ds) { return 'data:' + item.mime + ';base64,' + ds.join(''); });
  }
  function mediaThumb(item) {
    var box = el('span', { class: 'mthumb' }, icon(MEDIA_KINDS[item.kind][1]));
    if (item.kind === 'image') {
      var show = function (src) { box.textContent = ''; box.append(el('img', { src: src, alt: '', loading: 'lazy' })); };
      if (item.status === 'staged') stagedSrc(item).then(show, function () { /* icon stays */ });
      else show(item.store === 'github' ? '..' + item.url : item.url);
    }
    return box;
  }
  function quotaBar(label, q, off) {
    var pct = q.max ? Math.min(100, Math.round(q.used / q.max * 100)) : 0;
    return el('div', { class: 'quota' }, el('div', { class: 'qh' }, el('b', { text: label }), el('small', { text: off ? 'עוד לא הופעל' : mbytes(q.used) + ' מתוך ' + mbytes(q.max) })), el('div', { class: 'qbar' + (pct > 85 ? ' hi' : '') }, el('i', { 'data-p': off ? '0' : String(Math.round(pct / 10)) })));
  }
  function pagesUsing(src) {
    return api('contents/data/pages' + ref()).then(function (fs) {
      return Promise.all(fs.filter(function (x) { return /\.json$/.test(x.name); }).map(function (x) { return readJson('data/pages/' + x.name).then(function (d) { return d && JSON.stringify(d.blocks || []).indexOf(JSON.stringify(src).slice(1, -1)) > -1 ? d.title : null; }); }));
    }).then(function (ts) { return ts.filter(Boolean); }, function () { return []; });
  }
  function mediaScreen() {
    var m = main();
    m.append(head('ספריית מדיה', 'תמונות, סרטונים, שמע ומסמכים להוספה לדפים. הקבצים הקטנים נשמרים עם האתר ויפורסמו בפרסום, והגדולים והסרטונים נשמרים באחסון נפרד.'));
    var quota = el('section', { class: 'card' }), list = el('ul', { class: 'upl' });
    var input = el('input', { type: 'file', multiple: true, accept: MEDIA_ACCEPT, id: 'mfile', hidden: true });
    var pick = el('button', { type: 'button', class: 'btn pri', onclick: function () { input.click(); } }, icon('plus'), 'העלאת קבצים');
    var drop = el('section', { class: 'card drop' }, el('p', { text: 'גררו לכאן קבצים, או לחצו על הכפתור.' }), pick, input, list);
    var chips = el('div', { class: 'chipbar' }), grid = el('div', { class: 'mgrid' });
    var q = el('input', { type: 'search', placeholder: 'חיפוש לפי שם…', 'aria-label': 'חיפוש קובץ' });
    m.append(quota, drop, el('div', { class: 'findbar' }, icon('search'), q), chips, grid);
    var kind = '', data = { items: [], quota: null };
    var draw = function () {
      var w = q.value.trim();
      quota.textContent = ''; quota.append(el('h2', { text: 'מכסת האחסון החינמית' }));
      if (data.quota) quota.append(quotaBar('אחסון עם האתר (קבצים קטנים)', data.quota.github), quotaBar('אחסון קבצים גדולים וסרטונים', data.quota.r2, !data.quota.r2.enabled),
        el('p', { class: 'help', text: 'עד ' + mbytes(data.quota.github.fileMax) + ' לקובץ באחסון עם האתר' + (data.quota.r2.enabled ? ', ועד ' + mbytes(data.quota.r2.fileMax) + ' לקובץ באחסון הגדול' : '. סרטונים וקבצים גדולים יותר דורשים הפעלת אחסון הקבצים הגדולים (R2), או קישור לסרטון ב־YouTube') + '.' }));
      chips.textContent = '';
      [['', 'הכול']].concat(Object.keys(MEDIA_KINDS).map(function (k) { return [k, MEDIA_KINDS[k][0]]; })).forEach(function (c) { chips.append(el('button', { type: 'button', class: 'chipb', 'aria-pressed': String(kind === c[0]), onclick: function () { kind = c[0]; draw(); } }, c[1])); });
      grid.textContent = '';
      var hits = data.items.filter(function (x) { return (!kind || x.kind === kind) && (!w || x.name.indexOf(w) > -1); });
      if (!hits.length) grid.append(el('p', { class: 'help center', text: data.items.length ? 'לא נמצא מה שחיפשתם.' : 'עדיין לא הועלו קבצים.' }));
      hits.forEach(function (x) {
        var st = x.status === 'staged' ? 'ממתין לפרסום' : x.status === 'removing' ? 'יוסר בפרסום' : '';
        grid.append(el('div', { class: 'mcard' }, mediaThumb(x), el('div', { class: 'grow' }, el('b', { class: 'mname', text: x.name }), el('small', { class: 'help', text: MEDIA_KINDS[x.kind][0] + ' · ' + mbytes(x.size) + ' · ' + x.by }), st ? el('span', { class: 'tag draft', text: st }) : null),
          el('span', { class: 'acts' },
            el('button', { type: 'button', class: 'btn ghost sm', onclick: function () { var full = x.store === 'github' ? new URL('..' + x.url, location.href).href : x.url; (navigator.clipboard ? navigator.clipboard.writeText(full) : Promise.reject()).then(function () { say('הקישור הועתק.', 'ok'); }, function () { prompt('הקישור:', full); }); } }, 'העתקת קישור'),
            x.status === 'removing' ? null : el('button', { type: 'button', class: 'btn ghost sm dng', onclick: function () { removeMedia(x, load); } }, 'מחיקה'))));
      });
    };
    var load = function () { return wapi('GET', '/media').then(function (j) { data = j; draw(); refreshPending(); }, function (e) { say(e.message, 'bad'); }); };
    var go = function (files) { if (files && files.length) uploadMany(files, list).then(load); };
    input.addEventListener('change', function () { go(input.files); input.value = ''; });
    ['dragover', 'dragenter'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); go(e.dataTransfer.files); });
    q.addEventListener('input', draw);
    load();
  }
  // A file used by a published page cannot be removed from the repository without breaking the build: say where it is used.
  function removeMedia(x, after) {
    pagesUsing(x.url).then(function (used) {
      if (used.length && x.store === 'github') return say('הקובץ בשימוש בדפים: ' + used.join(', ') + '. הסירו אותו משם קודם.', 'bad');
      if (!confirm('למחוק את ״' + x.name + '״?' + (used.length ? '\nשימו לב: הוא בשימוש בדפים: ' + used.join(', ') + '.' : '') + (x.status === 'published' && x.store === 'github' ? '\nהקובץ יוסר מהאתר בפרסום הבא.' : ''))) return;
      wapi('DELETE', '/media/' + x.id).then(function () { say('נמחק.', 'ok'); after(); }, function (e) { say(e.message, 'bad'); });
    });
  }
  // Choose a file for a page block, or upload one on the spot.
  function pickMedia(kind, onPick) {
    var dlg = el('dialog', { class: 'dlg wide' }, el('h2', { text: 'בחירת ' + MEDIA_KINDS[kind][0] }));
    var input = el('input', { type: 'file', accept: MEDIA_ACCEPT, hidden: true }), list = el('ul', { class: 'upl' }), grid = el('div', { class: 'mgrid pick' });
    var chosen = function (x) { dlg.close(); onPick(x); };
    var load = function () {
      grid.textContent = ''; loading(grid);
      wapi('GET', '/media').then(function (j) {
        grid.textContent = '';
        var items = j.items.filter(function (x) { return x.kind === kind && x.status !== 'removing'; });
        if (!items.length) grid.append(el('p', { class: 'help center', text: 'עדיין אין כאן קבצים מסוג זה. אפשר להעלות אחד.' }));
        items.forEach(function (x) { grid.append(el('button', { type: 'button', class: 'mcard btn-like', onclick: function () { chosen(x); } }, mediaThumb(x), el('span', { class: 'grow' }, el('b', { class: 'mname', text: x.name }), el('small', { class: 'help', text: mbytes(x.size) + (x.status === 'staged' ? ' · ממתין לפרסום' : '') })))); });
      }, function (e) { grid.textContent = ''; grid.append(el('p', { class: 'err', text: e.message })); });
    };
    input.addEventListener('change', function () { var fs = input.files; input.value = ''; if (fs.length) uploadMany(fs, list, function (item) { if (item.kind === kind) chosen(item); }).then(load); });
    dlg.append(el('p', { class: 'acts' }, el('button', { type: 'button', class: 'btn pri', onclick: function () { input.click(); } }, icon('plus'), 'העלאת קובץ חדש'), input, el('button', { type: 'button', class: 'btn ghost', onclick: function () { dlg.close(); } }, 'ביטול')), list, grid);
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal(); load();
  }
  // Fields of an image, video, audio or file block of a page.
  function mediaFields(b, redraw) {
    var kind = MEDIA_BLOCK[b.type], box = el('div');
    box.append(textInput(b, 'src', 'הקובץ (בחירה מהספרייה, או קישור שמתחיל ב־https://)', { k: 'url' }),
      el('button', { type: 'button', class: 'btn ghost sm', onclick: function () { pickMedia(kind, function (x) { b.src = x.url; touch(); redraw(); }); } }, icon(MEDIA_KINDS[kind][1]), 'בחירה מהספרייה או העלאה'));
    if (b.type === 'image' && b.src) box.append(el('img', { class: 'mprev', alt: '', src: b.src.charAt(0) === '/' ? '..' + b.src : b.src, onerror: function () { this.hidden = true; } }));
    if (b.type === 'image') box.append(textInput(b, 'alt', 'תיאור התמונה (חובה, לקוראי מסך)', { long: true }), textInput(b, 'caption', 'כיתוב (לא חובה)'));
    else if (b.type === 'video') box.append(textInput(b, 'title', 'כותרת הסרטון'), textInput(b, 'caption', 'כיתוב (לא חובה)'));
    else if (b.type === 'audio') box.append(textInput(b, 'title', 'כותרת ההקלטה'));
    else box.append(textInput(b, 'title', 'שם המסמך'), textInput(b, 'desc', 'תיאור קצר (לא חובה)'));
    return box;
  }

  // ---- pending changes, publishing, history, activity log ----
  var PAGE_RX = /^data\/pages\/([\w-]+)\.json$/, SHUT_RX = /^data\/shut-edits\/([\w-]+)\.json$/;
  var STATUS = { added: 'חדש', modified: 'שונה', removed: 'נמחק' };
  var fmt = function (ts) { return new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }); };
  function pathInfo(path) {
    var m;
    if ((m = PAGE_RX.exec(path))) return { kind: 'page', label: 'דף', title: m[1], href: '#/page/' + m[1], id: m[1] };
    if ((m = SHUT_RX.exec(path))) return { kind: 'shut', label: 'שו״ת', title: '#' + m[1], href: '#/shut/' + m[1], id: m[1] };
    if (/^site\/media\//.test(path)) return { kind: 'media', label: 'קובץ', title: path.replace(/^site\/media\/[0-9a-f]{8}-/, ''), href: '#/media' };
    if (path === 'data/topics.json') return { kind: 'topics', label: 'נושאים', title: 'רשימת הנושאים', href: '#/pages' };
    var name = path.replace(/^data\//, '');
    return { kind: 'file', label: 'תוכן', title: FILE[name] ? FILE[name].name : name, href: '#/file/' + name };
  }
  function readJson(path, published) {
    return api('contents/' + path + (published ? '?src=published' : ref())).then(function (f) { return JSON.parse(b64d(f.content)); }, function (e) { if (e.status === 404) return null; throw e; });
  }
  // What a pending change is, in words: a page by its title, topics by what was added, removed or changed, and so on.
  function describe(item) {
    var info = pathInfo(item.path), gone = item.status === 'removed';
    if (item.media) return Promise.resolve({ title: item.title || info.title, detail: (MEDIA_KINDS[item.kind] || [''])[0] + ' · ' + mbytes(item.size) });
    if (info.kind === 'topics') {
      return Promise.all([readJson(item.path, true), gone ? null : readJson(item.path)]).then(function (r) {
        var before = r[0] || [], after = r[1] || [], by = function (xs) { var o = {}; xs.forEach(function (t) { o[t.slug] = t; }); return o; }, a = by(after), b = by(before), out = [];
        after.forEach(function (t) { if (!b[t.slug]) out.push('נוסף ״' + t.title + '״'); else if (JSON.stringify(t) !== JSON.stringify(b[t.slug])) out.push('שונה ״' + t.title + '״'); });
        before.forEach(function (t) { if (!a[t.slug]) out.push('הוסר ״' + t.title + '״'); });
        return { title: info.title, detail: out.join(', '), data: after };
      });
    }
    return readJson(item.path, gone).then(function (d) {
      if (!d) return { title: info.title, detail: '' };
      if (info.kind === 'page') return { title: d.title || info.title, detail: d.topic ? 'בנושא ' + d.topic : '', data: d };
      if (info.kind === 'shut') return { title: d.deleted ? 'הסתרת שאלה ' + d.id : d.title || info.title, detail: d.deleted ? 'השאלה תוסתר מהאתר' : d.kind === 'letters' ? 'מכתב' : 'שו״ת', data: d };
      return { title: info.title, detail: '', data: d };
    }, function () { return { title: info.title, detail: '' }; });
  }
  // After a publish the site's own lists lag a minute or two: lay the published items over them meanwhile.
  function noteFor(item, d) {
    var info = pathInfo(item.path);
    if (info.kind === 'media') return;
    if (info.kind === 'page') { if (item.status === 'removed') note('pages', info.id, null); else if (d) note('pages', info.id, { slug: info.id, title: d.title, topic: d.topic, category: d.category || '' }); }
    if (info.kind === 'shut' && d) { if (d.deleted || item.status === 'removed') note('shut', String(info.id), null); else note('shut', String(info.id), { kind: d.kind, title: d.title, date: d.date || '' }); }
  }

  function changesScreen() {
    var m = main();
    m.append(head('שינויים ממתינים', publisher ? 'מה שנשמר כטיוטה ועוד לא באתר. בחרו מה לפרסם, ולחצו על ״פרסום״.' : 'מה שנשמר כטיוטה ועוד לא באתר. מי שמורשה לפרסם יראה את זה כאן ויפרסם.'));
    m.append(el('p', { id: 'pubstate', class: 'pubstate', hidden: true }));
    var box = el('div'); m.append(box); loading(box);
    var load = function () {
      wapi('GET', '/changes?check=1').then(function (j) {
        pending = { list: j.changes, at: Date.now() }; drawPend();
        box.textContent = '';
        showPub();
        if (!j.changes.length) { box.append(el('div', { class: 'empty card' }, el('p', { text: 'אין שינויים ממתינים. כל מה ששמרתם כבר באתר.' }))); return; }
        var rows = j.changes.map(function (c) { return { c: c, cb: el('input', { type: 'checkbox', 'aria-label': pathInfo(c.path).title }), title: el('b', { text: pathInfo(c.path).title }), detail: el('small', { class: 'help' }), d: null }; });
        rows.forEach(function (r) { r.cb.checked = preselect ? r.c.path === preselect : publisher; });
        preselect = null;
        var all = el('input', { type: 'checkbox', 'aria-label': 'בחירת הכול' }); all.checked = rows.every(function (r) { return r.cb.checked; });
        all.addEventListener('change', function () { rows.forEach(function (r) { r.cb.checked = all.checked; }); sync(); });
        var chosen = function () { return rows.filter(function (r) { return r.cb.checked; }); };
        var pubBtn = publisher ? el('button', { type: 'button', class: 'btn pri', id: 'dopub', onclick: function () { publishDialog(chosen(), load, rows); } }, 'פרסום הנבחרים…') : null;
        var disBtn = el('button', { type: 'button', class: 'btn ghost dng', id: 'dodiscard', onclick: function () {
          var ch = chosen(); if (!ch.length || !confirm('לבטל ' + ch.length + ' שינויים שנשמרו כטיוטה? האתר יישאר כמו שהוא.')) return;
          wapi('POST', '/discard', { paths: ch.map(function (r) { return r.c.path; }) }).then(function () { forget(); say('השינויים בוטלו.', 'ok'); load(); }, function (e) { say(e.message, 'bad'); });
        } }, 'ביטול הנבחרים');
        var sync = function () { var n = chosen().length; if (pubBtn) pubBtn.disabled = !n; disBtn.disabled = !n; all.checked = n === rows.length; };
        box.append(el('div', { class: 'card chgbar' }, el('label', { class: 'chk' }, all, 'בחירת הכול'), el('span', { class: 'grow' }), pubBtn, disBtn));
        var ul = el('ul', { class: 'chg card' });
        rows.forEach(function (r) {
          var c = r.c, info = pathInfo(c.path);
          r.cb.addEventListener('change', sync);
          ul.append(el('li', { class: c.conflict ? 'conflict' : '' }, r.cb,
            el('div', { class: 'grow' }, el('div', {}, el('span', { class: 'tag', text: info.label }), ' ', r.title, ' ', el('span', { class: 'tag st-' + c.status, text: STATUS[c.status] })), r.detail,
              el('small', { class: 'help', text: 'נערך על ידי ' + c.name + ' · ' + fmt(c.ts) }),
              c.conflict ? el('small', { class: 'warn', text: 'הקובץ הזה השתנה גם באתר מאז שהתחלתם לערוך אותו. בפרסום תתבקשו להחליט.' }) : null),
            c.status === 'removed' ? null : el('a', { class: 'btn ghost sm', href: info.href }, 'פתיחה')));
          describe(c).then(function (d) { r.d = d; r.title.textContent = d.title; r.detail.textContent = d.detail; }, function () { /* the path stays as the title */ });
        });
        box.append(ul);
        sync();
      }, function (e) { box.textContent = ''; say(e.message, 'bad'); });
    };
    load();
  }

  // "Publish?" with the full list of what goes out; a file changed on the site meanwhile must be confirmed on its own.
  function publishDialog(rows, reload, allRows) {
    // A page that uses a file waiting to be published takes the file along (the build would fail without it).
    var have = {}; rows.forEach(function (r) { have[r.c.path] = 1; });
    rows.slice().forEach(function (r) {
      JSON.stringify((r.d && r.d.data && r.d.data.blocks) || []).replace(/\/media\/([\w.-]+)/g, function (_, f) {
        var extra = (allRows || []).filter(function (x) { return x.c.path === 'site/media/' + f && !have[x.c.path]; })[0];
        if (extra) { have[extra.c.path] = 1; rows.push(extra); }
      });
    });
    if (!rows.length) return;
    var dlg = el('dialog', { class: 'dlg wide' }, el('h2', { text: 'פרסום לאתר' }));
    var note_ = el('input', { type: 'text', id: 'pubnote', maxlength: '40', placeholder: 'למשל: עדכון זמני התפילות' });
    var ul = el('ul', { class: 'chg plain' });
    rows.forEach(function (r) { ul.append(el('li', {}, el('span', { class: 'tag', text: pathInfo(r.c.path).label }), ' ', el('b', { text: r.title.textContent }), ' ', el('span', { class: 'tag st-' + r.c.status, text: STATUS[r.c.status] }), el('small', { class: 'help', text: ' · ' + r.c.name + ' · ' + fmt(r.c.ts) }))); });
    var err = el('p', { class: 'err', role: 'alert' }), force = [];
    var go = el('button', { type: 'button', class: 'btn pri', id: 'confirmpub' }, 'כן, לפרסם');
    var run = function () {
      err.textContent = ''; go.disabled = true; go.textContent = 'מפרסם…';
      wapi('POST', '/publish', { paths: rows.map(function (r) { return r.c.path; }), force: force, note: note_.value.trim() }).then(function (res) {
        dlg.close();
        rows.forEach(function (r) { noteFor(r.c, r.d && r.d.data); });
        forget();
        if (res.sha) { mine.push(res.sha); published(res.sha, null); } else say('השינויים כבר היו באתר.', 'ok');
        refreshPending(); reload();
      }, function (e) {
        go.disabled = false; go.textContent = 'כן, לפרסם';
        if (e.status === 409 && e.body && e.body.conflicts) {
          force = e.body.conflicts;
          err.textContent = 'הקבצים האלה שונו באתר החי מאז שהתחלתם לערוך אותם: ' + force.map(function (p) { return pathInfo(p).title; }).join(', ') + '. אם תמשיכו, השינוי שנעשה באתר יוחלף בגרסה שלכם (אפשר לשחזר אותו מהגרסאות הקודמות).';
          go.textContent = 'לפרסם בכל זאת';
        } else err.textContent = e.message;
      });
    };
    go.addEventListener('click', run);
    dlg.append(el('p', { text: rows.length + (rows.length === 1 ? ' שינוי יפורסם באתר:' : ' שינויים יפורסמו באתר:') }), ul,
      el('div', { class: 'fld' }, el('label', { for: 'pubnote', text: 'תיאור קצר (לא חובה, יירשם בהיסטוריה)' }), note_), err,
      el('p', { class: 'acts' }, go, el('button', { type: 'button', class: 'btn ghost', onclick: function () { dlg.close(); } }, 'ביטול')));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  }

  // Earlier versions of the open file: each publish is a version; bringing one back makes it a draft.
  function historyDialog(f) {
    var dlg = el('dialog', { class: 'dlg wide' }, el('h2', { text: 'גרסאות קודמות' }), el('p', { class: 'help', text: 'כל פרסום הוא גרסה. שחזור מחזיר את הגרסה כטיוטה, והאתר משתנה רק אחרי שתפרסמו.' }));
    var body = el('div'); dlg.append(body, el('p', { class: 'acts' }, el('button', { type: 'button', class: 'btn ghost', onclick: function () { dlg.close(); } }, 'סגירה')));
    loading(body);
    wapi('GET', '/history?path=' + encodeURIComponent(f.path)).then(function (j) {
      body.textContent = '';
      if (!j.history.length) { body.append(el('p', { class: 'help', text: 'עדיין אין גרסאות קודמות לקובץ הזה.' })); return; }
      var ul = el('ul', { class: 'chg plain' });
      j.history.forEach(function (h, i) {
        ul.append(el('li', {}, el('div', { class: 'grow' }, el('b', { text: fmt(h.date) }), i === 0 ? el('span', { class: 'tag', text: 'באתר עכשיו' }) : null, el('small', { class: 'help', text: h.name + (h.message ? ' · ' + h.message : '') })),
          i === 0 ? null : el('button', { type: 'button', class: 'btn ghost sm', onclick: function () {
            if (dirty()) return say('שמרו או בטלו את השינויים הנוכחיים לפני שחזור גרסה.', 'bad');
            if (!confirm('לשחזר את הגרסה מ־' + fmt(h.date) + ' כטיוטה?')) return;
            wapi('POST', '/restore', { path: f.path, sha: h.sha }).then(function () { dlg.close(); forget(); say('הגרסה שוחזרה כטיוטה. עוד לא באתר, ואפשר לפרסם אותה.', 'ok'); refreshPending(); route(true); }, function (e) { say(e.message, 'bad'); });
          } }, 'שחזור')));
      });
      body.append(ul);
    }, function (e) { body.textContent = ''; body.append(el('p', { class: 'err', text: e.message })); });
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  }

  var ACTIONS = { 'media-upload': 'העלאת קובץ', 'media-delete': 'מחיקת קובץ', login: 'התחברות', save: 'שמירת טיוטה', delete: 'מחיקה בטיוטה', publish: 'פרסום', 'publish-all': 'פרסום (סיכום)', discard: 'ביטול טיוטה', restore: 'שחזור גרסה', name: 'שינוי שם', 'editor-add': 'הוספת עורך', 'editor-update': 'עדכון עורך', 'editor-remove': 'הסרת עורך' };
  function logScreen() {
    var m = main();
    m.append(head('יומן פעילות', 'מי שמר, פרסם, ביטל או שחזר מה, ומתי.' + (owner ? '' : ' כתובות המייל מוצגות רק לבעלי האתר.')));
    var card = el('section', { class: 'card' }), ul = el('ul', { class: 'chg plain', id: 'logrows' }), more = el('button', { type: 'button', class: 'btn ghost', hidden: true }, 'טעינת עוד');
    card.append(ul, more); m.append(card); loading(ul);
    var last = 0;
    var load = function () {
      wapi('GET', '/log?limit=50' + (last ? '&before=' + last : '')).then(function (j) {
        var first = !last; if (first) ul.textContent = '';
        j.log.forEach(function (r) {
          last = r.id;
          var what = r.path ? pathInfo(r.path).label + ' ' + pathInfo(r.path).title : '';
          ul.append(el('li', {}, el('div', { class: 'grow' }, el('b', { text: (ACTIONS[r.action] || r.action) + (what ? ' · ' + what : '') }), el('small', { class: 'help', text: (r.summary ? r.summary + ' · ' : '') + (r.name || '') + (r.email ? ' (' + r.email + ')' : '') })), el('small', { class: 'help', text: fmt(r.ts) })));
        });
        if (first && !j.log.length) ul.append(el('li', { class: 'help', text: 'עדיין אין פעילות ביומן.' }));
        more.hidden = j.log.length < 50;
      }, function (e) { ul.textContent = ''; say(e.message, 'bad'); });
    };
    more.addEventListener('click', load);
    load();
  }

  // The name shown in the public history of the site's repository (never the email).
  function nameDialog() {
    var inp = el('input', { type: 'text', maxlength: '40', placeholder: 'למשל: יעקב כהן' }); inp.value = myName;
    dialog('איך לקרוא לכם?', [['שם תצוגה', inp, 'השם יופיע ביומן ובהיסטוריית הפרסומים של האתר, שהיא ציבורית. אל תכתבו כתובת מייל.']], 'שמירה', function () {
      var v = inp.value.trim(); if (!v) return 'כתבו שם';
      return wapi('PUT', '/me', { name: v }).then(function (j) { myName = j.name; $('#who').textContent = myName; say('השם נשמר.', 'ok'); });
    });
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
    else if ((m = /^#\/topic\/([a-z0-9-]+)$/.exec(h))) topicScreen(m[1]);
    else if (h === '#/pages') pagesScreen();
    else if (h === '#/media' && draft) mediaScreen();
    else if (h === '#/changes' && draft) changesScreen();
    else if (h === '#/log' && draft && publisher) logScreen();
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
  var pollOn = false, reminded = false;
  function enter(who) {
    draft = !!cfg.worker;
    // Through the editor server: ask who this is now (role and name can change between visits).
    var first = draft ? wapi('GET', '/me').then(function (j) { owner = !!j.owner; publisher = !!j.publisher; myName = j.name || ''; }) : Promise.resolve();
    return first.then(function () { return api(''); }).then(function (r) {
      if (!r.permissions || !r.permissions.push) throw new Error(cfg.worker ? 'לשרת העריכה אין הרשאת כתיבה למאגר' : 'למפתח אין הרשאת כתיבה למאגר');
      me = who || ''; document.body.classList.remove('out'); $('#login').hidden = true; $('#app').hidden = false; $('#out').hidden = false; $('#burger').hidden = false; $('#who').textContent = myName || who || cfg.repo;
      $('#rename').hidden = !draft; drawPend();
      if (draft && !pollOn) { pollOn = true; setInterval(refreshPending, 60000); }
      return Promise.all([topics().catch(function () { return null; }), refreshPending()]).then(function () {
        shell(); here = ''; route(true);
        if (draft && !myName) nameDialog();
        else if (draft && !reminded) {
          var oldest = pending.list.reduce(function (a, x) { return Math.min(a, x.created || a); }, Date.now());
          if (pending.list.length && Date.now() - oldest > OLD_DAYS * 86400000) { reminded = true; say('תזכורת: יש ' + pending.list.length + ' שינויים שממתינים לפרסום כבר ' + Math.floor((Date.now() - oldest) / 86400000) + ' ימים. הם מופיעים ב״שינויים ממתינים״.', 'bad'); }
        }
      });
    }).catch(function (e) { document.body.classList.add('out'); $('#login').hidden = false; $('#app').hidden = true; $('#lerr').textContent = e.message; if (cfg.worker) google(); });
  }
  function remember(v, persist) {
    try { localStorage.removeItem('cms-token'); sessionStorage.removeItem('cms-token'); if (v) (persist ? localStorage : sessionStorage).setItem('cms-token', JSON.stringify(v)); } catch { /* storage blocked: kept for this page only */ }
  }
  function saved() { try { return JSON.parse(localStorage.getItem('cms-token') || sessionStorage.getItem('cms-token') || 'null'); } catch { return null; } }
  function signout(why) {
    cur = null; remember(null); token = '';
    if (!why) return location.reload();
    document.body.classList.add('out'); $('#lerr').textContent = why; $('#login').hidden = false; $('#app').hidden = true; $('#out').hidden = true; $('#burger').hidden = true; $('#rename').hidden = true; $('#pend').hidden = true;
    if (cfg.worker) google();
  }
  // Google sign-in, with the page's own button: Google's library opens its sign-in popup and gives back a short-lived access
  // token for the account's email; the editor server checks it with Google (and that the email may edit), and returns a 12-hour session.
  // (Google's own ready-made button needs inline styles, which this page's content policy does not allow.)
  var gStarted = false, gAsk = null;
  function gBusy(on) { var b = $('#gsign'); b.disabled = !!on; $('#gtxt').textContent = on ? 'מתחבר…' : 'המשך עם Google'; }
  function google() {
    $('#gbox').hidden = false;
    if (gStarted) return;
    gStarted = true;
    $('#gsign').addEventListener('click', function () { $('#lerr').textContent = ''; if (gAsk) { gBusy(true); gAsk(); } });
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onerror = function () { $('#lerr').textContent = 'לא הצלחנו לטעון את ההתחברות של Google. בדקו את החיבור לאינטרנט ורעננו את הדף.'; };
    s.onload = function () {
      var client = window.google.accounts.oauth2.initTokenClient({
        client_id: cfg.googleClientId, scope: 'openid email',
        callback: function (resp) {
          if (!resp || resp.error || !resp.access_token) { gBusy(false); $('#lerr').textContent = 'ההתחברות עם Google לא הושלמה. נסו שוב.'; return; }
          fetch(cfg.worker.replace(/\/$/, '') + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: resp.access_token }) })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'ההתחברות נכשלה'); return j; }); })
            .then(function (j) { token = j.token; owner = !!j.owner; remember({ token: j.token, email: j.email, owner: owner }, $('#grem').checked); return enter(j.email); })
            .catch(function (e) { $('#lerr').textContent = e.message; })
            .then(function () { gBusy(false); });
        },
        // The popup was closed, or the browser blocked it: nothing to show for the first, a hint for the second.
        error_callback: function (err) { gBusy(false); if (err && err.type === 'popup_failed_to_open') $('#lerr').textContent = 'הדפדפן חסם את חלון ההתחברות. אפשרו חלונות קופצ׳ים לאתר הזה ונסו שוב.'; },
      });
      gAsk = function () { client.requestAccessToken({ prompt: 'select_account' }); };
      $('#gsign').disabled = false;
    };
    document.head.append(s);
  }
  fetch('config.json').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c;
    var st = saved();
    $('#out').addEventListener('click', function () { if (leave()) signout(); });
    $('#rename').addEventListener('click', nameDialog);
    $('#pend').addEventListener('click', function () { location.hash = '#/changes'; });
    if (c.autosaveSeconds) AUTO_MS = c.autosaveSeconds * 1000;
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
