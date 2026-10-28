// Mobile menu, hide-on-scroll header, reading tools, campaign sticky CTA, search warm-up.
{
const me = new URL(document.currentScript.src);
// Saved preferences (text size, vowel marks, place in each book). Storage can be blocked (private browsing,
// site data turned off): then nothing is remembered and the page works as on a first visit.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};
const lastRead = (book) => { try { return JSON.parse(store.get(`book:${book}`)); } catch { return null; } };

// Start fetching the search index once someone shows intent to search, so results are instant:
// the titles when they head for the search page, the full text too when they focus a search box.
let warm = 0;
const warmSearch = (full) => {
  if (warm >= (full ? 2 : 1)) return; warm = full ? 2 : 1;
  const base = me.pathname.replace(/[^/]*$/, '');
  const idx = (f) => fetch(`${base}idx/${f}.json${me.search}`);
  idx('meta').then((r) => r.json()).then((d) => { for (let k = 0; k < d.n; k++) { idx(`t${k}`); if (full) idx(k); } }).catch(() => {});
};
document.querySelectorAll('input[name=q]').forEach((el) => el.addEventListener('focus', () => warmSearch(true), { once: true }));
document.querySelectorAll('a[href*="/search/"]').forEach((el) => ['pointerenter', 'touchstart', 'focus'].forEach((ev) => el.addEventListener(ev, () => warmSearch(false), { once: true, passive: true })));
const hdr = document.querySelector('.top'), btn = document.querySelector('.mbtn');
// Header dropdowns (desktop): click/Enter toggles, Escape or a click elsewhere closes.
const dds = [...document.querySelectorAll('.dd')];
const closeDd = (except) => dds.forEach((d) => { if (d !== except) { d.classList.remove('open'); d.querySelector('.ddb').setAttribute('aria-expanded', 'false'); } });
dds.forEach((d) => d.querySelector('.ddb').addEventListener('click', () => { const o = !d.classList.contains('open'); closeDd(d); d.classList.toggle('open', o); d.querySelector('.ddb').setAttribute('aria-expanded', String(o)); }));
document.addEventListener('click', (e) => { if (!e.target.closest('.dd')) closeDd(); });
document.addEventListener('keydown', (e) => { const d = document.querySelector('.dd.open'); if (e.key === 'Escape' && d) { closeDd(); d.querySelector('.ddb').focus(); } });
document.addEventListener('focusin', (e) => { if (!e.target.closest('.dd')) closeDd(); });
const setMenu = (open) => { hdr.classList.toggle('open', open); btn.setAttribute('aria-expanded', open); document.body.classList.toggle('menu-open', open); };
btn.addEventListener('click', () => setMenu(!hdr.classList.contains('open')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && hdr.classList.contains('open')) { setMenu(false); btn.focus(); } });
document.addEventListener('click', (e) => { if (hdr.classList.contains('open') && !hdr.contains(e.target)) setMenu(false); });

let lastY = scrollY, tick = false;
const bar = document.querySelector('.readbar i'), sheet = document.querySelector('.sheet');
const onScroll = () => {
  tick = false;
  const y = scrollY;
  if (!hdr.classList.contains('open')) hdr.classList.toggle('hide', y > 160 && y > lastY + 4 ? true : y < lastY - 4 ? false : hdr.classList.contains('hide'));
  lastY = y;
  if (bar && sheet) { const r = sheet.getBoundingClientRect(); bar.style.transform = `scaleX(${Math.min(1, Math.max(0, -r.top / (r.height - innerHeight * 0.6)))})`; }
};
addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(onScroll); } }, { passive: true });

