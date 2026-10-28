// The photo rules shared by the build and the editor (site/admin/image-rules.mjs): each rule from .claude/skills/images/SKILL.md that can be checked by a program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageProblems, galleryProblems, blockProblems, budgetFor, IMG_LIMITS } from '../site/admin/image-rules.mjs';

const ok = { id: 'a', w: 1200, h: 1600, alt: 'הרב יושב ליד שולחן', caption: '', credit: 'לא ידוע', year: '', fx: 50, fy: 40, rights: 'approved', others: 'none', consent: '', note: '', tags: [] };
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
