// The photo rules shared by the build and the editor (site/admin/image-rules.mjs): each rule from .claude/skills/images/SKILL.md that can be checked by a program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageProblems, galleryProblems, blockProblems, budgetFor, IMG_LIMITS, dhash, distance, lookalike, flatBar, ownerOnlyChanges, registryShapeChanges, photoFiles, imgWidths } from '../site/admin/image-rules.mjs';

const ok = { id: 'a', w: 1200, h: 1600, alt: 'הרב יושב ליד שולחן', caption: '', credit: 'לא ידוע', year: '', fx: 50, fy: 40, dh: '0123456789abcdef', rights: 'approved', others: 'none', consent: '', note: '', tags: [] };
const say = (over) => imageProblems({ ...ok, ...over }).join(' | ');

test('a complete, approved photo has no problems', () => assert.deepEqual(imageProblems(ok), []));

test('a photo that is not approved yet may be unfinished, but its numbers must still be right', () => {
  assert.deepEqual(imageProblems({ ...ok, rights: 'pending', alt: '', credit: '', others: '' }), []);
  assert.match(say({ rights: 'pending', w: 500 }), /צרה מדי/);
  assert.match(say({ rights: 'maybe' }), /rights/);
});

test('a photo needs a description, unless it only decorates', () => {
  assert.match(say({ alt: '' }), /alt/);
  assert.match(say({ alt: '   ' }), /alt/);
  assert.deepEqual(imageProblems({ ...ok, alt: '', decorative: true }), []);
  assert.match(say({ alt: 'x', decorative: true }), /ריק/);
});

test('the description says what is in the photo: not "a photo of", not too long, not the same as the caption', () => {
  for (const alt of ['תמונה של הרב', 'צילום של הרב', 'תמונת הרב', 'Photo of the rabbi', 'image of x']) assert.match(say({ alt }), /לא מתחיל/, alt);
  assert.deepEqual(imageProblems({ ...ok, alt: 'צילומי אולפן של הרב' }), []);
  assert.match(say({ alt: 'א'.repeat(IMG_LIMITS.alt + 1) }), /ארוך מדי/);
  assert.match(say({ alt: 'הרב', caption: 'הרב' }), /זהים/);
});

test('the caption is not "a photo of", no "click to enlarge", and short', () => {
  assert.match(say({ caption: 'תמונה של הרב' }), /הכיתוב/);
  assert.match(say({ caption: 'הרב, לחצו להגדלה' }), /הכיתוב/);
  assert.match(say({ caption: 'א'.repeat(IMG_LIMITS.caption + 1) }), /הכיתוב ארוך/);
  assert.deepEqual(imageProblems({ ...ok, caption: 'בסעודת שבת, תשס״ח' }), []);
});

test('every photo has a credit, even if it is "unknown"', () => {
  assert.match(say({ credit: '' }), /קרדיט/);
  assert.match(say({ credit: undefined }), /קרדיט/);
});

test('children and other people need the approval written down; someone far in the background does not', () => {
  assert.match(say({ others: '' }), /אנשים נוספים/);
  assert.match(say({ others: 'everyone' }), /אנשים נוספים/);
  for (const others of ['adults', 'children']) {
    assert.match(say({ others }), /consent/);
    assert.deepEqual(imageProblems({ ...ok, others, consent: 'בעל האתר אישר' }), []);
  }
  assert.deepEqual(imageProblems({ ...ok, others: 'background' }), []);
});

test('galleries: 1 to 12 photos in a page, up to 48 on a page made for the gallery, none twice', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `p${i}`);
  assert.deepEqual(galleryProblems(ids(12)), []);
  assert.match(galleryProblems(ids(13)).join(), /דף גלריה נפרד/);
  assert.deepEqual(galleryProblems(ids(48), { page: true }), []);
  assert.match(galleryProblems(ids(49), { page: true }).join(), /מקסימום 48/);
  assert.match(galleryProblems([]).join(), /גלריה צריכה/);
  assert.match(galleryProblems(['a', 'a']).join(), /יותר מפעם/);
});

test('a page does not show the same photo twice, and an image block has a known size', () => {
  assert.deepEqual(blockProblems([{ type: 'image', id: 'a' }, { type: 'gallery', ids: ['b', 'c'] }]), []);
  assert.match(blockProblems([{ type: 'image', id: 'a' }, { type: 'image', id: 'a' }]).join(), /a מופיעה/);
  assert.match(blockProblems([{ type: 'image', id: 'a', size: 'huge' }]).join(), /גודל/);
});

test('file size limits grow with the width of the photo', () => {
  assert.equal(budgetFor('480.webp'), 70e3);
  assert.equal(budgetFor('1002.webp'), 260e3);
  assert.equal(budgetFor('1600.webp'), 420e3);
  assert.equal(budgetFor('t360.webp'), 40e3);
  assert.equal(budgetFor('t720.webp'), 120e3);
});