const root = document.documentElement;
document.querySelectorAll('[data-fs]').forEach((b) => b.addEventListener('click', () => {
  const cur = parseFloat(getComputedStyle(root).getPropertyValue('--rs')) || 1;
  const v = Math.min(1.5, Math.max(0.85, Math.round((cur + 0.1 * b.dataset.fs) * 100) / 100));
  root.style.setProperty('--rs', v);
  store.set('rs', v);
}));
// Share: the whole text, ready to paste. Phones get the system share sheet (WhatsApp, mail, SMS, Telegram...);
// elsewhere a small menu offers WhatsApp, email, copying the text, or copying the link.
const shareText = () => {
  const sheet = document.querySelector('.sheet');
  const head = [...document.querySelectorAll('.phead h1, .phead .csum')].map((e) => e.textContent.trim());
  // Book sections are titled "סעיף א": name the book too, so the text stands on its own.
  const book = document.querySelector('article[data-book]') && document.querySelectorAll('.phead .crumb a')[1];
  if (book) head[0] = `${book.textContent.trim()} · ${head[0]}`;
  const body = [];
  if (sheet) {
    const clone = sheet.cloneNode(true);
    clone.querySelectorAll('sup, .fnotes, .fnpop, .orn-rule, script').forEach((e) => e.remove());
    clone.querySelectorAll('h2, h3, p, li').forEach((e) => { const t = e.textContent.replace(/\s+/g, ' ').trim(); if (t) body.push(t); });
  }
  return `${head.join('\n')}\n\n${body.join('\n\n')}\n\nמתוך ״היכל הקודש״:\n${location.href}`;
};
const toast = (msg) => {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove('show'), 2600);
};
const copy = (txt, msg) => (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast(msg), () => toast('ההעתקה לא הצליחה. סמנו את הטקסט והעתיקו ידנית.'));
const shareMenu = (btn, full = shareText()) => {
  let m = btn.parentElement.querySelector('.sharemenu');
  if (m) { m.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
  const title = document.querySelector('h1').textContent.trim(), short = `${title}\n${location.href}`;
  // Very long URLs get cut by WhatsApp Web and mail programs: past this length the text is copied for pasting instead.
  const fits = encodeURIComponent(full).length < 6000;
  m = document.createElement('div'); m.className = 'sharemenu'; m.setAttribute('role', 'menu');
  const item = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = label; b.addEventListener('click', () => { fn(); m.remove(); btn.setAttribute('aria-expanded', 'false'); }); m.append(b); };
  item('וואטסאפ', () => { if (fits) open(`https://wa.me/?text=${encodeURIComponent(full)}`, '_blank', 'noopener'); else copy(full, 'הטקסט הועתק. הדביקו אותו בשיחה בוואטסאפ.').then(() => open('https://web.whatsapp.com/', '_blank', 'noopener')); });
  item('אימייל', () => { location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(fits ? full : `${short}\n\n(הטקסט המלא הועתק ללוח, אפשר להדביק כאן)`)}`; if (!fits) copy(full, 'הטקסט המלא הועתק. הדביקו אותו בגוף המייל.'); });
  item('העתקת הטקסט', () => copy(full, 'הטקסט הועתק, מוכן להדבקה.'));
  item('העתקת הקישור', () => copy(location.href, 'הקישור הועתק.'));
  btn.after(m); btn.setAttribute('aria-expanded', 'true'); m.querySelector('button').focus();
};
document.querySelectorAll('[data-share]').forEach((b) => {
  b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', () => {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: document.title, text: shareText() }).catch(() => {});
    else shareMenu(b);
  });
});
document.addEventListener('click', (e) => { const m = document.querySelector('.sharemenu'); if (m && !e.target.closest('.sharemenu, [data-share], .selshare')) { m.remove(); document.querySelector('[data-share][aria-expanded="true"]')?.setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', (e) => { const m = document.querySelector('.sharemenu'); if (e.key === 'Escape' && m) { const b = m.previousElementSibling; m.remove(); b?.setAttribute('aria-expanded', 'false'); b?.focus(); } });

// Share a selected passage: a small button appears next to a selection inside the text (below it on phones,
// where the system's own copy menu sits above). It shares the passage in quotes with its source and a link that
// scrolls to and highlights the passage in browsers that support text fragments. Copying is left untouched.
const readArea = document.querySelector('.sheet');
if (readArea && document.querySelector('[data-share]')) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  let bubble = null, quote = '', link = '', timer;
  const hide = () => { bubble?.remove(); bubble = null; };
  const fragment = (q) => {
    const enc = (t) => encodeURIComponent(t).replace(/-/g, '%2D');
    const w = q.split(/\s+/);
    return w.length <= 8 ? enc(q) : `${enc(w.slice(0, 4).join(' '))},${enc(w.slice(-4).join(' '))}`;
  };
  const passage = () => {
    const head = [...document.querySelectorAll('.phead h1')].map((e) => e.textContent.trim())[0] || document.title;
    const book = document.querySelector('article[data-book]') && document.querySelectorAll('.phead .crumb a')[1];
    return `״${quote}״\n\n— ${book ? `${book.textContent.trim()} · ` : ''}${head}\nמתוך ״היכל הקודש״:\n${link}`;
  };
  const show = () => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return hide();
    const range = sel.getRangeAt(0).cloneRange();
    if (!readArea.contains(range.commonAncestorContainer) || range.commonAncestorContainer.closest?.('.fnpop')) return hide();
    // Whole words only: a quote cut mid-word reads badly, and the highlight link can't find it.
    const letter = /[\p{L}\p{M}\p{N}"'״׳]/u;
    const { startContainer: sc, endContainer: ec } = range;
    if (sc.nodeType === 3) { let i = range.startOffset; while (i > 0 && letter.test(sc.data[i - 1])) i--; range.setStart(sc, i); }
    if (ec.nodeType === 3) { let i = range.endOffset; while (i < ec.data.length && letter.test(ec.data[i])) i++; range.setEnd(ec, i); }
    const frag = range.cloneContents();
    frag.querySelectorAll('sup, .fnpop').forEach((e) => e.remove());
    quote = frag.textContent.replace(/\s+/g, ' ').trim();
    if (quote.length < 12) return hide();
    link = `${location.origin}${location.pathname}#:~:text=${fragment(quote)}`;
    const r = range.getBoundingClientRect();
    if (!bubble) {
      bubble = document.createElement('div'); bubble.className = 'selshare';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
      b.textContent = 'שיתוף הקטע';
      b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
      // Keep the selection while the button is pressed.
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (navigator.share && coarse) navigator.share({ title: document.title, text: passage() }).catch(() => {});
        else shareMenu(b, passage());
      });
      bubble.append(b); document.body.append(bubble);
    }
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), document.documentElement.clientWidth - w - 8);
    const top = coarse || r.top < h + 72 ? r.bottom + 12 : r.top - h - 12;
    bubble.style.left = `${left + scrollX}px`; bubble.style.top = `${top + scrollY}px`;
  };
  document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(() => { if (!document.querySelector('.selshare .sharemenu')) show(); }, coarse ? 450 : 200); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bubble && !bubble.querySelector('.sharemenu')) hide(); });
}

