// The rules for photos, as plain functions with no file access: the build (core.mjs) fails on them, and the editor can show the same
// messages while someone types. One source, so the site and the editor cannot disagree. Explanation of each rule: .claude/skills/images/SKILL.md
export const IMG_RIGHTS = ['approved', 'pending'];
// Who is in the photo besides the Rabbi: "none", "background" (far away, not recognisable), "adults" or "children".
// With adults or children the owner's approval must be written down in "consent".
export const IMG_OTHERS = ['none', 'background', 'adults', 'children'];
export const IMG_LIMITS = { minWidth: 800, alt: 125, caption: 220, gallery: 12, galleryPage: 48, dup: 8 };
// The sizes a photo is kept in: these widths up to its own, the largest being the whole photo, and two thumbnails cut 3:4 around the face.
export const IMG_WIDTHS = [480, 800, 1200, 1600], IMG_THUMBS = [360, 720];
export const imgWidths = (im) => [...IMG_WIDTHS.filter((w) => w < im.w), im.w];
export const photoFiles = (im) => [...imgWidths(im).map((w) => `${w}.webp`), ...IMG_THUMBS.filter((t) => t <= im.w).map((t) => `t${t}.webp`)];
// Largest file size, in bytes, by the photo's width in pixels (and for the 3:4 thumbnails).
export const IMG_BUDGET = { 480: 70e3, 800: 160e3, 1200: 260e3, 1600: 420e3, t360: 40e3, t720: 120e3 };
export const budgetFor = (name) => (name.startsWith('t') ? IMG_BUDGET[name.slice(0, -5)] : IMG_BUDGET[[480, 800, 1200, 1600].find((w) => Number(name.slice(0, -5)) <= w)]);

// "A photo of…" tells a screen reader what it already knows; the text should say what the photo adds.
const LEAD_IN = /^\s*(תמונה|תמונת|צילום|תצלום|image|photo|picture)(\s|$)/i;
const SIZES = ['full', 'side'];
const text = (v) => typeof v === 'string' && v.trim().length > 0;

// Problems with one registry entry, as sentences for the person who edits it. A photo that is not approved yet may be unfinished.
export const imageProblems = (im) => {
  const out = [];
  if (!/^[a-z0-9-]+$/.test(im.id || '')) out.push('המזהה (id) חייב להיות באנגלית קטנה, ספרות ומקפים בלבד');
  if (!Number.isInteger(im.w) || !Number.isInteger(im.h) || im.w < 1 || im.h < 1) out.push('הרוחב והגובה חייבים להיות מספרים שלמים');
  else if (im.w < IMG_LIMITS.minWidth) out.push(`התמונה צרה מדי: ${im.w} פיקסלים (המינימום ${IMG_LIMITS.minWidth})`);
  if (typeof im.dh !== 'string' || !/^[0-9a-f]{16}$/.test(im.dh)) out.push('חסרה חתימה חזותית (dh), שבה בודקים כפילויות. היא נוצרת בהעלאת התמונה');
  for (const f of ['fx', 'fy']) if (typeof im[f] !== 'number' || im[f] < 0 || im[f] > 100) out.push(`נקודת המיקוד ${f} חייבת להיות מספר מ־0 עד 100`);
  if (!IMG_RIGHTS.includes(im.rights)) out.push(`אישור הפרסום (rights) חייב להיות אחד מ: ${IMG_RIGHTS.join(', ')}`);
  for (const f of ['caption', 'credit', 'year', 'note', 'consent', 'check']) if (im[f] != null && typeof im[f] !== 'string') out.push(`השדה ${f} חייב להיות טקסט`);
  if (im.rights !== 'approved') return out;
  if (!im.decorative && !text(im.alt)) out.push('חסר תיאור לקוראי מסך (alt). לתמונה שרק מקשטת סמנו decorative');
  if (im.decorative && text(im.alt)) out.push('תמונה מקשטת (decorative) צריכה alt ריק');
  if (text(im.alt)) {
    if (im.alt.length > IMG_LIMITS.alt) out.push(`התיאור (alt) ארוך מדי: ${im.alt.length} תווים (עד ${IMG_LIMITS.alt})`);
    if (LEAD_IN.test(im.alt)) out.push('התיאור (alt) לא מתחיל ב״תמונה של״ או ״צילום של״: אומרים מה בתמונה');
    if (text(im.caption) && im.alt.trim() === im.caption.trim()) out.push('התיאור (alt) והכיתוב זהים: הכיתוב צריך להוסיף הקשר');
  }
  if (text(im.caption)) {
    if (im.caption.length > IMG_LIMITS.caption) out.push(`הכיתוב ארוך מדי: ${im.caption.length} תווים (עד ${IMG_LIMITS.caption})`);
    if (LEAD_IN.test(im.caption) || /לחצו להגדלה|click to enlarge/i.test(im.caption)) out.push('הכיתוב לא מתחיל ב״תמונה של״ ולא כולל ״לחצו להגדלה״');
  }
  if (!text(im.credit)) out.push('חסר קרדיט: שם הצלם או הבעלים, ואם לא ידוע כותבים ״לא ידוע״');
  if (!IMG_OTHERS.includes(im.others)) out.push(`צריך לציין אם יש בתמונה אנשים נוספים (others): ${IMG_OTHERS.join(', ')}`);
  else if ((im.others === 'adults' || im.others === 'children') && !text(im.consent)) out.push('בתמונה יש ילדים או אנשים נוספים: צריך לרשום מי אישר את הפרסום (consent)');
  return out;
};