test('a photo needs its visual signature, which is how copies of it are found', () => {
  assert.match(say({ dh: undefined }), /חתימה/);
  assert.match(say({ dh: 'xyz' }), /חתימה/);
  assert.match(say({ rights: 'pending', dh: '' }), /חתימה/);
});

// A grey picture drawn by a function, so the tests need no image files.
const picture = (w, h, f) => { const g = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x / w, y / h); return g; };
const scene = (u, v) => 40 + 180 * Math.abs(Math.sin(u * 7) * Math.cos(v * 5));

test('dhash() gives the same signature for a picture at another size and a different one for another picture', () => {
  const a = dhash(picture(512, 384, scene), 512, 384), b = dhash(picture(160, 120, scene), 160, 120), c = dhash(picture(512, 384, (u, v) => 40 + 180 * Math.abs(Math.cos(u * 3) * Math.sin(v * 9))), 512, 384);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(distance(a, b) <= IMG_LIMITS.dup, `the same picture at two sizes: ${distance(a, b)}`);
  assert.ok(distance(a, c) > IMG_LIMITS.dup, `two different pictures: ${distance(a, c)}`);
  assert.equal(distance(a, a), 0);
  assert.equal(distance('0000000000000000', 'ffffffffffffffff'), 64);
});

test('lookalike() finds a registered photo that is the same picture, and never the photo itself', () => {
  const dh = dhash(picture(256, 192, scene), 256, 192), list = [{ id: 'a', dh }, { id: 'b', dh: '0000000000000000' }];
  assert.equal(lookalike(dh, list).id, 'a');
  assert.equal(lookalike(dh, list, 'a'), null);
  assert.equal(lookalike('ffffffffffffffff', list), null);
});

test('flatBar() finds a screenshot\'s strip along an edge but not a plain studio background', () => {
  assert.equal(flatBar(picture(200, 300, scene), 200, 300), null);
  const bottom = picture(200, 300, (u, v) => (v > 0.85 ? 0 : scene(u, v)));
  const found = flatBar(bottom, 200, 300);
  assert.equal(found.side, 'bottom');
  assert.ok(Math.abs(found.depth - 45) <= 2, `depth ${found.depth}`);
  const side = picture(200, 300, (u, v) => (u < 0.12 ? 235 : scene(u, v)));
  assert.equal(flatBar(side, 200, 300).side, 'left');
  assert.equal(flatBar(picture(200, 300, (u, v) => (v < 0.6 ? 250 : scene(u, v))), 200, 300), null, 'white background that goes on for more than a quarter');
  assert.equal(flatBar(picture(200, 300, (u, v) => (v > 0.99 ? 0 : scene(u, v))), 200, 300), null, 'a hairline is not a bar');
});

test('only the owner approves a photo or writes down who agreed to the people in it', () => {
  const before = [{ id: 'a', rights: 'pending', consent: '' }, { id: 'b', rights: 'approved', consent: 'בעל האתר' }];
  assert.deepEqual(ownerOnlyChanges(before, before), []);
  assert.match(ownerOnlyChanges(before, [{ ...before[0], rights: 'approved' }, before[1]]).join(), /מאשר פרסום/);
  assert.match(ownerOnlyChanges(before, [before[0], { ...before[1], rights: 'pending' }]).join(), /מבטל אישור/);
  assert.match(ownerOnlyChanges(before, [{ ...before[0], consent: 'אני אישרתי' }, before[1]]).join(), /רושם מי אישר/);
  assert.match(ownerOnlyChanges(before, [...before, { id: 'new', rights: 'approved', consent: '' }]).join(), /new/);
  assert.deepEqual(ownerOnlyChanges(before, [{ ...before[0], alt: 'x', caption: 'y' }, before[1]]), [], 'description and caption are for any editor');
});

test('a photo cannot be added, removed or resized from a form: that comes from its files', () => {
  const before = [{ id: 'a', w: 1000, h: 1500 }, { id: 'b', w: 900, h: 1200 }];
  assert.deepEqual(registryShapeChanges(before, before), []);
  assert.match(registryShapeChanges(before, [before[0]]).join(), /לא נמחקת/);
  assert.match(registryShapeChanges(before, [{ ...before[0], w: 999 }, before[1]]).join(), /לא נוגעים/);
  assert.deepEqual(registryShapeChanges(before, [...before, { id: 'c', w: 800, h: 800 }]), [], 'a new entry arrives with its files; the server checks those');
});

test('a photo is kept in these sizes: the standard widths below its own, the whole photo, and the thumbnails it is wide enough for', () => {
  assert.deepEqual(imgWidths({ w: 1002 }), [480, 800, 1002]);
  assert.deepEqual(photoFiles({ w: 1600 }), ['480.webp', '800.webp', '1200.webp', '1600.webp', 't360.webp', 't720.webp']);
  assert.deepEqual(photoFiles({ w: 800 }), ['480.webp', '800.webp', 't360.webp', 't720.webp']);
  assert.deepEqual(photoFiles({ w: 700 }), ['480.webp', '700.webp', 't360.webp']);
});