// Google Maps directions without a starting point stall on a computer; there the button opens the place itself.
if (matchMedia('(hover: hover) and (pointer: fine)').matches) document.querySelectorAll('a[href*="google.com/maps/dir/"]').forEach((a) => {
  const to = new URL(a.href).searchParams.get('destination');
  if (to) a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(to)}`;
});

const stick = document.querySelector('.stickcta');
if (stick && 'IntersectionObserver' in window) {
  const seen = new Set();
  const io = new IntersectionObserver((es) => { es.forEach((e) => (e.isIntersecting ? seen.add(e.target) : seen.delete(e.target))); stick.classList.toggle('show', !seen.size); });
  document.querySelectorAll('.phero2 .btn, .phead .btn, .final .btn, #donate').forEach((el) => io.observe(el));
} else if (stick) stick.classList.add('show');

// Donation page: the payment iframe loads only when asked for, from its button or a tier card (#donate).
const donFrame = document.querySelector('.donframe[data-frame]');
if (donFrame) {
  const loadDonate = (focus) => {
    if (!donFrame.dataset.frame) return;
    const f = document.createElement('iframe');
    f.title = 'תרומה באשראי'; f.src = donFrame.dataset.frame; f.allow = 'payment'; f.referrerPolicy = 'no-referrer';
    delete donFrame.dataset.frame;
    donFrame.replaceChildren(f);
    if (focus) f.focus();
  };
  donFrame.querySelector('button').addEventListener('click', () => loadDonate(true));
  document.querySelectorAll('a[href="#donate"]').forEach((a) => a.addEventListener('click', () => loadDonate(false)));
}

// Book reader: hide/show vowel marks (remembered), and remember the last section read per book.
const sheetEl = document.querySelector('.book-sheet'), nikBtn = document.querySelector('[data-nikud]');
if (sheetEl && nikBtn) {
  const orig = new Map(), nodes = [];
  const walk = document.createTreeWalker(sheetEl, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) nodes.push(walk.currentNode);
  const setNik = (off) => {
    nodes.forEach((n) => { if (!orig.has(n)) orig.set(n, n.nodeValue); n.nodeValue = off ? orig.get(n).replace(/[֑-ׇ]/g, '') : orig.get(n); });
    nikBtn.setAttribute('aria-pressed', String(off)); nikBtn.textContent = off ? 'עם ניקוד' : 'בלי ניקוד';
  };
  let off = false;
  off = store.get('nikud') === '0';
  setNik(off);
  nikBtn.addEventListener('click', () => { off = !off; setNik(off); store.set('nikud', off ? '0' : '1'); });
}
const art = document.querySelector('article[data-book]');
if (art) store.set(`book:${art.dataset.book}`, JSON.stringify({ u: location.pathname, c: art.dataset.ch }));
document.querySelectorAll('[data-continue]').forEach((el) => {
  const v = lastRead(el.dataset.continue);
  if (!v || !v.u) return;
  const a = document.createElement('a'); a.className = 'btn'; a.href = v.u; a.textContent = `להמשיך מהמקום שעצרתם: ${v.c} ←`;
  el.append(a); el.hidden = false;
});

// Long pages: a section bar that sticks under the header once the in-page chips scroll away, marking the current section.
const anchorNav = document.querySelector('nav.anchors');
if (anchorNav && 'IntersectionObserver' in window) {
  const secbar = document.createElement('nav');
  secbar.className = 'secbar'; secbar.setAttribute('aria-label', 'פרקים בעמוד');
  const setH = () => root.style.setProperty('--hh', `${hdr.offsetHeight}px`); setH(); addEventListener('resize', setH);
  secbar.innerHTML = `<div class="sbin">${anchorNav.innerHTML}</div>`;
  document.body.append(secbar);
  const links = [...secbar.querySelectorAll('a')], secs = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
  new IntersectionObserver(([e]) => secbar.classList.toggle('show', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(anchorNav);
  const mark = () => {
    let cur = null;
    for (const s of secs) if (s.getBoundingClientRect().top < innerHeight * 0.35) cur = s;
    links.forEach((a) => { const on = cur && a.hash === `#${cur.id}`; a.classList.toggle('on', on); if (on && secbar.classList.contains('show')) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  };
  addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true });
}
// Back-to-top button after a screen and a half of scrolling.
const totop = document.querySelector('.totop');
if (totop) {
  totop.hidden = false;
  addEventListener('scroll', () => totop.classList.toggle('show', scrollY > innerHeight * 1.5), { passive: true });
  totop.addEventListener('click', () => { scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); hdr.classList.remove('hide'); });
}
// Prayer schedules: open on wide screens, folded on phones.
if (matchMedia('(min-width: 861px)').matches) document.querySelectorAll('details.scard').forEach((d) => { d.open = true; });
// Book contents: open the part that holds the last section read.
document.querySelectorAll('[data-continue]').forEach((el) => {
  const v = lastRead(el.dataset.continue);
  const a = v && v.u && document.querySelector(`details.tocpart a[href="${v.u}"]`);
  if (a) { a.closest('details').open = true; a.classList.add('last'); }
});

