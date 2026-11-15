// "תוך הנחל": the talks of Moharash on Shabbat, written down afterwards and issued as leaflets (PDFs in site/books/kuntresim/,
// listed in data/kuntresim.json under the groups "tn-…"). This file sorts them by the weekly parasha and by year; the pages are
// built in scripts/lib/sections/library.mjs. Everything is read from the item's title ("תוך הנחל[ באנגלית], פרשת נח תשס״ה")
// and its slug (the year as a number, "toch-noach-5765"), so a new leaflet needs no other data.

// The places of the list, in the order of the Torah, by book. A parasha that is often read together with the next one
// (ויקהל־פקודי and the like) is one place, holding the leaflets of each one alone and of both together.
// `seq` is the order inside one year, from Rosh Hashana to the end of Elul (a holiday among the parashot of its season).
export const TOCH_BOOKS = [
  ['bereshit', 'ספר בראשית'], ['shemot', 'ספר שמות'], ['vayikra', 'ספר ויקרא'], ['bamidbar', 'ספר במדבר'], ['devarim', 'ספר דברים'], ['moadim', 'מועדים'],
];
const P = (id, book, title, names, seq) => ({ id, book, title, names: names || [title], seq });
export const TOCH_PLACES = [
  P('bereshit', 'bereshit', 'בראשית', 0, 10), P('noach', 'bereshit', 'נח', 0, 11), P('lech-lecha', 'bereshit', 'לך לך', 0, 12),
  P('vayera', 'bereshit', 'וירא', 0, 13), P('chayei-sara', 'bereshit', 'חיי שרה', 0, 14), P('toldot', 'bereshit', 'תולדות', 0, 15),
  P('vayetze', 'bereshit', 'ויצא', 0, 16), P('vayishlach', 'bereshit', 'וישלח', 0, 17), P('vayeshev', 'bereshit', 'וישב', 0, 18),
  P('miketz', 'bereshit', 'מקץ', 0, 20), P('vayigash', 'bereshit', 'ויגש', 0, 21), P('vayechi', 'bereshit', 'ויחי', 0, 22),
  P('shemot', 'shemot', 'שמות', 0, 23), P('vaera', 'shemot', 'וארא', 0, 24), P('bo', 'shemot', 'בא', 0, 25),
  P('beshalach', 'shemot', 'בשלח', 0, 26), P('yitro', 'shemot', 'יתרו', 0, 27), P('mishpatim', 'shemot', 'משפטים', 0, 28),
  P('teruma', 'shemot', 'תרומה', 0, 29), P('tetzave', 'shemot', 'תצוה', 0, 30), P('ki-tisa', 'shemot', 'כי תשא', 0, 31),
  P('vayakhel-pekudei', 'shemot', 'ויקהל־פקודי', ['ויקהל פקודי', 'ויקהל', 'פקודי'], 32),
  P('vayikra', 'vayikra', 'ויקרא', 0, 33), P('tzav', 'vayikra', 'צו', 0, 34), P('shmini', 'vayikra', 'שמיני', 0, 36),
  P('tazria-metzora', 'vayikra', 'תזריע־מצורע', ['תזריע מצורע', 'תזריע', 'מצורע'], 37),
  P('acharei-kedoshim', 'vayikra', 'אחרי מות־קדושים', ['אחרי קדושים', 'אחרי מות קדושים', 'אחרי', 'אחרי מות', 'קדושים'], 38),
  P('emor', 'vayikra', 'אמור', 0, 39), P('behar-bechukotai', 'vayikra', 'בהר־בחוקותי', ['בהר בחוקותי', 'בהר', 'בחוקותי'], 40),
  P('bamidbar', 'bamidbar', 'במדבר', 0, 41), P('naso', 'bamidbar', 'נשא', 0, 42), P('behaalotecha', 'bamidbar', 'בהעלותך', 0, 43),
  P('shelach', 'bamidbar', 'שלח לך', ['שלח לך', 'שלח'], 44), P('korach', 'bamidbar', 'קרח', 0, 45), P('chukat', 'bamidbar', 'חוקת', 0, 46),
  P('balak', 'bamidbar', 'בלק', 0, 47), P('pinchas', 'bamidbar', 'פנחס', 0, 48), P('matot-masei', 'bamidbar', 'מטות־מסעי', ['מטות מסעי', 'מטות', 'מסעי'], 49),
  P('devarim', 'devarim', 'דברים', 0, 50), P('vaetchanan', 'devarim', 'ואתחנן', 0, 51), P('ekev', 'devarim', 'עקב', 0, 52),
  P('ree', 'devarim', 'ראה', 0, 53), P('shoftim', 'devarim', 'שופטים', 0, 54), P('ki-tetze', 'devarim', 'כי תצא', 0, 55),
  P('ki-tavo', 'devarim', 'כי תבוא', 0, 56), P('nitzavim-vayelech', 'devarim', 'נצבים־וילך', ['נצבים וילך', 'נצבים', 'וילך'], 57),
  // Haazinu and Vezot Habracha are read after Rosh Hashana, at the start of the year their leaflet names
  P('haazinu', 'devarim', 'האזינו', 0, 2),
  P('vezot-habracha', 'devarim', 'וזאת הברכה, סוכות והילולת רבינו', ['וזאת הברכה-סוכות-הילולת רבינו ז״ל', 'הילולת רביז״ל / פרשת וזאת הברכה', 'וזאת הברכה'], 3),
  P('rosh-hashana', 'moadim', 'ראש השנה', 0, 1), P('chanuka', 'moadim', 'חנוכה', ['מעוז צור', 'חנוכה'], 19),
  P('pesach', 'moadim', 'פסח', ['שבת חול המועד פסח', 'שביעי של פסח', 'אחרון של פסח', 'פסח'], 35),
];
export const TOCH_LANGS = [['he', 'עברית'], ['en', 'אנגלית'], ['es', 'ספרדית'], ['yi', 'אידיש']];
const LANG_OF = { באנגלית: 'en', בספרדית: 'es', באידיש: 'yi' };
const placeOf = new Map(TOCH_PLACES.flatMap((p) => p.names.map((n) => [n, p])));

