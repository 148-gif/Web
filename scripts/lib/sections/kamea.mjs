// The Tzaddik's amulet: a full content page (/kamea/) and a stripped-down landing page for campaigns (/lp/kamea/).
import { esc, url, tel, write, ka } from '../core.mjs';
import { icon, orn, phead, layout } from '../layout.mjs';
import { ps, ysect, faqHtml, faqLd, crumbs, ld, ul, anchors, statrow } from '../parts.mjs';

const LP = '/lp/kamea/', MAIN = '/kamea/';
const buy = (cls = 'btn', label = 'לקנייה מאובטחת באתר') => `<a class="${cls}" href="${url(ka.buyUrl, ['https:'])}" rel="noopener">${icon('check', 'ico sm')}${label}</a>`;
const call = (cls = 'btn', label = `להזמנה בטלפון: ${ka.phone}`) => `<a class="${cls}" href="tel:${tel(ka.phone)}">${icon('phone', 'ico sm')}${esc(label)}</a>`;
const amulet = `<div class="amulet" aria-hidden="true"><span class="amulet-ring"></span><span class="amulet-core">${icon('flame')}</span></div>`;
const story = ([by, text]) => `<figure class="card"><span class="qm" aria-hidden="true">״</span><blockquote>${esc(text)}</blockquote><figcaption>${esc(by)}</figcaption></figure>`;
const faqs = ka.faq;
const faqSchema = (xs) => ld({ '@context': 'https://schema.org', '@graph': [faqLd(xs)] });