// Problems with a gallery: how many photos, none twice, and none that only decorates. "page" is a page made only for the gallery.
export const galleryProblems = (ids, { page = false } = {}) => {
  const max = page ? IMG_LIMITS.galleryPage : IMG_LIMITS.gallery, out = [];
  if (!Array.isArray(ids) || !ids.length) return ['גלריה צריכה לפחות תמונה אחת'];
  if (ids.length > max) out.push(`בגלריה ${ids.length} תמונות, והמקסימום ${max}${page ? '' : '. יותר מזה: דף גלריה נפרד'}`);
  if (new Set(ids).size !== ids.length) out.push('אותה תמונה מופיעה בגלריה יותר מפעם אחת');
  return out;
};

// Problems with an image block and with the photos one page shows (the same photo twice on a page is a repetition, not a second look).
export const blockProblems = (blocks) => {
  const out = [], seen = new Set();
  for (const b of blocks || []) {
    if (b.type === 'image' && b.size != null && !SIZES.includes(b.size)) out.push(`גודל תמונה לא מוכר: ${b.size}`);
    const ids = b.type === 'image' ? [b.id] : b.type === 'gallery' ? b.ids : [];
    if (b.type === 'gallery') out.push(...galleryProblems(b.ids));
    for (const id of Array.isArray(ids) ? ids : []) { if (seen.has(id)) out.push(`התמונה ${id} מופיעה בדף יותר מפעם אחת`); seen.add(id); }
  }
  return out;
};

// ---- finding a photo that is already on the site: a 64-bit signature of what the picture looks like ----
// The picture, in grey, is averaged into a 9x8 grid, and each cell is compared with the one to its right. A resized or recompressed
// copy gives almost the same bits; a different photo, even of the same person, does not. Fed by sharp (the preparing tool) and by a
// canvas (the editor), which both hand over the same thing: one grey byte per pixel.
export const dhash = (grey, w, h) => {
  const sum = new Float64Array(72), n = new Float64Array(72);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(7, Math.floor((y * 8) / h));
    for (let x = 0; x < w; x++) { const c = gy * 9 + Math.min(8, Math.floor((x * 9) / w)); sum[c] += grey[y * w + x]; n[c]++; }
  }
  let hex = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 2 + (sum[y * 9 + x + k] / n[y * 9 + x + k] < sum[y * 9 + x + k + 1] / n[y * 9 + x + k + 1] ? 1 : 0);
    hex += v.toString(16);
  }
  return hex;
};
export const distance = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } } return d; };
// The registered photo this one looks like, if any (the same photo, or the same moment of it).
export const lookalike = (dh, list, except) => list.find((x) => x.id !== except && typeof x.dh === 'string' && distance(dh, x.dh) <= IMG_LIMITS.dup) || null;

// A flat bar along an edge (a screenshot's black strip, a border): from the edge inward, lines that are each one nearly flat grey, at least
// 8px deep and not more than a quarter of the photo, ending where the picture starts. A white studio background is flat too, but goes on
// for far more than a quarter, so it is not taken for a bar. Returns { side, depth } or null.
export const flatBar = (grey, w, h) => {
  const line = (side, k) => {
    const n = side === 'top' || side === 'bottom' ? w : h, v = new Array(n);
    for (let i = 0; i < n; i++) v[i] = grey[side === 'top' ? k * w + i : side === 'bottom' ? (h - 1 - k) * w + i : side === 'left' ? i * w + k : i * w + (w - 1 - k)];
    const mean = v.reduce((a, c) => a + c, 0) / n;
    return { mean, sd: Math.sqrt(v.reduce((a, c) => a + (c - mean) ** 2, 0) / n) };
  };
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const depth = Math.floor((side === 'top' || side === 'bottom' ? h : w) / 4), first = line(side, 0);
    let k = 0;
    while (k < depth && line(side, k).sd < 8 && Math.abs(line(side, k).mean - first.mean) < 20) k++;
    if (k >= 8 && k < depth && Math.abs(line(side, k).mean - first.mean) > 25) return { side, depth: k };
  }
  return null;
};

// ---- who may decide ----
// Saying that a photo may be published, and writing down who agreed to children or other people being in it, is the owner's: an editor
// who could do it for themselves would make the check worthless. Returns the sentences for what the person is not allowed to change.
export const ownerOnlyChanges = (before, after) => {
  const was = new Map((before || []).map((x) => [x.id, x])), out = [];
  for (const im of after || []) {
    const old = was.get(im.id) || {};
    if (im.rights === 'approved' && old.rights !== 'approved') out.push(`רק בעל האתר מאשר פרסום של תמונה (${im.id})`);
    else if (old.rights === 'approved' && im.rights !== 'approved') out.push(`רק בעל האתר מבטל אישור פרסום (${im.id})`);
    if ((im.consent || '') !== (old.consent || '')) out.push(`רק בעל האתר רושם מי אישר לפרסם תמונה עם ילדים או אנשים נוספים (${im.id})`);
  }
  return out;
};

// Entries that came or went, or whose id, width or height changed: those come from the files, never from a form.
export const registryShapeChanges = (before, after) => {
  const was = new Map((before || []).map((x) => [x.id, x])), now = new Map((after || []).map((x) => [x.id, x])), out = [];
  for (const id of was.keys()) if (!now.has(id)) out.push(`תמונה לא נמחקת מהרישום (${id})`);
  for (const [id, im] of now) if (was.has(id) && (was.get(id).w !== im.w || was.get(id).h !== im.h)) out.push(`ברוחב ובגובה של תמונה לא נוגעים (${id})`);
  return out;
};
