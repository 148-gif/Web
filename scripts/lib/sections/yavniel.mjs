// Yavniel and Malka mikveh pages, and the community institutions page.
import { esc, url, tel, write, institutions, yv, mk, BUILD } from '../core.mjs';
import { icon, orn, phead, layout, sr } from '../layout.mjs';
import { zstrip, ul, ps, navBtns, anchors, ysect, sched, hours, statrow, telA } from '../parts.mjs';


write('yavniel/index.html', layout('יבנאל', `${zstrip()}${statrow(yv.stats)}
${ysect('history', '', 'על היישוב', '', `<div class="about lead1">${ps(yv.intro)}</div>`)}
<section class="band soft" id="timeline"><div class="wrap narrow"><h2 class="sh">מסע בזמן</h2><p class="shsub">תחנות בתולדות המושבה</p><ol class="tline">${yv.timeline.map(([t, d]) => `<li><b>${esc(t)}</b><p>${esc(d)}</p></li>`).join('')}</ol><p class="tnote">${esc(yv.livelihood)}</p></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq"><p>${esc(yv.nachman)}</p><cite>${esc(yv.nachmanBy)}</cite></blockquote></div></section>
${ysect('community', '', 'קהילת ברסלב ביבנאל', '', `<div class="about">${ps(yv.community)}</div>`)}
<section class="band soft"><div class="wrap"><h2 class="sh">מוסדות וחסד</h2><p class="shsub">מה שהקים מוהרא״ש ביבנאל</p><ul class="inst-list">${yv.institutions.map(([n, d]) => `<li>${icon('school', 'ico')}<span><b>${esc(n)}</b>${d ? `<small>${esc(d)}</small>` : ''}</span></li>`).join('')}</ul><div class="svc">${yv.chesed.map(([ic, t, d]) => `<div class="card">${icon(ic, 'ico lg')}<h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
${ysect('city', '', esc(yv.cityTitle), '', `<div class="about">${ps(yv.city)}</div>${yv.quotes.map(([q, by]) => `<figure class="letterq"><blockquote>${esc(q)}</blockquote><figcaption>${esc(by)}</figcaption></figure>`).join('')}`)}
<section class="band soft" id="zion"><div class="wrap narrow"><h2 class="sh">ציון הצדיק</h2>${orn}<div class="about">${ps(yv.zion)}</div><p class="navbtns"><a class="btn" href="/moharash/tziyun/">${icon('flame', 'ico sm')}לדף ציון מוהרא״ש</a><a class="btn ghost" href="/moharash/">על הצדיק מיבנאל</a></p><div class="vow"><span class="kicker2">${esc(yv.promiseNote.replace(/:$/, ''))}</span><p>${esc(yv.promise)}</p></div></div></section>
<section class="band" id="letters"><div class="wrap"><h2 class="sh">${esc(yv.fromShutTitle)}</h2><p class="shsub">${esc(yv.fromShutLead)}</p><div class="grid notes">${yv.fromShut.map(([t, ids]) => `<div class="card"><p>${esc(t)}</p><span class="go">${ids.map((i, n) => `<a href="/shut/${i}/">${ids.length > 1 ? `תשובה ${'אבג'[n]}׳` : 'לתשובה'} ←</a>`).join('')}</span></div>`).join('')}</div></div></section>
<section class="band" id="zmanim" hidden><div class="wrap narrow"><h2 class="sh">זמני היום ביבנאל</h2><p class="shsub">לפי אופק יבנאל, בשעון ישראל</p>
<div class="zbox card"><div class="zhead"><button type="button" class="btn ghost zprev" aria-label="היום הקודם">${icon('arrow', 'ico sm')}</button><div class="ztitle"><b class="zday"></b><span class="zsub small"></span></div><button type="button" class="btn ghost znext" aria-label="היום הבא">${icon('arrow', 'ico sm')}</button></div>
<dl class="hrs zlist" aria-live="polite"></dl>
<div class="zfoot"><button type="button" class="btn ghost ztoday" hidden>חזרה להיום</button><label class="small">לתאריך אחר <input type="date" class="zpick"></label></div></div>
<p class="snote c">${esc(yv.zmanimNote)}</p></div></section>
<section class="band soft" id="prayer"><div class="wrap"><h2 class="sh">זמני תפילה</h2><p class="shsub">${esc(yv.prayerNote)}</p><h3 class="subh">${icon('clock', 'ico')}ימי חול</h3>${sched(yv.weekday)}<p class="snote c">${esc(yv.weekdayNote)}</p><h3 class="subh">${icon('flame', 'ico')}שבת קודש</h3>${sched(yv.shabbat)}<p class="snote c">${esc(yv.shabbatNote)}</p><p class="snote c zlnote" hidden>${esc(yv.liveNote)}</p></div></section>
<section class="band" id="lessons"><div class="wrap"><h2 class="sh">שיעורי תורה</h2><p class="shsub">שיעורים קבועים בבתי המדרש ובכוללים</p>${sched(yv.lessons)}<div class="card wide">${icon('users', 'ico lg')}<h3>אבות ובנים</h3><p>${esc(yv.fathers)}</p></div></div></section>
<section class="band soft" id="services"><div class="wrap"><h2 class="sh">מקוואות ושירותים</h2><p class="shsub">מה שכדאי לדעת לפני שמגיעים</p><div class="svc two">
<div class="card">${icon('drop', 'ico lg')}<h3>מקווה גברים</h3>${hours(yv.mikvehMen)}<p>${esc(yv.mikvehMenNote)}</p></div>
<a class="card hl" href="/mikveh-malka/">${icon('drop', 'ico lg')}<h3>מקווה נשים: מקווה מלכה</h3>${hours(yv.mikvehWomen)}<p>${esc(yv.mikvehWomenNote)}</p><span class="go">לדף המקווה, טלפונים וניווט ←</span></a>
<div class="card">${icon('meal', 'ico lg')}<h3>בית התבשיל ״אהל אברהם״</h3>${ps(yv.kitchen)}</div>
<div class="card">${icon('heart', 'ico lg')}<h3>ערב שמחה לנשים</h3><p>${esc(yv.womenEvening)}</p></div>
</div></div></section>
<section class="band final" id="visit"><div class="wrap narrow"><h2>מגיעים ליבנאל</h2><p>${esc(yv.directions)}</p>${navBtns(yv.navQuery, yv.navLL)}</div></section>
<script src="/zmanim.js?v=${BUILD}" defer></script>
<section class="band srcs"><div class="wrap narrow"><h2>מקורות</h2>${ul(yv.sources.map(([t, u]) => `<a href="${url(u)}" rel="noopener">${esc(t)}</a>`))}</div></section>`,
  { desc: 'יבנאל עיר ברסלב: תולדות המושבה, קהילת חסידי ברסלב, ציון מוהרא״ש, זמני תפילה, מקוואות ושיעורים', path: '/yavniel/', full: true, head: phead('הגליל התחתון · עיר ברסלב', 'יבנאל', esc(yv.lead), anchors([['history', 'היסטוריה'], ['community', 'הקהילה'], ['zion', 'הציון'], ['zmanim', 'זמני היום'], ['prayer', 'זמני תפילה'], ['services', 'מקוואות ושירותים'], ['visit', 'הגעה']])) }));

write('mikveh-malka/index.html', layout('מקווה מלכה', `<section class="band"><div class="wrap"><ul class="clist quick">
<li>${icon('phone', 'ico')}<span><b>טלפון במקווה</b>${telA(mk.phone)}</span></li>
<li>${icon('clock', 'ico')}<span><b>שעות פתיחה</b><a href="#hours">משקיעת החמה, בכל ערב</a></span></li>
<li>${icon('pin', 'ico')}<span><b>כתובת</b><a href="#visit">${esc(mk.address)}</a></span></li></ul>
<div class="wrap narrow about lead1 pad">${ps(mk.about)}</div>
<div class="feats">${mk.features.map(([ic, t, d]) => `<div>${icon(ic, 'ico lg')}<b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}</div></div></section>
<section class="band quoteband" id="promise"><div class="wrap"><p class="kicker2">${esc(mk.promiseTitle)}</p><blockquote class="pq small"><p>${esc(mk.promise)}</p><cite>מוהרא״ש זי״ע</cite></blockquote></div></section>
<section class="band"><div class="wrap"><h2 class="sh">ישועות</h2><p class="shsub">${esc(mk.promiseAfter)}</p><div class="svc tst">${mk.testimonials.map((t) => `<figure class="card"><span class="qm" aria-hidden="true">״</span><blockquote>${esc(t)}</blockquote></figure>`).join('')}</div></div></section>
${ysect('story', 'soft', esc(mk.storyTitle), '', `<div class="about">${ps(mk.story)}</div>`)}
<section class="band" id="answers"><div class="wrap narrow"><h2 class="sh">${esc(mk.fromShutTitle)}</h2><p class="shsub">${esc(mk.fromShutLead)}</p><div class="faqs">${mk.fromShut.map(([q, a, ids], n) => `<details class="faq"${n ? '' : ' open'}><summary>${esc(q)}</summary><p>${esc(a)}</p><p class="faqlinks">${ids.map((i, k) => `<a href="/shut/${i}/">${ids.length > 1 ? `תשובה ${'אבג'[k]}׳` : 'לתשובה המלאה'} ←</a>`).join('')}</p></details>`).join('')}</div></div></section>
<section class="band soft" id="hours"><div class="wrap narrow"><h2 class="sh">${esc(mk.hoursTitle)}</h2><p class="shsub">${esc(mk.hoursNote)}</p><div class="card">${hours(mk.hours)}</div><p class="snote c zlnote" hidden>${esc(yv.liveNote)}</p></div><script src="/zmanim.js?v=${BUILD}" defer></script></section>
<section class="band" id="contact"><div class="wrap narrow"><h2 class="sh">טלפונים</h2><p class="shsub">${esc(mk.phoneNote.replace(/:$/, ''))}</p><ul class="clist">
<li>${icon('phone', 'ico')}<span><b>טלפון במקווה</b>${telA(mk.phone)}</span></li>
${mk.attendants.map(([n, ts]) => `<li>${icon('users', 'ico')}<span><b>בלנית: ${esc(n)}</b>${ts.map(telA).join('<br>')}</span></li>`).join('')}</ul></div></section>
<section class="band final" id="visit"><div class="wrap narrow"><h2>הגעה למקווה</h2><p>${esc(mk.address)}</p>${navBtns(mk.navQuery, mk.navLL)}<p class="small"><a href="/yavniel/">← עוד על יבנאל: זמני תפילה, מקוואות ושירותים</a></p></div></section>
<div class="stickcta duo"><a class="btn" href="tel:${tel(mk.phone)}">${icon('phone', 'ico sm')}התקשרו</a><a class="btn ghost" href="#visit">${icon('nav', 'ico sm')}ניווט</a></div>`,
  { desc: 'מקווה מלכה ביבנאל: מקווה טהרה לנשים, הבטחת הצדיק מיבנאל, שעות פעילות, טלפונים וניווט', path: '/mikveh-malka/', full: true, head: phead('יבנאל · מקווה טהרה לנשים', 'מקווה מלכה', esc(mk.lead), `<div class="navbtns hcta"><a class="btn" href="tel:${tel(mk.phone)}">${icon('phone', 'ico sm')}התקשרו למקווה</a><a class="btn ghost light" href="#visit">${icon('nav', 'ico sm')}ניווט</a></div>`) }));

// Institutions
if (institutions.length) write('institutions/index.html', layout('מוסדות הקהילה', `${sr('המוסדות')}<div class="grid insts">${institutions.map((i) => `<div class="card inst">${icon('heart', 'ico')}<h3>${esc(i.name)}</h3><p>${esc(i.desc)}</p>${i.goal ? `<p class="goal">${esc(i.goal)}</p>` : ''}<p class="acts">${i.link ? `<a class="btn" href="${url(i.link)}" rel="noopener">לתרומה</a>` : ''}${i.phone ? ` <a class="btn ghost" href="tel:${tel(i.phone)}">${esc(i.phone)}</a>` : ''}</p></div>`).join('')}</div>`, { path: '/institutions/', head: phead('צדקה וחסד', 'מוסדות הקהילה', 'מוסדות תורה וחסד שזקוקים לתמיכתכם.') }));