// Full page
write('kamea/index.html', layout(ka.title, `${statrow(ka.stats)}
${ysect('about', '', 'מה זה הקמע?', '', `<div class="about lead1">${ps(ka.about)}</div><p class="navbtns kcta">${call()}${buy('btn ghost')}</p>`)}
<section class="band quoteband" id="promise"><div class="wrap"><p class="kicker2">${esc(ka.promiseTitle)}</p><blockquote class="pq"><p>${esc(ka.promise)}</p><cite>${esc(ka.promiseBy)}</cite></blockquote><p class="kam-note">${esc(ka.promiseNote)}</p></div></section>
<section class="band" id="how"><div class="wrap"><h2 class="sh">איך זה עובד</h2><p class="shsub">שלושה צעדים פשוטים</p><div class="feats three">${ka.how.map(([ic, t, d]) => `<div>${icon(ic, 'ico lg')}<b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}</div></div></section>
${ysect('carry', 'soft', esc(ka.carryTitle), '', `<div class="vow"><p>${esc(ka.carry)}</p></div>`)}
<section class="band" id="stories"><div class="wrap"><h2 class="sh">${esc(ka.storiesTitle)}</h2><p class="shsub">${esc(ka.storiesLead)}</p><div class="svc tst">${ka.stories.map(story).join('')}</div><p class="snote c">${esc(ka.storiesNote)}</p></div></section>
${ysect('origin', 'soft', esc(ka.originTitle), '', `<div class="about">${ps(ka.origin)}</div><p class="snote c">${esc(ka.originBy)}</p>`)}
<section class="band" id="charity"><div class="wrap"><div class="svc two"><div class="card hl">${icon('heart', 'ico lg')}<h3>${esc(ka.charityTitle)}</h3><p>${esc(ka.charity)}</p></div><div class="card">${icon('users', 'ico lg')}<h3>${esc(ka.soldiersTitle)}</h3><p>${esc(ka.soldiers)}</p></div></div></div></section>
${ysect('faq', 'soft', 'שאלות נפוצות', 'לפני שמזמינים', faqHtml(faqs))}
<section class="band final" id="order"><div class="wrap narrow"><h2>קחו לעצמכם ולמשפחתכם את הקמע</h2><p>${esc(ka.price)} בלבד. ${esc(ka.priceWhy)}, וכולו לצדקה.</p><div class="navbtns hcta">${call('btn big glow', `התקשרו עכשיו: ${ka.phone}`)}${buy('btn ghost light')}</div><p class="small"><a href="${LP}">${icon('arrow', 'ico sm')}לדף הזמנה מהיר</a> · <a href="/moharash/">על הצדיק מיבנאל</a> · <a href="/yavniel/">יבנאל עיר ברסלב</a></p></div></section>
<section class="band srcs"><div class="wrap narrow"><h2>${esc(ka.sourcesTitle)}</h2>${ul(ka.sources.map(([t, u]) => `<a href="${url(u, ['https:'])}" rel="noopener">${esc(t)}</a>`))}</div></section>
<div class="stickcta duo"><a class="btn" href="tel:${tel(ka.phone)}">${icon('phone', 'ico sm')}הזמינו</a><a class="btn ghost" href="#order">${icon('arrow', 'ico sm')}לפרטים</a></div>`,
  { desc: ka.desc, path: MAIN, full: true,
    head: phead(esc(ka.kicker), esc(ka.title), esc(ka.lead), `${amulet}<div class="navbtns hcta">${call('btn big glow', 'הזמינו עכשיו')}${buy('btn ghost light', 'לקנייה באתר')}</div>${anchors([['about', 'מה זה'], ['promise', 'ההבטחה'], ['stories', 'סיפורי ישועה'], ['origin', 'מקור'], ['faq', 'שאלות'], ['order', 'הזמנה']])}`),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [crumbs([['בית', '/'], ['הצדיק מיבנאל', '/moharash/'], [ka.title, MAIN]]), faqLd(faqs)] }) }));

// Landing page: one goal, no site menu, no sitemap entry; the page above and the menus lead to it.
const lp = ka.lp, lpFaq = lp.faq.map((i) => faqs[i]);
write('lp/kamea/index.html', layout(lp.title, `<section class="lp-hero"><div class="wrap">${amulet}<p class="kicker2">${esc(lp.kicker)}</p><h1>${esc(lp.headline)}</h1><p class="sub">${esc(lp.sub)}</p><div class="navbtns hcta">${call('btn big glow', 'הזמינו בטלפון')}${buy('btn ghost light', 'קנייה באתר')}</div><p class="lp-price"><b>${esc(ka.price)}</b> <span>${esc(ka.priceWhy)}</span></p></div></section>
<section class="band" id="why"><div class="wrap"><div class="feats three">${lp.bullets.map(([ic, t, d]) => `<div>${icon(ic, 'ico lg')}<b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}</div></div></section>
<section class="band quoteband"><div class="wrap"><blockquote class="pq small"><p>${esc(ka.promise)}</p><cite>${esc(ka.promiseBy)}</cite></blockquote></div></section>
<section class="band" id="steps"><div class="wrap narrow"><h2 class="sh">${esc(lp.stepsTitle)}</h2>${orn}<ol class="lp-steps">${lp.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div></section>
<section class="band soft" id="proof"><div class="wrap"><h2 class="sh">${esc(lp.storyTitle)}</h2><div class="svc tst two">${ka.stories.slice(0, 2).map(story).join('')}</div><p class="snote c">${esc(ka.storiesNote)}</p></div></section>
<section class="band" id="faq"><div class="wrap narrow"><h2 class="sh">שאלות נפוצות</h2>${faqHtml(lpFaq)}</div></section>
<section class="band final" id="order"><div class="wrap narrow"><h2>${esc(lp.ctaTitle)}</h2><p>${esc(lp.ctaSub)}</p><div class="navbtns hcta">${call('btn big glow', `התקשרו: ${ka.phone}`)}${buy('btn ghost light')}</div><p class="small"><a href="${MAIN}">${icon('arrow', 'ico sm')}עוד על הקמע, המקור והסיפורים</a></p></div></section>
<div class="stickcta duo"><a class="btn" href="tel:${tel(ka.phone)}">${icon('phone', 'ico sm')}הזמינו</a><a class="btn ghost" href="${url(ka.buyUrl, ['https:'])}" rel="noopener">${icon('check', 'ico sm')}קנייה באתר</a></div>`,
  { desc: lp.desc, path: LP, full: true, bare: true, index: false, head_extra: faqSchema(lpFaq) }));
