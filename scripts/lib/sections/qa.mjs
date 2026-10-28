// Q&A pages
import { PER_PAGE, esc, gist, write, shut, letters, halacha, linkAudit } from '../core.mjs';
import { relatedMap } from '../related.mjs';
import { icon, orn, phead, layout, sr, card } from '../layout.mjs';
import { searchForm, pagerHtml } from '../parts.mjs';

const para = (ps) => {
  // Short lines at the head of a letter (date, greeting) and at its end (blessing) are styled apart from the body.
  let i = 0, j = ps.length;
  while (i < Math.min(3, ps.length - 1) && ps[i].length < 50) i++;
  if (j - i > 1 && ps[j - 1].length < 60) j--;
  return [...ps.slice(0, i).map((p) => `<p class="opening">${esc(p)}</p>`), ...ps.slice(i, j).map((p) => `<p>${esc(p)}</p>`), ...ps.slice(j).map((p) => `<p class="closing">${esc(p)}</p>`)].join('');
};
// Some answers open with the same words (a quote, a greeting); their description then leads with the question's title, so each page's is unique.
const seenDesc = new Set();
const pageDesc = (x) => { let d = gist(x.a).slice(0, 155); if (seenDesc.has(d)) d = `${x.title}: ${gist(x.a)}`.slice(0, 155); seenDesc.add(d); return d; };
// One reading page per item; shared by shut, letters and halacha.
// Questions closest in wording to each question (related.mjs); related.count in data/link-audit.json sets how many, 0 turns it off.
const relCount = linkAudit.related?.count ?? 4;
const byId = new Map(shut.map((x) => [x.id, x]));
const noRelated = new Set((linkAudit.related?.exclude || []).map(String));
const related = relCount ? relatedMap(shut.filter((x) => !noRelated.has(String(x.id))), { count: relCount }) : new Map();
const relatedHtml = (x, base) => {
  const ids = base === '/shut/' ? related.get(x.id) || [] : [];
  return ids.length ? `<aside class="related" aria-labelledby="rel-h"><h2 id="rel-h">שאלות קשורות</h2><ul>${ids.map((id) => `<li><a href="${base}${id}/">${esc(byId.get(id).title)}</a></li>`).join('')}</ul></aside>` : '';
};
const readPages = (list, base, section, [prevL, nextL, navL]) => list.forEach((x, k) => {
  const prev = list[k - 1], next = list[k + 1];
  write(`${base.slice(1)}${x.id}/index.html`, layout(x.title, `<article class="qa"><div class="tools" role="group" aria-label="כלי קריאה"><span class="small">גודל טקסט</span><button type="button" class="tbtn" data-fs="-1" aria-label="הקטנת טקסט">א־</button><button type="button" class="tbtn big" data-fs="1" aria-label="הגדלת טקסט">א+</button><button type="button" class="tbtn share" data-share>${icon('share', 'ico sm')}שיתוף</button></div><div class="sheet">${x.q.length ? `<section class="q"><h2>השאלה</h2>${x.q.map((p) => `<p>${esc(p)}</p>`).join('')}</section>` : ''}
<section class="a">${x.q.length ? '<h2>התשובה</h2>' : ''}${para(x.a)}</section>${orn}</div>
${relatedHtml(x, base)}
<nav class="qnav" aria-label="${navL}">${prev ? `<a class="prev" href="${base}${prev.id}/"><small>→ ${prevL}</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${base}${next.id}/"><small>${nextL} ←</small>${esc(next.title)}</a>` : '<span></span>'}</nav></article>`,
  { desc: pageDesc(x), path: base, self: `${base}${x.id}/`, reading: true, head: `<section class="phead qhead"><div class="wrap"><p class="crumb"><a href="${base}">${section}</a>${x.date ? ' · ' + esc(x.date) : ''}</p><h1>${esc(x.title)}</h1></div></section>` }));
});
readPages(shut, '/shut/', 'שו״ת ברסלב', ['השאלה הקודמת', 'השאלה הבאה', 'שאלות סמוכות']);
readPages(letters, '/letters/', 'מכתבים', ['המכתב הקודם', 'המכתב הבא', 'מכתבים סמוכים']);
readPages(halacha, '/halacha/', 'שו״ת הלכתי', ['השאלה הקודמת', 'השאלה הבאה', 'שאלות סמוכות']);

// Paginated list
const pages = Math.ceil(shut.length / PER_PAGE);
// Each list page gets its own description (search engines flag duplicates): the first page describes the section, the rest name their questions.
const listDesc = (p, items) => (p === 1
  ? `${shut.length.toLocaleString('he-IL')} שאלות ותשובות שכתב מוהרא״ש, הצדיק מיבנאל, בעבודת ה׳: אמונה, תפילה, התבודדות, שמחה ושלום בית.`
  : `שו״ת ברסלב, עמוד ${p} מתוך ${pages}: ${items.slice(0, 3).map((x) => x.title).join(' · ')}`).slice(0, 155);
for (let p = 1; p <= pages; p++) {
  const items = shut.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const pager = pagerHtml(p, pages, (n) => (n === 1 ? '/shut/' : `/shut/page/${n}/`));
  write(p === 1 ? 'shut/index.html' : `shut/page/${p}/index.html`, layout('שו״ת ברסלב', `${sr('רשימת השאלות')}<div class="grid">${items.map((x) => card(x)).join('')}</div>${pager}`, { path: '/shut/', self: p === 1 ? '/shut/' : `/shut/page/${p}/`, desc: listDesc(p, items), head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות בעבודת ה׳, באמונה ובדרכו של רבינו הקדוש.`, searchForm) }));
}


// Halacha
write('halacha/index.html', layout('שו״ת הלכתי', `${halacha.length ? `${sr('רשימת השאלות')}<div class="grid">${halacha.map((x) => card(x, '/halacha/')).join('')}</div>` : `<div class="empty">${icon('scale', 'ico lg')}<h2>המדור בבנייה</h2><p>השאלות וההלכות יתווספו בקרוב.</p><p><a class="btn" href="/shut/">בינתיים, לשו״ת ברסלב</a></p></div>`}`, { path: '/halacha/', desc: 'שאלות ותשובות בהלכה למעשה, בבירור ובפשטות.', head: phead('הלכה למעשה', 'שו״ת הלכתי', 'שאלות ותשובות בהלכה, בבירור ובפשטות.') }));

// Letters
write('letters/index.html', layout('מכתבים', `${sr('רשימת המכתבים')}<div class="grid">${letters.map((x) => card(x, '/letters/')).join('')}</div>`, { path: '/letters/', head: phead('מכתבי הצדיק מיבניאל זצ״ל', 'מכתבים', 'מכתבים כלליים לאנשי שלומנו: חיזוק, עצות ודרך בעבודת ה׳.') }));

export { pages };
