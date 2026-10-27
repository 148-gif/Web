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
// the small titles file when they head for the search page, the full text too when they focus a search box.
let warm = 0;
const warmSearch = (full) => {
  if (warm >= (full ? 2 : 1)) return; warm = full ? 2 : 1;
  const base = me.pathname.replace(/[^/]*$/, '');
  fetch(`${base}idx/titles.json${me.search}`).then((r) => r.json()).then((d) => { if (full) for (let k = 0; k < d.n; k++) fetch(`${base}idx/${k}.json${me.search}`); }).catch(() => {});
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
document.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', () => {
  const title = document.querySelector('h1').textContent, url = location.href;
  if (navigator.share) navigator.share({ title, url }).catch(() => {});
  else open(`https://wa.me/?text=${encodeURIComponent(title + '\n' + url)}`, '_blank', 'noopener');
}));

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
