// Zmanim of Yavne'el (Israel time) from zmanim/<sunday>.json, made by scripts/gen-zmanim.mjs. One small file per week is loaded:
// today's week, which always holds today, this Friday and Shabbat. Another week is fetched only when someone moves to it.
//  - the strip of today's sunrise, sunset and evening zman (.zstrip);
//  - the calculated time next to every prayer or mikveh time that is written relative to the sun (.zl, see parts.mjs);
//  - the daily zmanim box (#zmanim) with day-by-day navigation.
{
const me = new URL(document.currentScript.src);
const base = new URL('zmanim/', me);
const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const shift = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const dowOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const hm = (sec) => { const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
// A week missing (404) is outside the years we have and is expected; a server error or a broken response is reported.
const getJson = (name) => fetch(new URL(`${name}.json${me.search}`, base))
  .then((r) => { if (r.ok) return r.json(); if (r.status >= 500) throw new Error(`${r.status} ${r.url}`); return null; })
  .catch((e) => { window.reportFailure?.('זמני היום', e); return null; });
const weeks = {};   // a week's file is fetched once
const load = (key) => (weeks[shift(key, -dowOf(key))] ??= getJson(shift(key, -dowOf(key))));

(async () => {
  const today = dayKey(new Date()), dow = dowOf(today);
  const wk = await load(today);
  if (!wk) return;   // outside the years we have: the plain text stays
  const { cols } = wk, t = wk.days[today];
  // "fri" and "sat" are the coming Friday and Shabbat (the ones just past, when today is Shabbat); all in today's week.
  const dayOf = { today, fri: shift(today, dow <= 5 ? 5 - dow : -1), sat: shift(today, 6 - dow) };
  // A day is [Hebrew date, parasha, sunrise sec, sunset sec, ...one time per column].
  const col = (d, name) => d[4 + cols.indexOf(name)];
  const secOf = (spec) => {
    const [ref, off, day] = spec.split(':'), d = wk.days[dayOf[day]];
    if (!d) return null;
    // Sunrise and sunset in whole minutes, rounded down as the daily box shows them, so every time on the page agrees.
    const [h, m] = col(d, 'רבינו תם').split(':');
    const baseSec = ref === 'netz' ? Math.floor(d[2] / 60) * 60 : ref === 'shkia' ? Math.floor(d[3] / 60) * 60 : h * 3600 + m * 60;
    return baseSec + off * 60;
  };

  let live = 0;
  document.querySelectorAll('.zl').forEach((b) => {
    const s = b.dataset.z ? secOf(b.dataset.z) : undefined, e = b.dataset.ze ? secOf(b.dataset.ze) : undefined;
    if (s === null || e === null) return;
    b.textContent = s === undefined ? `עד ${hm(e)}` : e === undefined ? hm(s) : `${hm(s)}–${hm(e)}`;
    live++;
  });
  document.querySelectorAll('.zlnote').forEach((n) => { n.hidden = !live; });

  if (t) {
    const third = dow === 5 ? ['הדלקת נרות', col(t, 'הדלקת נרות')] : dow === 6 ? ['צאת השבת', col(t, 'צאת השבת')] : ['צאת הכוכבים', col(t, 'צאת הכוכבים')];
    const vals = { netz: hm(Math.floor(t[2] / 60) * 60), shkia: hm(Math.floor(t[3] / 60) * 60), thirdname: third[0], third: third[1] };
    document.querySelectorAll('.zstrip').forEach((z) => {
      z.querySelectorAll('[data-zv]').forEach((e) => { e.textContent = vals[e.dataset.zv]; if (e.tagName === 'B') e.dir = 'ltr'; });
      z.querySelector('.zc').hidden = dow !== 5; z.querySelector('.zs').hidden = dow === 5;
      z.querySelector('.zdate').textContent = [new Date(`${today}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'UTC' }), t[0], t[1], 'לפי אופק יבנאל'].filter(Boolean).join(' · ');
      z.hidden = false;
    });
  }

  const box = document.getElementById('zmanim');
  if (!box) return;
  const range = await getJson('index');
  if (!range) return;
  const { min, max } = range;
  let key = today, seq = 0;
  const title = box.querySelector('.zday'), sub = box.querySelector('.zsub'), list = box.querySelector('.zlist');
  const prev = box.querySelector('.zprev'), next = box.querySelector('.znext'), now = box.querySelector('.ztoday'), pick = box.querySelector('.zpick');
  pick.min = min; pick.max = max;
  const draw = async () => {
    const me2 = ++seq, w = await load(key);
    if (me2 !== seq) return;   // a newer click already moved on
    const d = w && w.days[key];
    if (!d) { list.replaceChildren(el('div', 'zmiss', 'אין נתונים לתאריך זה')); return; }
    const [heb, parasha, , , ...times] = d;
    title.textContent = heb;
    sub.textContent = [new Date(`${key}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }), parasha].filter(Boolean).join(' · ');
    list.replaceChildren(...w.cols.flatMap((c, i) => {
      if (!times[i]) return [];
      const row = el('div', ['הנץ החמה', 'שקיעת החמה', 'הדלקת נרות', 'צאת השבת'].includes(c) ? 'key' : ''), tm = el('bdi', '', times[i]);
      tm.dir = 'ltr';
      row.append(el('dt', '', c), el('dd')); row.lastChild.append(tm);
      return [row];
    }));
    prev.disabled = key <= min; next.disabled = key >= max; now.hidden = key === today;
    pick.value = key;
    load(shift(key, 7)); load(shift(key, -7));   // the neighbouring weeks, so the arrows stay instant
  };
  const go = (k) => { if (k >= min && k <= max) { key = k; draw(); } };
  prev.addEventListener('click', () => go(shift(key, -1)));
  next.addEventListener('click', () => go(shift(key, 1)));
  now.addEventListener('click', () => go(today));
  pick.addEventListener('change', () => pick.value && go(pick.value));
  await draw();
  box.hidden = false;
})();
}
