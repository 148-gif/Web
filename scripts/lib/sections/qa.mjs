// Q&A pages
import { PER_PAGE, esc, gist, write, shut, letters, halacha } from '../core.mjs';
import { icon, orn, phead, layout, sr, card } from '../layout.mjs';
import { searchForm } from '../parts.mjs';

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
  { desc: gist(x.a).slice(0, 155), path: base, self: `${base}${x.id}/`, reading: true, head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="${base}">${section}</a>${x.date ? ' · ' + esc(x.date) : ''}</p><h1>${esc(x.title)}</h1></div></section>` }));
});
readPages(shut, '/shut/', 'שו״ת ברסלב', ['השאלה הקודמת', 'השאלה הבאה', 'שאלות סמוכות']);
readPages(letters, '/letters/', 'מכתבים', ['המכתב הקודם', 'המכתב הבא', 'מכתבים סמוכים']);
readPages(halacha, '/halacha/', 'שו״ת הלכתי', ['השאלה הקודמת', 'השאלה הבאה', 'שאלות סמוכות']);

// Paginated list
const pages = Math.ceil(shut.length / PER_PAGE);
for (let p = 1; p <= pages; p++) {
  const items = shut.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const pager = `<nav class="pager" aria-label="עמודים">${p > 1 ? `<a class="btn ghost" href="${p === 2 ? '/shut/' : `/shut/page/${p - 1}/`}">→ הקודם</a>` : '<span></span>'}<span>עמוד ${p} מתוך ${pages}</span>${p < pages ? `<a class="btn ghost" href="/shut/page/${p + 1}/">הבא ←</a>` : '<span></span>'}</nav>`;
  write(p === 1 ? 'shut/index.html' : `shut/page/${p}/index.html`, layout('שו״ת ברסלב', `${sr('רשימת השאלות')}<div class="grid">${items.map((x) => card(x)).join('')}</div>${pager}`, { path: '/shut/', self: p === 1 ? '/shut/' : `/shut/page/${p}/`, head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות בעבודת ה׳, באמונה ובדרכו של רבינו הקדוש.`, searchForm) }));
}


// Halacha
write('halacha/index.html', layout('שו״ת הלכתי', `${halacha.length ? `${sr('רשימת השאלות')}<div class="grid">${halacha.map((x) => card(x, '/halacha/')).join('')}</div>` : `<div class="empty">${icon('scale', 'ico lg')}<h2>המדור בבנייה</h2><p>השאלות וההלכות יתווספו בקרוב.</p><p><a class="btn" href="/shut/">בינתיים, לשו״ת ברסלב</a></p></div>`}`, { path: '/halacha/', head: phead('הלכה למעשה', 'שו״ת הלכתי', 'שאלות ותשובות בהלכה, בבירור ובפשטות.') }));

// Letters
write('letters/index.html', layout('מכתבים', `${sr('רשימת המכתבים')}<div class="grid">${letters.map((x) => card(x, '/letters/')).join('')}</div>`, { path: '/letters/', head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'מכתבים', 'מכתבים כלליים לאנשי שלומנו: חיזוק, עצות ודרך בעבודת ה׳.') }));

export { pages };
