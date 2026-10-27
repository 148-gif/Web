// Site editor: edits data/*.json (and creates topics and pages) straight in the GitHub repository with the user's own token.
// Every save is a commit to the publishing branch; the Pages workflow then tests, builds and publishes it.
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  function el(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) e.append(arguments[i]);
    return e;
  }

  var FILES = { 'site.json': 'הגדרות האתר ותוכן מוסתר', 'topics.json': 'נושאים חדשים (רשימה)', 'library.json': 'ספרייה', 'rabbi-nachman.json': 'רבי נחמן', 'uman.json': 'אומן', 'tikkun.json': 'התיקון הכללי', 'moharash.json': 'הצדיק מיבנאל', 'yeshiva.json': 'ישיבת בית מנחם', 'print.json': 'הדפסת אשר בנחל', 'yavniel.json': 'יבנאל', 'mikveh.json': 'מקווה מלכה', 'institutions.json': 'מוסדות הקהילה', 'kuntresim.json': 'קונטרסים', 'halacha.json': 'שו״ת הלכתי' };
  var LABELS = { title: 'כותרת', lead: 'פתיח', desc: 'תיאור (לחיפוש ולשיתוף)', text: 'טקסט', paragraphs: 'פסקאות', items: 'פריטים', q: 'שאלה', a: 'תשובה', by: 'מקור', url: 'קישור', name: 'שם', slug: 'מזהה', topic: 'נושא', blocks: 'תוכן הדף', icon: 'סמל', phone: 'טלפון', email: 'דוא״ל', address: 'כתובת', hours: 'שעות', intro: 'פתיח', summary: 'תקציר', faq: 'שאלות נפוצות', sources: 'מקורות', path: 'נתיב', why: 'סיבה', hidden: 'מוסתר מהגולשים', contact: 'פרטי קשר', whatsapp: 'וואטסאפ', subtitle: 'כותרת משנה', about: 'אודות', sub: 'כותרת משנה' };
  var BLOCKS = { text: ['טקסט', { type: 'text', title: '', paragraphs: [''] }], cards: ['כרטיסים', { type: 'cards', title: '', items: [{ title: '', text: '' }] }], faq: ['שאלות ותשובות', { type: 'faq', title: '', items: [{ q: '', a: '' }] }], quote: ['ציטוט', { type: 'quote', text: '', by: '' }], links: ['קישורים', { type: 'links', title: '', items: [{ title: '', url: 'https://' }] }] };
  var ICONS = ['book', 'books', 'crown', 'lyre', 'candle', 'flame', 'heart', 'star', 'users', 'letter', 'sparkle', 'home', 'mountain', 'drop', 'school', 'scale', 'pin', 'clock', 'chat'];

  var RESERVED = ['admin', 'shut', 'letters', 'library', 'halacha', 'rabbi-nachman', 'uman', 'tikkun-haklali', 'moharash', 'yeshiva', 'print', 'yavniel', 'mikveh-malka', 'institutions', 'search', 'about', 'contact', 'accessibility', 'privacy', 'offline', 'fonts', 'img', 'books', 'idx', 'zmanim'];
  var cfg, token, cur = null, dirty = false, rawBad = false;

  // ---- GitHub ----
  function api(path, opt) {
    opt = opt || {};
    return fetch('https://api.github.com/repos/' + cfg.repo + (path ? '/' + path : ''), Object.assign({}, opt, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })).then(function (r) {
      if (r.ok) return r.status === 204 ? null : r.json();
      return r.text().then(function (t) { var e = new Error(r.status === 401 ? 'המפתח לא תקין או שפג תוקפו' : r.status === 403 || r.status === 404 ? 'אין הרשאה, או שהקובץ לא קיים (' + r.status + ')' : r.status === 409 || r.status === 422 ? 'הקובץ השתנה בינתיים. טענו מחדש ונסו שוב (' + r.status + ')' : 'שגיאה ' + r.status + ': ' + t.slice(0, 150)); e.status = r.status; throw e; });
    });
  }
  function b64e(s) { var b = new TextEncoder().encode(s), r = ''; for (var i = 0; i < b.length; i += 0x8000) r += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(r); }
  function b64d(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), function (c) { return c.charCodeAt(0); })); }
  function getFile(path) { return api('contents/' + path + '?ref=' + encodeURIComponent(cfg.branch)).then(function (f) { var text = b64d(f.content); var m = /^\n?( +)"/m.exec(text); return { path: path, sha: f.sha, indent: m ? m[1].length : 2, data: JSON.parse(text) }; }); }
  function putFile(path, data, indent, sha, msg) {
    var body = { message: msg, content: b64e(JSON.stringify(data, null, indent) + '\n'), branch: cfg.branch };
    if (sha) body.sha = sha;
    return api('contents/' + path, { method: 'PUT', body: JSON.stringify(body) });
  }

  // ---- messages ----
  var tm;
  function say(t, bad) { var m = $('#msg'); m.textContent = t; m.className = 'toast' + (bad ? ' bad' : ''); m.hidden = false; clearTimeout(tm); tm = setTimeout(function () { m.hidden = true; }, bad ? 9000 : 5000); }
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  function leave() { return !dirty || confirm('יש שינויים שלא נשמרו. להמשיך בלי לשמור?'); }

  // ---- generic form over any JSON ----
  var isObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
  function blank(v) {
    if (typeof v === 'string') return '';
    if (typeof v === 'number') return 0;
    if (typeof v === 'boolean') return false;
    if (Array.isArray(v)) return v.length && typeof v[0] !== 'object' ? (v.length > 4 ? [''] : v.map(blank)) : [];
    if (isObj(v)) { var o = {}; Object.keys(v).forEach(function (k) { o[k] = blank(v[k]); }); return o; }
    return '';
  }
  function touch() { if (!dirty) { dirty = true; var d = $('.dirty'); if (d) d.hidden = false; } }
  function label(k) { return typeof k === 'number' ? 'שדה ' + (k + 1) : LABELS[k] || k; }
  function preview(v) {
    if (typeof v === 'string') return v;
    var first = Array.isArray(v) ? v : Object.keys(v || {}).map(function (k) { return v[k]; });
    for (var i = 0; i < first.length; i++) if (typeof first[i] === 'string' && first[i]) return first[i];
    return '';
  }
  function strField(parent, key, lab, as) {
    var v = parent[key] == null ? '' : String(parent[key]);
    var long = v.length > 70 || v.indexOf('\n') > -1 || as === 'paragraphs' || key === 'text' || key === 'a';
    var id = 'f' + Math.random().toString(36).slice(2);
    var inp = long ? el('textarea', { id: id, rows: Math.min(14, Math.max(2, Math.ceil(v.length / 60) + v.split('\n').length - 1)) }) : el('input', { id: id, type: 'text' });
    inp.value = v;
    if (/url$/i.test(String(key)) || key === 'email') inp.className = 'ltr';
    inp.addEventListener('input', function () { parent[key] = inp.value; touch(); });
    return el('div', { class: 'fld' }, lab ? el('label', { for: id, text: lab }) : null, inp);
  }
  function field(parent, key, lab, rerender) {
    var v = parent[key];
    if (Array.isArray(v)) return arrField(parent, key, lab, rerender);
    if (isObj(v)) return objField(v, lab, rerender);
    if (typeof v === 'boolean') { var cb = el('input', { type: 'checkbox' }); cb.checked = v; cb.addEventListener('change', function () { parent[key] = cb.checked; touch(); }); return el('div', { class: 'fld' }, el('label', { class: 'chk' }, cb, lab)); }
    if (typeof v === 'number') { var n = el('input', { type: 'number', step: 'any' }); n.value = v; n.addEventListener('input', function () { parent[key] = n.value === '' ? 0 : Number(n.value); touch(); }); return el('div', { class: 'fld' }, el('label', { text: lab }), n); }
    return strField(parent, key, lab);
  }
  function objField(o, lab, rerender) {
    var fs = el('fieldset', {}, lab ? el('legend', { text: lab }) : null);
    Object.keys(o).forEach(function (k) { fs.append(field(o, k, label(k), rerender)); });
    return fs;
  }
  function move(arr, i, d) { var j = i + d; if (j < 0 || j >= arr.length) return false; var t = arr[i]; arr[i] = arr[j]; arr[j] = t; return true; }
  function arrField(parent, key, lab, rerender) {
    var arr = parent[key], box = el('fieldset', {}, el('legend', { text: lab + ' (' + arr.length + ')' }));
    if (!arr.length && key !== 'blocks') {
      // Nothing to copy the shape from: edit as JSON.
      var ta = el('textarea', { class: 'raw', rows: 3 }); ta.value = '[]';
      ta.addEventListener('change', function () { try { var x = JSON.parse(ta.value); if (!Array.isArray(x)) throw 0; parent[key] = x; touch(); rerender(); } catch { say('JSON לא תקין', true); } });
      box.append(el('p', { class: 'hint', text: 'הרשימה ריקה, אז אין ממה ללמוד את המבנה. אפשר להדביק כאן JSON, או לערוך בלשונית "JSON".' }), ta);
      return box;
    }
    var simple = arr.every(function (x) { return typeof x !== 'object'; });
    arr.forEach(function (item, i) {
      var tools = el('span', { class: 'tools' },
        el('button', { type: 'button', class: 'sm', 'aria-label': 'הזזה למעלה', text: '↑', onclick: function (e) { e.preventDefault(); if (move(arr, i, -1)) { touch(); rerender(); } } }),
        el('button', { type: 'button', class: 'sm', 'aria-label': 'הזזה למטה', text: '↓', onclick: function (e) { e.preventDefault(); if (move(arr, i, 1)) { touch(); rerender(); } } }),
        el('button', { type: 'button', class: 'sm dng', 'aria-label': 'מחיקה', text: '✕', onclick: function (e) { e.preventDefault(); if (confirm('למחוק את הפריט?')) { arr.splice(i, 1); touch(); rerender(); } } }));
      if (simple) {
        box.append(el('div', { class: 'row' }, strField(arr, i, '', key), tools));
        return;
      }
      var t = (isObj(item) && BLOCKS[item.type] ? BLOCKS[item.type][0] + ': ' : '') + preview(item).slice(0, 60);
      var d = el('details', { class: 'it' }, el('summary', {}, el('span', { class: 'n', text: String(i + 1) + '.' }), el('span', { class: 't', text: t }), tools));
      if (arr.length <= 4) d.open = true;
      var bd = el('div', { class: 'bd' });
      if (isObj(item)) Object.keys(item).forEach(function (k) { bd.append(field(item, k, label(k), rerender)); });
      else if (Array.isArray(item)) item.forEach(function (_, j) { bd.append(field(item, j, label(j), rerender)); });
      d.append(bd);
      box.append(d);
    });
    var adds = el('div', { class: 'adds' });
    if (key === 'blocks') {
      Object.keys(BLOCKS).forEach(function (t) { adds.append(el('button', { type: 'button', text: '+ ' + BLOCKS[t][0], onclick: function () { arr.push(JSON.parse(JSON.stringify(BLOCKS[t][1]))); touch(); rerender(); } })); });
    } else {
      adds.append(el('button', { type: 'button', text: '+ הוספה', onclick: function () { arr.push(blank(arr[0])); touch(); rerender(); } }));
    }
    box.append(adds);
    return box;
  }

  // ---- screens ----
  function side(files, pages) {
    var s = $('#side'); s.textContent = '';
    s.append(el('button', { type: 'button', class: 'new', text: '+ נושא חדש', onclick: newTopic }), el('button', { type: 'button', class: 'new', text: '+ דף חדש', onclick: newPage }));
    s.append(el('h2', { text: 'דפים ונושאים שיצרתם' }));
    s.append(el('button', { type: 'button', 'data-p': 'data/topics.json', text: 'רשימת הנושאים', onclick: function () { open('data/topics.json'); } }));
    pages.forEach(function (n) { s.append(el('button', { type: 'button', 'data-p': 'data/pages/' + n, text: n.replace(/\.json$/, ''), onclick: function () { open('data/pages/' + n); } })); });
    s.append(el('h2', { text: 'תוכן האתר' }));
    files.forEach(function (n) { if (n !== 'topics.json') s.append(el('button', { type: 'button', 'data-p': 'data/' + n, text: FILES[n] || n, onclick: function () { open('data/' + n); } })); });
  }
  function load() {
    return Promise.all([api('contents/data?ref=' + encodeURIComponent(cfg.branch)), api('contents/data/pages?ref=' + encodeURIComponent(cfg.branch)).catch(function () { return []; })]).then(function (r) {
      var files = r[0].filter(function (f) { return f.type === 'file' && /\.json$/.test(f.name) && f.name !== 'shut.json'; }).map(function (f) { return f.name; });
      var pages = r[1].filter(function (f) { return /\.json$/.test(f.name); }).map(function (f) { return f.name; });
      side(files, pages);
    });
  }
  function open(path) {
    if (!leave()) return;
    dirty = false; rawBad = false;
    $('#ed').textContent = 'טוען…';
    getFile(path).then(function (f) { cur = f; show(); }, function (e) { $('#ed').textContent = ''; say(e.message, true); });
  }
  function show(raw) {
    if (rawBad) return say('ה־JSON לא תקין. תקנו אותו לפני המעבר לטופס.', true);
    var ed = $('#ed'), y = window.scrollY; ed.textContent = '';
    document.querySelectorAll('#side button').forEach(function (b) { b.classList.toggle('cur', b.getAttribute('data-p') === cur.path); });
    var isPage = /^data\/pages\//.test(cur.path);
    var name = cur.path.replace(/^data\//, '');
    var bar = el('div', { class: 'bar' }, el('h2', { text: isPage ? 'דף: ' + cur.data.title : FILES[name] || name }), el('span', { class: 'dirty', hidden: !dirty, text: '● יש שינויים שלא נשמרו' }));
    bar.append(el('button', { type: 'button', text: raw ? 'טופס' : 'JSON', onclick: function () { show(!raw); } }), el('button', { type: 'button', class: 'pri', text: 'שמירה ופרסום', onclick: save }));
    if (isPage) bar.append(el('button', { type: 'button', class: 'dng', text: 'מחיקת הדף', onclick: del }));
    ed.append(bar);
    if (isPage) {
      var t = cur.data.topic, slug = cur.path.replace(/^data\/pages\/|\.json$/g, '');
      ed.append(el('p', { class: 'hint' }, 'כתובת הדף: ', el('a', { href: '../' + t + '/' + slug + '/', target: '_blank', rel: 'noopener', class: 'ltr', text: '/' + t + '/' + slug + '/' }), ' (מופיע באתר כ־1–2 דקות אחרי השמירה)'));
    }
    if (raw) {
      var ta = el('textarea', { class: 'raw' }); ta.value = JSON.stringify(cur.data, null, 2);
      ta.addEventListener('input', function () { touch(); try { cur.data = JSON.parse(ta.value); rawBad = false; ta.setCustomValidity(''); } catch { rawBad = true; ta.setCustomValidity('JSON לא תקין'); } });
      ed.append(ta);
    } else {
      var wrap = el('div');
      var rerender = function () { var y2 = window.scrollY; wrap.textContent = ''; build(); window.scrollTo(0, y2); };
      var build = function () { var root = { d: cur.data }; wrap.append(field(root, 'd', '', rerender)); cur.data = root.d; };
      build();
      ed.append(wrap);
    }
    window.scrollTo(0, y);
  }
  function check(path, data) {
    if (/^data\/pages\//.test(path)) {
      if (!data.title) return 'חסרה כותרת לדף';
      if (!data.topic) return 'חסר נושא לדף';
      var bad = (data.blocks || []).filter(function (b) { return !BLOCKS[b.type]; });
      if (bad.length) return 'סוג תוכן לא מוכר: ' + bad[0].type;
    }
    if (path === 'data/topics.json') {
      if (!Array.isArray(data)) return 'רשימת הנושאים חייבת להיות רשימה';
      for (var i = 0; i < data.length; i++) { if (RESERVED.indexOf(data[i].slug) > -1) return 'המזהה "' + data[i].slug + '" תפוס על ידי חלק קיים באתר'; if (!/^[a-z0-9-]+$/.test(data[i].slug || '')) return 'מזהה נושא חייב להיות באותיות לועזיות קטנות, ספרות ומקף'; if (!data[i].title) return 'חסרה כותרת לנושא ' + data[i].slug; }
    }
    return '';
  }
  function save() {
    if (rawBad) return say('ה־JSON לא תקין, ולכן לא נשמר.', true);
    var err = check(cur.path, cur.data);
    if (err) return say(err, true);
    var f = cur, name = f.path.replace(/^data\//, '');
    // A page must point at an existing topic, and a topic still in use by a page cannot be removed: either would fail the build.
    var guard = /^data\/pages\//.test(f.path) ? getFile('data/topics.json').then(function (t) { if (!t.data.some(function (x) { return x.slug === f.data.topic; })) throw new Error('הנושא "' + f.data.topic + '" לא קיים ברשימת הנושאים'); })
      : f.path === 'data/topics.json' ? pageTopics().then(function (used) { var gone = used.filter(function (u) { return !f.data.some(function (x) { return x.slug === u; }); }); if (gone.length) throw new Error('יש דפים בנושא "' + gone[0] + '". מחקו או העבירו אותם לפני מחיקת הנושא.'); })
        : Promise.resolve();
    guard.then(function () { return putFile(f.path, f.data, f.indent, f.sha, 'עריכת תוכן: ' + name); }).then(function (r) { f.sha = r.content.sha; if (cur === f) { dirty = false; var d = $('.dirty'); if (d) d.hidden = true; } published(r.commit.sha); }, function (e) { say(e.message, true); });
  }
  function pageTopics() {
    return api('contents/data/pages?ref=' + encodeURIComponent(cfg.branch)).catch(function () { return []; }).then(function (fs) {
      return Promise.all(fs.filter(function (x) { return /\.json$/.test(x.name); }).map(function (x) { return getFile('data/pages/' + x.name).then(function (p) { return p.data.topic; }); }));
    });
  }
  // After a save: follow the publishing run, so the editor hears whether the site was actually updated.
  // Needs the token's Actions (read) permission; without it, only the save itself is reported.
  function published(sha) {
    say('נשמר. האתר מתעדכן, זה לוקח דקה או שתיים…');
    var tries = 0;
    (function poll() {
      if (++tries > 40) return;
      setTimeout(function () {
        api('actions/runs?head_sha=' + sha).then(function (r) {
          var run = (r.workflow_runs || [])[0];
          if (!run || run.status !== 'completed') return poll();
          if (run.conclusion === 'success') say('האתר עודכן.');
          else say('הפרסום נכשל, והאתר נשאר כמו שהיה. כנראה יש שגיאה בתוכן ששמרתם. פרטים: ' + run.html_url, true);
        }, function () { /* no Actions permission: nothing more to report */ });
      }, 10000);
    })();
  }
  function del() {
    if (!confirm('למחוק את הדף "' + cur.data.title + '" מהאתר?')) return;
    api('contents/' + cur.path, { method: 'DELETE', body: JSON.stringify({ message: 'מחיקת דף: ' + cur.path, sha: cur.sha, branch: cfg.branch }) }).then(function () { dirty = false; cur = null; $('#ed').textContent = 'הדף נמחק.'; say('הדף נמחק. האתר יתעדכן בעוד דקה או שתיים.'); return load(); }, function (e) { say(e.message, true); });
  }

  // ---- new topic / new page ----
  function dialog(title, fields, ok) {
    if (!leave()) return;
    var dlg = el('dialog', {}, el('h2', { text: title }));
    var form = el('form', { method: 'dialog' });
    fields.forEach(function (f) { form.append(el('label', { for: 'd-' + f.id, text: f.label }), f.node); f.node.id = 'd-' + f.id; if (f.hint) form.append(el('small', { class: 'hint', text: f.hint })); });
    var errp = el('p', { class: 'err', role: 'alert' });
    form.append(errp, el('p', {}, el('button', { type: 'submit', class: 'pri', text: 'יצירה' }), ' ', el('button', { type: 'button', text: 'ביטול', onclick: function () { dlg.close(); dlg.remove(); } })));
    form.addEventListener('submit', function (e) { e.preventDefault(); var r = ok(); if (typeof r === 'string') errp.textContent = r; else r.then(function () { dlg.close(); dlg.remove(); }, function (x) { errp.textContent = x.message; }); });
    dlg.addEventListener('close', function () { dlg.remove(); }); dlg.append(form); document.body.append(dlg); dlg.showModal();
  }
  var slugInput = function () { return el('input', { type: 'text', class: 'ltr', pattern: '[a-z0-9\\-]+', required: true, autocomplete: 'off' }); };
  function newTopic() {
    var slug = slugInput(), title = el('input', { type: 'text', required: true }), desc = el('textarea', { rows: 2 }), icon = el('select');
    ICONS.forEach(function (i) { icon.append(el('option', { value: i, text: i })); });
    dialog('נושא חדש', [{ id: 'title', label: 'שם הנושא (מופיע בתפריט)', node: title }, { id: 'slug', label: 'מזהה בכתובת (אותיות לועזיות קטנות, ספרות ומקף)', node: slug, hint: 'למשל parasha. יהיה חלק מהכתובת.' }, { id: 'desc', label: 'תיאור קצר', node: desc }, { id: 'icon', label: 'סמל', node: icon }], function () {
      var s = slug.value.trim();
      if (!/^[a-z0-9-]+$/.test(s)) return 'המזהה חייב להיות באותיות לועזיות קטנות, ספרות ומקף';
      return getFile('data/topics.json').then(function (f) {
        if (f.data.some(function (t) { return t.slug === s; })) throw new Error('כבר יש נושא עם המזהה הזה');
        f.data.push({ slug: s, title: title.value.trim(), desc: desc.value.trim(), icon: icon.value });
        return putFile('data/topics.json', f.data, 2, f.sha, 'נושא חדש: ' + title.value.trim());
      }).then(function () { say('הנושא נוצר. הוא יופיע בתפריט אחרי שתוסיפו לו דף.'); return load(); });
    });
  }
  function newPage() {
    getFile('data/topics.json').then(function (tf) {
      if (!tf.data.length) return say('אין עדיין נושאים. צרו קודם נושא.', true);
      var topic = el('select'); tf.data.forEach(function (t) { topic.append(el('option', { value: t.slug, text: t.title })); });
      var slug = slugInput(), title = el('input', { type: 'text', required: true });
      dialog('דף חדש', [{ id: 'topic', label: 'נושא', node: topic }, { id: 'title', label: 'כותרת הדף', node: title }, { id: 'slug', label: 'מזהה בכתובת (אותיות לועזיות קטנות, ספרות ומקף)', node: slug }], function () {
        var s = slug.value.trim();
        if (!/^[a-z0-9-]+$/.test(s)) return 'המזהה חייב להיות באותיות לועזיות קטנות, ספרות ומקף';
        var path = 'data/pages/' + s + '.json';
        return api('contents/' + path + '?ref=' + encodeURIComponent(cfg.branch)).then(function () { throw new Error('כבר יש דף עם המזהה הזה'); }, function (e) {
          if (e.status !== 404) throw e;
          var data = { topic: topic.value, title: title.value.trim(), lead: '', desc: '', blocks: [{ type: 'text', title: '', paragraphs: [''] }] };
          return putFile(path, data, 2, null, 'דף חדש: ' + data.title);
        }).then(function () { say('הדף נוצר.'); return load().then(function () { dirty = false; open(path); }); });
      });
    }, function (e) { say(e.message, true); });
  }

  // ---- start ----
  function enter() {
    api('').then(function (r) {
      if (!r.permissions || !r.permissions.push) throw new Error('למפתח אין הרשאת כתיבה למאגר');
      $('#login').hidden = true; $('#app').hidden = false; $('#out').hidden = false; $('#who').textContent = cfg.repo + ' · ' + cfg.branch;
      return load();
    }).catch(function (e) { $('#login').hidden = false; $('#app').hidden = true; $('#lerr').textContent = e.message; });
  }
  function saved() { try { return localStorage.getItem('cms-token') || sessionStorage.getItem('cms-token') || ''; } catch { return ''; } }
  fetch('config.json').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c; token = saved();
    $('#go').addEventListener('click', function () {
      token = $('#tok').value.trim(); if (!token) return;
      try { (($('#rem').checked) ? localStorage : sessionStorage).setItem('cms-token', token); } catch { /* storage blocked */ }
      $('#lerr').textContent = ''; enter();
    });
    $('#tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#go').click(); });
    $('#out').addEventListener('click', function () { if (!leave()) return; dirty = false; try { localStorage.removeItem('cms-token'); sessionStorage.removeItem('cms-token'); } catch { /* storage blocked */ } location.reload(); });
    if (token) enter();
  });
})();