// Offline reading: the service worker keeps the pages already read (dist/sw.js, built from scripts/lib/sw.js). The offline page's "try again" reloads.
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register(`${me.pathname.replace(/[^/]*$/, '')}sw.js`).catch(() => {}));
document.querySelectorAll('[data-reload]').forEach((b) => b.addEventListener('click', () => location.reload()));

// Book footnotes: tapping a marker opens the note under its line instead of jumping to the list at the end.
let fnOpen = null;
const closeFn = (refocus) => { if (!fnOpen) return; const { pop, a } = fnOpen; pop.remove(); a.setAttribute('aria-expanded', 'false'); fnOpen = null; if (refocus) a.focus(); };
document.querySelectorAll('sup.fn a').forEach((a) => {
  const li = document.getElementById(decodeURIComponent(a.hash.slice(1)));
  if (!li) return;
  a.setAttribute('aria-expanded', 'false');
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const same = fnOpen && fnOpen.a === a;
    closeFn(false);
    if (same) return;
    const pop = document.createElement('div');
    pop.className = 'fnpop'; pop.tabIndex = -1; pop.setAttribute('role', 'note');
    const body = li.querySelector('span').cloneNode(true);
    body.querySelectorAll('a[href^="#fr-"]').forEach((x) => x.remove());
    pop.innerHTML = `<div class="fnh"><b>הערה ${a.textContent}</b><button type="button" class="fnx" aria-label="סגירת ההערה"><svg class="ico sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
    pop.append(body);
    const host = a.closest('.sheet') || a.closest('article'), hr = host.getBoundingClientRect(), mr = a.getBoundingClientRect();
    pop.style.top = `${mr.bottom - hr.top + 8}px`;
    host.append(pop);
    a.setAttribute('aria-expanded', 'true');
    fnOpen = { pop, a };
    pop.querySelector('.fnx').addEventListener('click', () => closeFn(true));
    pop.focus({ preventScroll: true });
    const r = pop.getBoundingClientRect();
    if (r.bottom > innerHeight) scrollBy({ top: Math.min(r.bottom - innerHeight + 16, r.top - 120), behavior: 'smooth' });
  });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFn(true); });
document.addEventListener('click', (e) => { if (fnOpen && !e.target.closest('.fnpop, sup.fn')) closeFn(false); });
}

// Filter on a topic's listing page (a collection made in the editor): hides the cards that do not match, and any section left empty.
document.querySelectorAll('[data-cfilter]').forEach((box) => {
  const cards = [...document.querySelectorAll('.libcat .card[data-t]')], none = document.querySelector('.cnone');
  box.addEventListener('input', () => {
    const words = box.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    cards.forEach((c) => { c.hidden = !words.every((w) => c.dataset.t.toLowerCase().includes(w)); });
    document.querySelectorAll('.libcat').forEach((s) => { s.hidden = !s.querySelector('.card:not([hidden])'); });
    if (none) none.hidden = cards.some((c) => !c.hidden);
  });
});
