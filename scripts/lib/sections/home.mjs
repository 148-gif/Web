// Home
import { SITE, BUILD, esc, write, shut, pr } from '../core.mjs';
import { groups, icon, layout, card } from '../layout.mjs';
import { chips, searchForm, zstrip } from '../parts.mjs';

const tile = (href, ic, t, d) => `<a class="tile" href="${href}">${icon(ic, 'ico lg')}<b>${t}</b><span>${d}</span><i class="arr">${icon('arrow', 'ico sm')}</i></a>`;
write('index.html', layout(SITE, `${zstrip()}<script src="/zmanim.js?v=${BUILD}" defer></script><section class="band"><div class="wrap">${groups.map(([g, xs]) => `<section class="tgroup"><h2 class="tgh"><span>${g}</span></h2><div class="tiles n${xs.length}">${xs.map(([h, t, ic, d]) => tile(h, ic, t, d)).join('')}</div></section>`).join('')}
<a class="feature" href="/print/"><span class="fic">${icon('print', 'ico lg')}</span><span class="ftxt"><em>${esc(pr.hero.kicker)}</em><b>הדפסת ״אשר בנחל״</b><span>הצטרפו להדפסת ספרי הצדיק, והיו שותפים בכל עותק שמחזק עוד נפש.</span></span><span class="btn">להצטרפות ←</span></a></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq"><p>מצוה גדולה להיות בשמחה תמיד</p><cite>ליקוטי מוהר״ן תנינא, סימן כ״ד</cite></blockquote></div></section>
<section class="band soft"><div class="wrap"><h2 class="sh">מתוך השו״ת</h2><p class="shsub">שאלות שנשאלו ותשובות שנכתבו, מלב אל לב</p><div class="grid">${shut.slice(0, 6).map((x) => card(x)).join('')}</div><p class="ctarow"><a class="btn ghost" href="/shut/">לכל השאלות והתשובות ←</a></p></div></section>`,
{ path: '/', full: true, head: `<section class="phead hero"><div class="wrap"><span class="mark big">${icon('flame')}</span><p class="kicker2">${SITE} · חסידות ברסלב</p><h1>תשובות לנפש, בדרך ברסלב</h1><p class="sub">שאלות ותשובות בדרכו של רבינו הקדוש רבי נחמן מברסלב: אמונה, תפילה, התבודדות ושמחה.</p>${searchForm}<div class="chips">${chips}</div></div></section>` }));
