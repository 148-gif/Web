// Small HTML and structured-data helpers shared by several sections.
import { BASE, ORIGIN, esc, url, tel, mo, rn } from './core.mjs';
import { icon, orn } from './layout.mjs';

const chips = ['אמונה', 'התבודדות', 'שמחה', 'תפילה', 'אומן', 'פרנסה', 'שלום בית'].map((t) => `<a href="/search/?q=${encodeURIComponent(t)}">${t}</a>`).join('');
const searchForm = `<label class="slabel" for="sq">חיפוש בשאלות ובתשובות</label><form action="/search/" class="hsearch" role="search"><input id="sq" name="q" type="search" placeholder="מה מעסיק אתכם?"><button>${icon('search', 'ico sm')}חיפוש</button></form>`;
const ul = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;
const ps = (xs) => xs.map((p) => `<p>${esc(p)}</p>`).join('');
// Navigation buttons. With exact coordinates (ll = "lat,lng") Waze opens its web map with the route and "send to phone"
// on a computer, and the app on a phone. Without them Waze only offers an app-store page on a computer, so its button
// is kept to touch devices (class "touch-only") until coordinates are added.
const navBtns = (q, ll = '', cls = '') => `<div class="navbtns${cls}"><a class="btn${ll ? '' : ' touch-only'}" href="${url(ll ? `https://www.waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes` : `https://www.waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`)}" rel="noopener">${icon('nav', 'ico sm')}ניווט ב־Waze</a><a class="btn${ll ? ' ghost' : ''}" href="${url(ll ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ll)}&travelmode=driving` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`)}" rel="noopener">${icon('pin', 'ico sm')}Google Maps</a></div>`;
const anchors = (xs) => `<nav class="chips anchors" aria-label="בעמוד זה">${xs.map(([h, t]) => `<a href="#${h}">${t}</a>`).join('')}</nav>`;
const ysect = (id, cls, title, sub, body, narrow = true) => `<section class="band${cls ? ' ' + cls : ''}" id="${id}"><div class="wrap${narrow ? ' narrow' : ''}"><h2 class="sh">${title}</h2>${sub ? `<p class="shsub">${sub}</p>` : orn}${body}</div></section>`;
// Prayer schedules fold into one row per prayer (opened by app.js on wide screens); the summary shows the time span.
const span = (rows) => { const ts = rows.map(([t]) => t).filter((t) => /^\d{1,2}:\d{2}$/.test(t)); return ts.length > 1 ? `${ts[0]}–${ts[ts.length - 1]}` : ts[0] || ''; };
const sched = (gs) => `<div class="sgrid">${gs.map((g) => `<details class="scard"><summary><h3>${esc(g.title)}</h3><span class="sspan">${rows(g.rows.length)}${span(g.rows) ? ` · <bdi>${span(g.rows)}</bdi>` : ''}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>${g.note ? `<p class="snote">${esc(g.note)}</p>` : ''}<dl>${g.rows.map(([t, p]) => `<div><dt>${esc(t)}</dt><dd>${esc(p)}</dd></div>`).join('')}</dl></details>`).join('')}</div>`;
const rows = (n) => (n === 1 ? 'מניין אחד' : `${n} מניינים`);
const hours = (rows) => `<dl class="hrs">${rows.map(([t, v]) => `<div><dt>${esc(t)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
const statrow = (xs) => `<div class="statrow"><div class="wrap">${xs.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}</div></div>`;
const telA = (n) => `<a href="tel:${tel(n)}">${esc(n)}</a>`;
// Structured data (JSON-LD) for search and AI engines
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const absu = (p) => (ORIGIN ? ORIGIN + BASE + p : undefined);
const crumbs = (xs) => ({ '@type': 'BreadcrumbList', itemListElement: xs.map(([n, p], i) => ({ '@type': 'ListItem', position: i + 1, name: n, ...(absu(p) ? { item: absu(p) } : {}) })) });
const faqLd = (xs) => ({ '@type': 'FAQPage', mainEntity: xs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
const faqHtml = (xs) => `<div class="faqs">${xs.map(([q, a], n) => `<details class="faq"${n ? '' : ' open'}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`;
const facts = (xs) => `<dl class="facts">${xs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
const srcList = (xs) => `<section class="band srcs"><div class="wrap narrow"><h2>מקורות</h2>${ul(xs.map(([t, u]) => `<a href="${url(u)}" rel="noopener">${esc(t)}</a>`))}</div></section>`;
const person = { '@type': 'Person', ...(absu('/moharash/') ? { '@id': absu('/moharash/') + '#person', url: absu('/moharash/') } : {}), name: 'רבי אליעזר שלמה שיק', alternateName: ['מוהרא״ש', 'מוהרא"ש', 'הצדיק מיבנאל', 'הצדיק מיבניאל', 'Rabbi Eliezer Shlomo Schick', 'Moharash'], birthDate: '1940-05-29', deathDate: '2015-02-06', birthPlace: { '@type': 'Place', name: 'תל אביב' }, deathPlace: { '@type': 'Place', name: 'ניו יורק' }, description: mo.lead, knowsAbout: ['חסידות ברסלב', 'רבי נחמן מברסלב'], sameAs: mo.sources.slice(0, 2).map(([, u]) => u) };
const tikkunUrl = '/tikkun-haklali/';
const rnPerson = { '@type': 'Person', ...(absu('/rabbi-nachman/') ? { '@id': absu('/rabbi-nachman/') + '#person', url: absu('/rabbi-nachman/') } : {}), name: 'רבי נחמן מברסלב', alternateName: ['רבינו', 'מוהר״ן', 'מוהר"ן', 'רבי נחמן מברסלב', 'Rebbe Nachman of Breslov', 'Nachman of Breslov'], birthDate: '1772', deathDate: '1810-10', birthPlace: { '@type': 'Place', name: 'מז׳יבוז׳' }, deathPlace: { '@type': 'Place', name: 'אומן' }, description: rn.short, knowsAbout: ['חסידות ברסלב', 'ליקוטי מוהר״ן'], sameAs: rn.sources.slice(0, 2).map(([, u]) => u) };

export { chips, searchForm, ul, ps, navBtns, anchors, ysect, span, sched, rows, hours, statrow, telA, ld, absu, crumbs, faqLd, faqHtml, facts, srcList, person, tikkunUrl, rnPerson };
