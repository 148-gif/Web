// Print campaign: Asher BaNachal
import { esc, url, tel, write, pr } from '../core.mjs';
import { org, sc, orgLine, contactList, layout, sr, icon } from '../layout.mjs';

const pd = pr.donate;
const h = pr.hero;
const money = (n) => Number(n).toLocaleString('he-IL');
const donateBox = () => pd.iframeUrl
  ? `<div class="donbox" id="donate"><h2 class="donhead">התרומה שלכם מתחילה כאן</h2><iframe title="תרומה באשראי" src="${url(pd.iframeUrl)}" loading="lazy" allow="payment" referrerpolicy="no-referrer" style="width:100%;height:900px;min-height:80vh"></iframe>${pd.fallbackUrl ? `<p class="ctarow"><a class="btn big" href="${url(pd.fallbackUrl)}" rel="noopener" target="_blank">פתחו את טופס התרומה במסך מלא</a></p>` : ''}</div>`
  : pd.fallbackUrl
    ? `<div class="donbox soon" id="donate"><p><a class="btn big" href="${url(pd.fallbackUrl)}" rel="noopener">לתרומה באשראי</a></p></div>`
    : `<div class="donbox soon" id="donate"><p>טופס התרומה באשראי יופעל בקרוב.</p>${pd.phone ? `<p><a href="tel:${tel(pd.phone)}">${esc(pd.phone)}</a></p>` : ''}</div>`;
