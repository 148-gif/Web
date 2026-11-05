// Original admin UI. The full workspace lives in #/links; editors receive a page-scoped entry point.
import { seoFile, cleanPath, normalize, validateSeo, validateSeoSettings, shardFor } from './seo-model.mjs';
export function createSeoTools(ctx) {
  const e = ctx.el;
  let indexPromise, managerDirty = null;
  const dialogDirty = new Map();
  const hasUnsaved = () => !!(managerDirty && managerDirty()) || [...dialogDirty.values()].some((check) => check());
  const discardView = () => { managerDirty = null; for (const dlg of dialogDirty.keys()) dlg.close(); dialogDirty.clear(); };
  const action = (text, run, primary = false) => e('button', { type: 'button', class: 'btn ' + (primary ? 'pri' : 'ghost'), onclick: () => Promise.resolve().then(run).catch((x) => ctx.say(x.message, 'bad')) }, text);
  const input = (label, value, changed, multiline = false) => { const node = e(multiline ? 'textarea' : 'input', { type: multiline ? undefined : 'text', 'aria-label': label, rows: multiline ? '3' : undefined }); node.value = value || ''; node.addEventListener('input', () => changed(node.value)); return e('div', { class: 'fld' }, e('label', {}, label), node); };
  const select = (label, options, value, changed) => { const node = e('select', { 'aria-label': label }); for (const [v, title] of options) node.append(e('option', { value: v, text: title })); node.value = value || ''; node.addEventListener('change', () => changed(node.value)); return e('div', { class: 'fld' }, e('label', {}, label), node); };
  const toggle = (label, checked, changed) => { const box = e('input', { type: 'checkbox' }); box.checked = checked; box.addEventListener('change', () => changed(box.checked)); return e('label', { class: 'sw' }, box, e('span', { class: 'track', 'aria-hidden': 'true' }), e('span', { text: label })); };
  const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  async function index() { if (!indexPromise) indexPromise = ctx.json('seo/index.json').catch((x) => { indexPromise = null; throw x; }); return indexPromise; }
  async function environment() { return ctx.json('seo/environment.json'); }
  async function readRecord(path) { const file = seoFile(path); try { const f = await ctx.read(file); validateSeo(f.data, file); return f; } catch (x) { if (x.status !== 404) throw x; return { path: file, sha: null, data: { version: 1, path, indexing: 'inherit', aliases: [], keywords: [], links: [], related: [] } }; } }
  async function details(path) { const shard = await ctx.json('seo/' + shardFor(path) + '.json'); return shard[path] || { path, title: path, description: '', paragraphs: [], incoming: [], outgoing: [], suggestions: [], related: [], findings: [] }; }
  const list = (items, empty) => items.length ? e('div', { class: 'seo-list' }, items) : e('p', { class: 'help', text: empty });
  const siteLink = (path, title) => e('a', { href: '..' + path, target: '_blank', rel: 'noopener', text: title || path });
  function chooseTarget(label, rows, current, change) {
    const wrap = e('div', { class: 'seo-picker' }), hits = e('div'), search = e('input', { type: 'search', 'aria-label': label, placeholder: 'חיפוש עמוד לפי כותרת או כתובת' });
    const selected = e('p', { class: 'help ltr', text: current || 'לא נבחר יעד' });
    search.addEventListener('input', () => { const q = normalize(search.value.trim()); hits.textContent = ''; if (!q) return; for (const p of rows.filter((p) => normalize(p.title + ' ' + p.path).includes(q)).slice(0, 8)) hits.append(action(p.title + ' · ' + p.path, () => { change(p.path, p.title); selected.textContent = p.path; hits.textContent = ''; search.value = ''; })); });
    wrap.append(e('label', {}, label), selected, search, hits); return wrap;
  }
  function addRelated(cfg, p) { cfg.related = cfg.related || []; if (!cfg.related.some((x) => x.path === p.path)) cfg.related.push({ path: p.path, title: p.title.slice(0, 180) }); }
  async function openPage(path, options = {}) {
    ctx.assert(); if (!cleanPath(path)) throw new Error('כתובת העמוד אינה תקינה');
    const dlg = e('dialog', { class: 'dlg wide seo-dialog', 'aria-labelledby': 'seo-dialog-title', 'data-seo-dialog': '' }), body = e('div', { class: 'seo-dialog-body' }), error = e('p', { class: 'err', role: 'alert' });
    let f, cfg, original = '', busy = false;
    const dirty = () => !!cfg && JSON.stringify(cfg) !== original;
    dialogDirty.set(dlg, dirty);
    const close = () => { if (busy) return; if (!dirty() || confirm('יש הגדרות SEO שלא נשמרו. לסגור בלי לשמור?')) dlg.close(); };
    const beforeUnload = (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
    dlg.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    dlg.addEventListener('close', () => { window.removeEventListener('beforeunload', beforeUnload); dialogDirty.delete(dlg); dlg.remove(); });
    window.addEventListener('beforeunload', beforeUnload);
    dlg.append(e('header', { class: 'row' }, e('h2', { id: 'seo-dialog-title', class: 'grow', text: 'SEO וקישורים לפריט' }), action('סגירה', close)), e('p', { class: 'help ltr', text: path }), body, error);
    document.body.append(dlg); dlg.showModal(); body.append(e('p', { text: 'טוען את נתוני הפריט…' }));
    try {
      const [record, page, catalog, env] = await Promise.all([readRecord(path), details(path), index(), environment()]); ctx.assert(); if (!dlg.isConnected) return;
      f = record; cfg = structuredClone(f.data); original = JSON.stringify(cfg); if (options.redirectTo) cfg.redirectTo = options.redirectTo; body.textContent = '';
      if (options.title) page.title = options.title;
      if (options.paragraphs?.length && !page.paragraphs.length) page.paragraphs = options.paragraphs;
      const available = catalog.pages.filter((p) => p.path !== path && !p.redirectTo && !p.noindex), panes = e('div'), tabs = e('div', { class: 'seo-tabs', role: 'group', 'aria-label': 'הגדרות הפריט' });
      const groups = {};
      function tab(label, build) { const panel = e('section', { class: 'seo-pane', hidden: Object.keys(groups).length > 0 }); groups[label] = panel; const button = action(label, () => { for (const [name, group] of Object.entries(groups)) group.hidden = name !== label; for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button)); }); button.setAttribute('aria-pressed', String(Object.keys(groups).length === 1)); tabs.append(button); build(panel); panes.append(panel); }
      body.append(e('p', { class: 'note', text: env.staging ? 'האתר במצב בנייה: האינדוקס חסום ברמת הפריסה. ההעדפות כאן יכובדו לאחר פתיחת האתר לחיפוש.' : 'כשירות לאינדוקס היא הגדרת האתר; היא אינה אישור שהעמוד מופיע בפועל בגוגל.' }), tabs, panes);
      tab('SEO ואינדוקס', (panel) => {
        const preview = e('div', { class: 'seo-preview' });
        const drawPreview = () => { preview.textContent = ''; preview.append(e('small', { class: 'ltr', text: env.origin + (cfg.canonical || path) }), e('h3', { text: cfg.title || page.searchTitle || page.title }), e('p', { text: cfg.description || page.description || 'התיאור ייגזר מתוכן הפריט לאחר הפרסום.' })); };
        panel.append(input('כותרת לחיפוש ולשיתוף', cfg.title, (v) => { cfg.title = v; drawPreview(); }), input('תיאור לחיפוש ולשיתוף', cfg.description, (v) => { cfg.description = v; drawPreview(); }, true), preview,
          e('p', { class: 'help', text: 'שדות ריקים משתמשים בברירת המחדל של הפריט. התצוגה היא המחשה; מנוע החיפוש יכול לבחור נוסח אחר.' }),
          select('העדפת אינדוקס לפריט', [['inherit', 'לפי הגדרות האתר'], ['index', 'לאפשר אינדוקס'], ['noindex', 'למנוע אינדוקס']], cfg.indexing || 'inherit', (v) => { cfg.indexing = v; }),
          input('כתובת קנונית אחרת באתר — ריק לכתובת הפריט', cfg.canonical, (v) => { cfg.canonical = v.trim(); drawPreview(); }),
          input('תמונת שיתוף — נתיב קבוע בתוך האתר', cfg.image, (v) => { cfg.image = v.trim(); }),
          input('ביטויי נושא, מופרדים בפסיק', (cfg.keywords || []).join(', '), (v) => { cfg.keywords = csv(v); }),
          input('שמות נוספים לפריט, מופרדים בפסיק', (cfg.aliases || []).join(', '), (v) => { cfg.aliases = csv(v); })); drawPreview();
      });
      tab('קישורים לפריט', (panel) => {
        panel.append(e('h3', { text: 'קישורים נכנסים מתוך תוכן (' + (page.incomingTotal || 0) + ')' }), list((page.incoming || []).map((x) => e('div', { class: 'row' }, siteLink(x.from, x.title), e('small', { class: 'help', text: '«' + x.anchor + '»' + (x.related ? ' · תוכן קשור' : '') }))), 'לא נמצאו קישורים נכנסים מתוך תוכן.'), e('p', { class: 'help', text: 'קישורי ניווט ותפריטים: ' + (page.navigationIncoming || 0) + '. מוצגים עד 200 קישורי תוכן נכנסים.' }), e('h3', { text: 'קישורים יוצאים מתוך תוכן' }), list((page.outgoing || []).map((x) => e('div', { class: 'row' }, siteLink(x.to, x.anchor || x.to))), 'לא נמצאו קישורים יוצאים מתוך תוכן.'));
      });
      tab('המלצות וקישורים בטקסט', (panel) => {
        const approved = e('div'), suggestions = e('div');
        const draw = () => {
          approved.textContent = ''; suggestions.textContent = '';
          for (const [i, l] of (cfg.links || []).entries()) approved.append(e('div', { class: 'row' }, e('span', { class: 'grow', text: '«' + l.anchor + '» → ' + l.to }), action('הסרה מהטיוטה', () => { cfg.links.splice(i, 1); draw(); })));
          for (const [i, l] of (cfg.dismissed || []).entries()) approved.append(e('div', { class: 'row' }, e('span', { class: 'help grow', text: 'נדחה: «' + l.anchor + '» → ' + l.to }), action('החזרה לבדיקה', () => { cfg.dismissed.splice(i, 1); draw(); })));
          for (const s of page.suggestions || []) {
            if ((cfg.dismissed || []).some((x) => x.to === s.to && x.quote === s.quote && x.anchor === s.anchor)) continue;
            const exists = (cfg.links || []).some((x) => x.quote === s.quote && x.anchor === s.anchor && x.to === s.to);
            suggestions.append(e('section', { class: 'card' }, e('b', { text: s.anchor + ' → ' + s.to }), e('p', { class: 'help', text: s.reason }), e('blockquote', { text: s.quote }), exists ? e('p', { class: 'help', text: 'כבר נוסף להגדרות הפריט' }) : e('div', { class: 'acts' }, action('הוספת הקישור לטיוטה', () => { cfg.links = cfg.links || []; cfg.links.push({ quote: s.quote, anchor: s.anchor, to: s.to }); draw(); }), action('לא מתאים', () => { cfg.dismissed = cfg.dismissed || []; cfg.dismissed.push({ quote: s.quote, anchor: s.anchor, to: s.to }); draw(); }))));
          }
        };
        panel.append(e('p', { class: 'help', text: 'הקישורים נשמרים כסימונים נפרדים. אם קטע המקור השתנה או אינו חד-משמעי, הקישור לא יוכנס ותופיע הערה בדוח.' }), e('h3', { text: 'קישורים שהוגדרו לפריט' }), approved, e('h3', { text: 'הצעות לפי האתר שפורסם' }), suggestions);
        let quote = '', anchor = '', target = ''; const manual = e('details', { class: 'card sec' }, e('summary', { text: 'הוספת קישור ידני' }));
        manual.append(select('בחירת פסקה מהעמוד', [['', 'בחירת קטע מקור'], ...(page.paragraphs || []).map((p, i) => [String(i), p.slice(0, 110)])], '', (v) => { quote = v === '' ? '' : page.paragraphs[Number(v)]; }), input('המילים לקישור, בדיוק כפי שהן בפסקה', '', (v) => { anchor = v; }), chooseTarget('עמוד יעד', available, '', (v) => { target = v; }), action('הוספה לטיוטה', () => { const next = { ...cfg, links: [...(cfg.links || []), { quote, anchor, to: target }] }; validateSeo(next, f.path); cfg.links = next.links; draw(); })); panel.append(manual); draw();
      });
      tab('תוכן קשור', (panel) => {
        const chosen = e('div'); const draw = () => { chosen.textContent = ''; for (const [i, p] of (cfg.related || []).entries()) chosen.append(e('div', { class: 'row' }, e('span', { class: 'grow', text: p.title }), action('הסרה', () => { cfg.related.splice(i, 1); draw(); }))); };
        panel.append(toggle('לשמר גם את התוכן הקשור האוטומטי הקיים', cfg.relatedAuto !== false, (v) => { cfg.relatedAuto = v; }), e('h3', { text: 'בחירה ידנית — מוצגת ראשונה' }), chosen, chooseTarget('הוספת פריט קשור', available, '', (p, title) => { addRelated(cfg, { path: p, title }); draw(); }), e('h3', { text: 'המלצות מקומיות לפי התוכן' }));
        for (const r of page.related || []) panel.append(e('div', { class: 'row' }, e('span', { class: 'grow' }, e('b', { text: r.title }), e('small', { class: 'help', text: 'מילים משותפות: ' + r.terms.join(', ') })), action('קיבוע לפריט', () => { addRelated(cfg, { path: r.to, title: r.title }); draw(); }))); draw();
      });
      tab('הפניה ובדיקות', (panel) => { panel.append(e('p', { class: 'help', text: 'הפניה קבועה מעבירה את כתובת הפריט ליעד אחר לאחר פרסום. לולאות ויעדים חסרים נחסמים בבנייה.' }), input('יעד הפניה קבועה 301 — ריק ללא הפניה', cfg.redirectTo, (v) => { cfg.redirectTo = v.trim(); }), e('h3', { text: 'ממצאי הפרסום האחרון' }), list((page.findings || []).map((x) => e('p', { class: x.severity === 'error' ? 'err' : 'help', text: ctx.label(x.code) + ': ' + x.detail })), 'אין ממצאים לפריט בדוח האחרון.')); });
      body.append(e('p', { class: 'help', text: 'הגדרות SEO נשמרות כטיוטה נפרדת מתוכן הפריט. במסך הפרסום אפשר לפרסם את שתיהן יחד. הנתונים המחושבים מתעדכנים אחרי הפרסום.' }), e('div', { class: 'acts' }, action('שמירת SEO כטיוטה', async () => { if (busy) return; ctx.assert(); validateSeo(cfg, f.path); busy = true; error.textContent = 'שומר…'; try { const snapshot = JSON.stringify(cfg), r = await ctx.save(f.path, cfg, f.sha, 'הגדרות SEO: ' + path, path); ctx.assert(); f.sha = r.content.sha; original = snapshot; error.textContent = 'נשמר כטיוטה. האתר עדיין לא השתנה.'; } catch (x) { error.textContent = x.status === 409 ? 'ההגדרות שונו בינתיים. הטיוטה שלך נשארה פתוחה; סגרו ופתחו מחדש כדי לקרוא את הגרסה העדכנית.' : x.message; } finally { busy = false; } }, true), action('לשינויים הממתינים', () => { if (!dirty()) { dlg.close(); location.hash = '#/changes'; } else error.textContent = 'שמרו קודם את הגדרות ה-SEO.'; }), action('סגירה', close)));
      if (!ctx.writable()) for (const node of body.querySelectorAll('input,textarea,select,button')) node.disabled = true;
    } catch (x) { error.textContent = x.message; }
  }
  function inline(host, getOptions) {
    const card = e('section', { class: 'card' }, e('h3', { text: 'SEO וקישורים לפריט' }), e('p', { class: 'help', text: 'כותרת ותיאור לחיפוש, העדפת אינדוקס, קישורים ותוכן קשור.' }), action('ניהול SEO לפריט זה', () => { const opt = getOptions(); return openPage(opt.path, opt); }), e('a', { class: 'btn ghost wide', href: '#/links', text: 'למרכז קישורים ו-SEO' })); host.append(card);
  }
  async function manager(host, openAudit) {
    host.append(ctx.head('קישורים ו־SEO', 'ניהול האתר לפי עמודים, קשרים והגדרות — באמצעות מנוע מקומי.'));
    const loading = e('p', { text: 'טוען את מפת האתר…' }); host.append(loading);
    try {
      const [catalog, env] = await Promise.all([index(), environment()]); ctx.assert(); if (!loading.isConnected) return; loading.remove();
      host.append(e('p', { class: 'note', text: env.staging ? 'מצב בנייה: האתר חסום לאינדוקס ברמת הפריסה. אפשר להכין את הגדרות העמודים לעתיד בלי לפתוח אותו לחיפוש.' : 'הגדרות האינדוקס כאן מתארות כשירות לחיפוש, לא הופעה מאומתת בגוגל.' }), e('p', { class: 'help', text: catalog.pages.length.toLocaleString('he-IL') + ' עמודים · ' + catalog.stats.errors + ' שגיאות קישורים · ' + catalog.stats.warnings + ' אזהרות · ' + catalog.suggestions.length + ' הצעות לקישור בטקסט. הדוח מתאריך ' + new Date(catalog.generated).toLocaleString('he-IL') }), e('div', { class: 'acts' }, action('בדיקות מבנה והגדרות הבודק', openAudit), e('a', { class: 'btn ghost', href: '#/changes', text: 'שינויים ממתינים לפרסום' })));
      let activeSettings = null, settingsOriginal = '', view = 0;
      managerDirty = () => host.isConnected && !!activeSettings && JSON.stringify(activeSettings) !== settingsOriginal;
      const controls = e('div', { class: 'seo-tabs' }), body = e('div'); host.append(controls, body);
      function table() {
        view++; body.textContent = ''; let query = '', mode = 'all', page = 0; const rows = e('div'), count = e('p', { class: 'help' });
        const draw = () => { const filtered = catalog.pages.filter((p) => (!query || normalize(p.title + ' ' + p.path).includes(normalize(query))) && (mode === 'all' || mode === 'weak' && p.incoming === 0 || mode === 'noindex' && p.noindex || mode === 'issues' && p.issues || mode === 'configured' && p.configured)); const max = Math.max(0, Math.ceil(filtered.length / 40) - 1); page = Math.min(page, max); count.textContent = filtered.length + ' עמודים · עמוד ' + (page + 1) + ' מתוך ' + (max + 1); rows.textContent = ''; const tbody = e('tbody'); for (const p of filtered.slice(page * 40, page * 40 + 40)) tbody.append(e('tr', {}, e('td', {}, e('b', { text: p.title }), e('small', { class: 'help ltr', text: p.path })), e('td', { text: String(p.incoming) }), e('td', { text: String(p.outgoing) }), e('td', { text: p.redirectTo ? 'הפניה' : p.noindex ? 'noindex' : 'מותר לפי העמוד' }), e('td', { text: String(p.issues) }), e('td', {}, action('ניהול', () => openPage(p.path))))); rows.append(e('div', { class: 'seo-table-wrap' }, e('table', { class: 'seo-table' }, e('thead', {}, e('tr', {}, ...['פריט', 'נכנסים מתוכן', 'יוצאים מתוכן', 'אינדוקס', 'ממצאים', 'ניהול'].map((t) => e('th', { scope: 'col', text: t })))), tbody)), e('div', { class: 'acts' }, action('הקודם', () => { page = Math.max(0, page - 1); draw(); }), action('הבא', () => { page = Math.min(max, page + 1); draw(); }))); };
        body.append(input('חיפוש עמוד לפי כותרת או כתובת', '', (v) => { query = v; page = 0; draw(); }), select('סינון עמודים', [['all', 'כל העמודים'], ['weak', 'בלי קישור נכנס מתוכן'], ['noindex', 'מסומנים noindex'], ['issues', 'עם ממצאים'], ['configured', 'עם הגדרות SEO אישיות']], 'all', (v) => { mode = v; page = 0; draw(); }), count, rows); draw();
      }
      function recommendations() { view++; body.textContent = ''; body.append(e('p', { class: 'help', text: 'ההצעות מבוססות על ביטויים קיימים והקשר. פתיחת פריט מציגה גם המלצות לתוכן קשור לפי מילים משמעותיות משותפות.' }), list(catalog.suggestions.slice(0, 150).map((s) => e('section', { class: 'card' }, e('b', { text: s.anchor }), e('p', { class: 'help ltr', text: s.from + ' → ' + s.to }), e('p', { text: s.context }), e('p', { class: 'help', text: s.reason }), action('פתיחת הפריט ויישום', () => openPage(s.from)))), 'אין הצעות לקישורים בטקסט כרגע.')); if (catalog.suggestions.length > 150) body.append(e('p', { class: 'help', text: 'מוצגות 150 הצעות. יתר ההצעות נמצאות בפרטי כל עמוד.' })); }
      async function settings() {
        const ownView = ++view; body.textContent = ''; const f = await ctx.read('data/seo-settings.json').catch((x) => { if (x.status !== 404) throw x; return { path: 'data/seo-settings.json', sha: null, data: { version: 1, indexing: 'index', rules: [] } }; }); ctx.assert(); if (view !== ownView || !body.isConnected) return; const cfg = structuredClone(f.data); cfg.rules = cfg.rules || []; activeSettings = cfg; settingsOriginal = JSON.stringify(cfg);
        body.append(select('העדפת אינדוקס כללית', [['index', 'לאפשר אינדוקס לעמודים כשירים'], ['noindex', 'למנוע אינדוקס לכל האתר']], cfg.indexing || 'index', (v) => { cfg.indexing = v; }), e('p', { class: 'help', text: 'מצב הבנייה של הפריסה גובר על ההעדפה הזאת. כללי קישור אוטומטיים כבויים עד שמפעילים אותם במפורש. בכל עמוד מוחלים עד חמישה כללים, וכל יעד נוסף לכל היותר פעם אחת.' }));
        const rules = e('div'); const draw = () => { rules.textContent = ''; cfg.rules.forEach((r, i) => { rules.append(e('details', { class: 'card sec' }, e('summary', { text: r.anchor || 'כלל חדש' }), toggle('הכלל פעיל', !!r.enabled, (v) => { r.enabled = v; }), input('ביטוי לקישור', r.anchor, (v) => { r.anchor = v; }), chooseTarget('יעד הכלל', catalog.pages.filter((p) => !p.noindex && !p.redirectTo), r.to, (v) => { r.to = v; }), input('תחומי כתובות להכללה — פסיק, ריק לכל האתר', (r.include || []).join(', '), (v) => { r.include = csv(v); }), input('תחומי כתובות להחרגה — פסיק', (r.exclude || []).join(', '), (v) => { r.exclude = csv(v); }), input('מילים שצריכות להופיע בפסקה — לפחות אחת, פסיק', (r.requireAny || []).join(', '), (v) => { r.requireAny = csv(v); }), action('הסרת הכלל מהטיוטה', () => { cfg.rules.splice(i, 1); draw(); }))); }); };
        const error = e('p', { role: 'status', class: 'help' }); body.append(rules, e('div', { class: 'acts' }, action('הוספת כלל', () => { cfg.rules.push({ anchor: '', to: '', enabled: false, include: [], exclude: [], requireAny: [] }); draw(); }), action('שמירת הגדרות וכללים כטיוטה', async () => { validateSeoSettings(cfg); const snapshot = JSON.stringify(cfg); const r = await ctx.save(f.path, cfg, f.sha, 'הגדרות SEO וכללי קישור', '/'); f.sha = r.content.sha; settingsOriginal = snapshot; error.textContent = 'נשמר כטיוטה וממתין לפרסום.'; }, true)), error); draw();
      }
      function redirects() { view++; body.textContent = ''; let from = '', to = ''; body.append(e('p', { class: 'help', text: 'הפניות 301 נוצרות כחלק מהפרסום לשרת. אפשר לנהל הפניה גם בחלון של כל עמוד.' }), list(catalog.pages.filter((p) => p.redirectTo).map((p) => e('div', { class: 'row' }, e('span', { class: 'grow ltr', text: p.path + ' → ' + p.redirectTo }), action('עריכה', () => openPage(p.path)))), 'אין הפניות מוגדרות בדוח.'), input('כתובת ישנה בתוך האתר, למשל /old-page/', '', (v) => { from = v.trim(); }), chooseTarget('היעד החדש', catalog.pages.filter((p) => !p.redirectTo), '', (v) => { to = v; }), action('הכנת הפניה', () => { if (!cleanPath(from) || !to || from === to) throw new Error('בחרו כתובת מקור ויעד שונים ותקינים'); return openPage(from, { title: 'הפניה מ-' + from, redirectTo: to }); })); }
      for (const [label, run] of [['עמודים', table], ['המלצות', recommendations], ['הגדרות וכללים', settings], ['הפניות', redirects]]) controls.append(action(label, () => { if (activeSettings && JSON.stringify(activeSettings) !== settingsOriginal && !confirm('יש הגדרות וכללים שלא נשמרו. לצאת בלי לשמור?')) return; activeSettings = null; return run(); })); table();
    } catch (x) { loading.textContent = 'לא ניתן לקרוא את אינדקס ה-SEO: ' + x.message; }
  }
  return { inline, manager, openPage, hasUnsaved, discardView };
}
