// The rules for photos, as plain functions with no file access: the build (core.mjs) fails on them, and the editor can show the same
// messages while someone types. One source, so the site and the editor cannot disagree. Explanation of each rule: .claude/skills/images/SKILL.md
export const IMG_RIGHTS = ['approved', 'pending'];
// Who is in the photo besides the Rabbi: "none", "background" (far away, not recognisable), "adults" or "children".
// With adults or children the owner's approval must be written down in "consent".
export const IMG_OTHERS = ['none', 'background', 'adults', 'children'];
export const IMG_LIMITS = { minWidth: 800, alt: 125, caption: 220, gallery: 12, galleryPage: 48 };
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
