// Photos: the registry checks (data/images.json and data/img/), the page blocks that use them, and the srcset paths under a sub-path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.SITE_BASE = '/Web'; // read once when core.mjs loads, so it is set before the import below
const { images, validateImages, validateCms, webpSize, rebase } = await import('../scripts/lib/core.mjs');
const { figure, gallery } = await import('../scripts/lib/images.mjs');

// These tests use the photos' files, not their approval, so they run as if every photo were approved (this process only).
for (const i of images) i.rights = 'approved';
const sample = images.find((i) => i.id === 'armchair');
const entry = (over = {}) => ({ ...sample, rights: 'approved', ...over });
// A copy of one real photo's files, so a test can break one thing at a time.
const fixture = () => { const d = mkdtempSync(join(tmpdir(), 'img-')); cpSync(new URL(`../data/img/${sample.id}`, import.meta.url), join(d, sample.id), { recursive: true }); return d + '/'; };
const asUrl = (d) => new URL(`file://${d}`);

test('webpSize() reads the size from the file header, and refuses anything that is not a WebP', () => {
  const [w, h] = webpSize(readFileSync(new URL(`../data/img/${sample.id}/480.webp`, import.meta.url)));
  assert.equal(w, 480);
  assert.ok(Math.abs(h - (480 * sample.h) / sample.w) <= 1.5);
  assert.throws(() => webpSize(Buffer.from('GIF89a'.padEnd(40, ' '))), /not a WebP/);
});

test('every photo in data/images.json has its files, in the registered proportions', () => {
  assert.doesNotThrow(() => validateImages(images));
});

test('validateImages() fails on a missing file, a wrong size, no alt text and a bad id', () => {
  const dir = fixture();
  try {
    assert.doesNotThrow(() => validateImages([entry()], asUrl(dir)));
    assert.throws(() => validateImages([entry({ h: sample.h * 2 })], asUrl(dir)), /expected/);
    assert.throws(() => validateImages([entry({ alt: ' ' })], asUrl(dir)), /alt/);
    assert.doesNotThrow(() => validateImages([entry({ alt: '', decorative: true })], asUrl(dir)));
    assert.throws(() => validateImages([entry({ id: 'Bad Id' })], asUrl(dir)), /invalid or duplicate/);
    assert.throws(() => validateImages([entry({ rights: 'maybe' })], asUrl(dir)), /rights/);
    assert.throws(() => validateImages([entry({ fx: 120 })], asUrl(dir)), /fx/);
    assert.throws(() => validateImages([entry(), entry()], asUrl(dir)), /duplicate/);
    rmSync(join(dir, sample.id, '480.webp'));
    assert.throws(() => validateImages([entry()], asUrl(dir)), /480.webp: file is missing/);
    writeFileSync(join(dir, sample.id, '480.webp'), 'not an image'.padEnd(40));
    assert.throws(() => validateImages([entry()], asUrl(dir)), /not a WebP/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a page may show only photos that are approved for publishing', () => {
  const topics = [{ slug: 'x', title: 'x', kind: 'page' }];
  const page = (blocks) => [{ slug: 'p', topic: 'x', title: 'p', blocks }];
  const list = [entry({ id: 'ok' }), entry({ id: 'wait', rights: 'pending' })];
  assert.doesNotThrow(() => validateCms(topics, page([{ type: 'image', id: 'ok' }, { type: 'gallery', ids: ['ok'] }]), list));
  assert.throws(() => validateCms(topics, page([{ type: 'image', id: 'wait' }]), list), /not approved/);
  assert.throws(() => validateCms(topics, page([{ type: 'gallery', ids: ['ok', 'wait'] }]), list), /not approved/);
  assert.throws(() => validateCms(topics, page([{ type: 'image', id: 'nope' }]), list), /unknown image/);
  assert.throws(() => validateCms(topics, page([{ type: 'gallery', ids: [] }]), list), /gallery needs/);
});

test('figure() gives the browser the size to reserve and the sizes to choose from; only the lead photo loads at once', () => {
  const f = figure(sample.id, { size: 'full' }), lead = figure(sample.id, { size: 'full', lead: true });
  assert.match(f, /<img [^>]*width="800" height="1054"/);
  assert.match(f, /srcset="[^"]*480\.webp\?v=\w+ 480w, [^"]*800\.webp\?v=\w+ 800w, [^"]*1002\.webp\?v=\w+ 1002w"/);
  assert.match(f, /<figure class="fig fig-full fig-tall">/);
  assert.match(f, /loading="lazy" decoding="async"/);
  assert.match(lead, /fetchpriority="high"/);
  assert.doesNotMatch(lead, /loading=/);
  assert.doesNotMatch(f + lead, /style=/);
});

test('figure() escapes the text from the data and shows the caption and credit only when there are some', () => {
  const im = images.find((i) => i.id === sample.id), saved = { ...im };
  try {
    Object.assign(im, { alt: 'a "quoted" <b>', caption: 'כיתוב <i>', credit: 'צלם', year: '1999' });
    const f = figure(sample.id);
    assert.match(f, /alt="a &quot;quoted&quot; &lt;b&gt;"/);
    assert.match(f, /<figcaption>כיתוב &lt;i&gt; <span class="fyear">1999<\/span><span class="fcred">צילום: צלם<\/span><\/figcaption>/);
    Object.assign(im, { caption: '', credit: '', year: '' });
    assert.doesNotMatch(figure(sample.id), /figcaption/);
  } finally { Object.assign(im, saved); }
});

test('gallery() links each thumbnail to the big photo and keeps its text for the lightbox', () => {
  const g = gallery([sample.id], 'גלריה "א"');
  assert.match(g, /<ul class="gal" data-gallery aria-label="גלריה &quot;א&quot;">/);
  assert.match(g, /<a href="\/img\/p\/armchair\/1002\.webp\?v=\w+" data-w="1002" data-h="1320" data-note="צילום: לא ידוע">/);
  assert.match(g, /<img src="[^"]*t360\.webp\?v=\w+" srcset="[^"]*t360\.webp\?v=\w+ 360w, [^"]*t720\.webp\?v=\w+ 720w" [^>]*width="360" height="480"/);
});

test('figure() and gallery() refuse a photo that is not approved, so no page can show it', () => {
  const im = images.find((i) => i.id === sample.id);
  try {
    im.rights = 'pending';
    assert.throws(() => figure(sample.id), /not approved/);
    assert.throws(() => gallery([sample.id]), /not approved/);
    assert.throws(() => figure('nope'), /unknown image/);
  } finally { im.rights = 'approved'; }
});

test('rebase() adds the site base to every path in a srcset, and leaves other hosts alone', () => {
  assert.equal(rebase('<img src="/a.webp" srcset="/a-1.webp 1w, /a-2.webp 2w">'), '<img src="/Web/a.webp" srcset="/Web/a-1.webp 1w, /Web/a-2.webp 2w">');
  assert.equal(rebase('<img srcset="https://x.example/a.webp 1w, /b.webp 2w">'), '<img srcset="https://x.example/a.webp 1w, /Web/b.webp 2w">');
});