const cta = (t = 'אני רוצה להצטרף להדפסה') => `<a class="btn big glow" href="/print/donate/">${t}</a>`;
const trust = `<ul class="trust">${pr.trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const g = pr.goal || {};
const goal = g.target ? `<div class="goal-bar"><div class="gb-top"><b>${esc(g.label || 'התקדמות ההדפסה')}</b><span>${money(g.raised)} מתוך ${money(g.target)} ₪</span></div><div class="gb-track"><i style="width:${Math.min(100, Math.round((g.raised / g.target) * 100))}%"></i></div></div>` : '';
const tierCards = (link) => `<div class="tiers2">${pr.tiers.map((t) => `<a class="tier2${t.tag ? ' pick' : ''}" href="${link}">${t.tag ? `<em>${esc(t.tag)}</em>` : ''}<b class="amt${t.amount ? '' : ' free'}">${t.amount ? money(t.amount) + ' ₪' : 'סכום חופשי'}</b><h3>${esc(t.name)}</h3><p>${esc(t.desc)}</p><span class="go">לתרומה ←</span></a>`).join('')}</div>`;
const stick = `<div class="stickcta"><a class="btn big glow" href="/print/donate/">להצטרף להדפסה</a></div>`;
const sect = (cls, inner) => `<section class="band ${cls}"><div class="wrap">${inner}</div></section>`;

const promiseBlock = `<blockquote class="pq"><p>${esc(pr.quote)}</p><cite>${esc(pr.quoteBy)}</cite></blockquote>`;

write('print/index.html', layout(pr.title, `<section class="phero2"><div class="wrap"><p class="kicker2">${esc(h.kicker)}</p><h1>${esc(h.headline)}</h1><p class="sub">${esc(h.sub)}</p><p class="ctarow">${cta()}</p>${trust}</div></section>
<section class="statrow"><div class="wrap">${pr.stats.map(([n, l]) => `<div><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('')}</div></section>
${sect('quoteband', promiseBlock + `<p class="ctarow"><a class="more" href="/print/promise/">לקריאה על ההבטחה ←</a></p>`)}
${sect('', `<h2 class="sh">מה זה ״אשר בנחל״</h2><div class="about">${pr.about.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`)}
${sect('soft', `<h2 class="sh">על מה מקדישים</h2><p class="shsub">לכל בקשה יש מקום בכרך. בחרו מה שעל ליבכם.</p><div class="needs">${pr.needs.map(([t, d2]) => `<div class="need">${icon('sparkle', 'ico orn')}<h3>${esc(t)}</h3><p>${esc(d2)}</p></div>`).join('')}</div>`)}
${sect('', `<h2 class="sh">בחרו את השותפות שלכם</h2><p class="shsub">כל סכום נחשב. כל סכום מחיה נפשות.</p>${goal}${tierCards('/print/donate/')}`)}
${sect('soft', `<h2 class="sh">שלושה צעדים פשוטים</h2><div class="steps2">${pr.steps.map(([t, d2], i) => `<div><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(d2)}</p></div>`).join('')}</div>`)}
${sect('final', `<h2>${esc(pr.finalCta.head)}</h2><p>${esc(pr.finalCta.sub)}</p><p class="ctarow">${cta('אני רוצה לתרום עכשיו')}</p>${trust}`)}
${sect('', `<h2 class="sh">שאלות נפוצות</h2>${pr.faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}`)}
${stick}`, { desc: h.sub, path: '/print/', full: true }));

write('print/promise/index.html', layout('ההבטחה והסגולה', `<section class="phero2 short"><div class="wrap"><p class="kicker2">ההבטחה</p><h1>מה הבטיח הצדיק</h1></div></section>
${sect('quoteband', promiseBlock)}
${sect('', `<div class="about promise">${pr.promiseText.map((p) => `<p>${esc(p)}</p>`).join('')}</div><p class="ctarow">${cta()}</p>${trust}`)}
${stick}`, { full: true, desc: 'ההבטחה בשם הצדיק מיבניאל זצ״ל למשתתפים בהדפסת אשר בנחל', path: '/print/', self: '/print/promise/' }));

write('print/donate/index.html', layout('תרומה להדפסת אשר בנחל', `<section class="phero2 short"><div class="wrap"><p class="kicker2">כמעט שם</p><h1>הצטרפו להדפסת אשר בנחל</h1><p class="sub">בחרו סכום, רשמו הקדשה, וסיימתם. התשלום מאובטח.</p>${trust}</div></section>
${sect('', `${sr('בחירת סכום')}${goal}${tierCards('#donate')}${donateBox()}<p class="small center">התרומה היא להדפסת ספרי הצדיק והפצתם. אין בה התחייבות לתוצאה מסוימת.</p>`)}
${sect('soft', `<div class="info narrow"><h2>פרטים חשובים לפני התרומה</h2>${orgLine ? `<p><b>מקבל התרומה:</b> ${orgLine}.</p>` : ''}<p><b>אבטחת התשלום:</b> התשלום מתבצע בטופס המאובטח של מערכת ״נדרים פלוס״. פרטי האשראי מוזנים ישירות אצלם, ואינם עוברים דרך האתר ואינם נשמרים בו.</p><p><b>קבלה:</b> ניתן לבקש קבלה בעת התרומה.${org.section46 ? ' התרומות מוכרות לזיכוי ממס לפי סעיף 46 לפקודת מס הכנסה.' : ''}</p><p><b>ביטול או טעות בחיוב:</b> תרומה שבוצעה בטעות, או חיוב כפול, יבוטלו לפי בקשה. ${contactList(sc).length ? 'פנו אלינו <a href="/contact/">בעמוד צור קשר</a> בהקדם ונטפל בפנייה.' : 'פנו בהקדם לשירות הלקוחות של ״נדרים פלוס״, שדרכה בוצע החיוב. פרטי הפנייה מופיעים בקבלה שנשלחה אליכם.'}</p><p><b>פרטיות:</b> פרטיכם משמשים לביצוע התרומה, להקדשה ולמשלוח קבלה בלבד. פרטים נוספים ב<a href="/privacy/">מדיניות הפרטיות</a>.</p></div>`)}`, { full: true, desc: 'תרומה באשראי להדפסת אשר בנחל', path: '/print/', self: '/print/donate/' }));