const GEM = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };
// "תשס״ה" -> 5765 (the thousands are left out in writing)
export const hebYear = (s) => 5000 + [...s].reduce((a, c) => a + (GEM[c] || 0), 0);

export const isToch =(k) => typeof k.group === 'string' && k.group.startsWith('tn-');

// One leaflet: its place, its year (5765 and "תשס״ה", or none), its language and, for a second leaflet of the same week, its number.
export function parseToch(k) {
  const m = k.title.match(/^תוך הנחל(?: (\S+))?, (?:פרשת )?(.+?)(?: (ת[א-ת]*[״"]?[א-ת]))?(?:\s*-?\s*(\d))?$/);
  if (!m) throw new Error(`kuntresim.json: "${k.slug}" is in "${k.group}" but its title "${k.title}" is not "תוך הנחל, פרשת <פרשה> <שנה>"`);
  const [, lw, name, yearHe, part] = m;
  if (lw && !LANG_OF[lw]) throw new Error(`kuntresim.json: "${k.slug}": unknown language "${lw}" (known: ${Object.keys(LANG_OF).join(', ')})`);
  const place = placeOf.get(name);
  if (!place) throw new Error(`kuntresim.json: "${k.slug}": unknown parasha or holiday "${name}" (add it to TOCH_PLACES in scripts/lib/toch.mjs)`);
  const ys = k.slug.match(/-(5\d{3})(?=-|$)/);
  if (yearHe && !ys) throw new Error(`kuntresim.json: "${k.slug}": the year ${yearHe} of the title must be in the slug as a number (…-5765)`);
  if (yearHe && hebYear(yearHe) !== Number(ys[1])) throw new Error(`kuntresim.json: "${k.slug}": the title says ${yearHe} (${hebYear(yearHe)}) but the slug says ${ys[1]}`);
  return { ...k, place: place.id, name, year: ys ? Number(ys[1]) : null, yearHe: yearHe ? yearHe.replace('"', '״') : '', lang: lw ? LANG_OF[lw] : 'he', part: part ? Number(part) : 1 };
}

// All the leaflets, sorted: a place in Torah order, a year by year (oldest first), Hebrew before the translations.
export function tochIndex(items) {
  const order = new Map(TOCH_PLACES.map((p, i) => [p.id, i])), seq = new Map(TOCH_PLACES.map((p) => [p.id, p.seq]));
  const langOrder = new Map(TOCH_LANGS.map(([l], i) => [l, i]));
  const all = items.filter(isToch).map(parseToch);
  const byYearThenPart = (a, b) => (a.year ?? 0) - (b.year ?? 0) || a.part - b.part || a.slug.localeCompare(b.slug);
  const places = TOCH_PLACES.map((p) => {
    const xs = all.filter((x) => x.place === p.id).sort((a, b) => langOrder.get(a.lang) - langOrder.get(b.lang) || byYearThenPart(a, b));
    return { ...p, items: xs, he: xs.filter((x) => x.lang === 'he'), tr: xs.filter((x) => x.lang !== 'he') };
  }).filter((p) => p.items.length);
  const years = [...new Set(all.map((x) => x.year).filter(Boolean))].sort((a, b) => a - b).map((year) => {
    const xs = all.filter((x) => x.year === year).sort((a, b) => seq.get(a.place) - seq.get(b.place) || order.get(a.place) - order.get(b.place) || langOrder.get(a.lang) - langOrder.get(b.lang) || a.part - b.part);
    return { year, label: xs[0].yearHe, items: xs, he: xs.filter((x) => x.lang === 'he'), tr: xs.filter((x) => x.lang !== 'he') };
  });
  return { all, places, years };
}
