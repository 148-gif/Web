// Unit tests for the build's text and safety helpers. Run with: npm test (also part of npm run check and CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { url, tel, esc, escAttr, gist, isHidden, unlinkHidden, HIDDEN, site, validateCms, validateShutEdit, mergeShut } from '../scripts/lib/core.mjs';
import { ld, pageNumbers, pagerHtml } from '../scripts/lib/parts.mjs';

test('url() keeps https links and site paths', () => {
  assert.equal(url('https://example.com/a'), 'https://example.com/a');
  assert.equal(url('/shut/12/'), '/shut/12/');
  assert.equal(url(''), '');
  assert.equal(url('mailto:a@b.co', ['mailto:']), 'mailto:a@b.co');
});

test('url() escapes quotes so a link cannot break out of its attribute', () => {
  assert.equal(url('https://example.com/?a="b"&c=<d>'), 'https://example.com/?a=&quot;b&quot;&amp;c=&lt;d&gt;');
});

test('url() fails the build on unsafe or unexpected links', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'http://example.com', '//evil.example', '/\\evil.example', 'not a url', 'vbscript:x']) {
    assert.throws(() => url(bad), Error, bad);
  }
  assert.throws(() => url('https://example.com', ['mailto:']));
});

test('tel() accepts phone numbers and rejects anything else', () => {
  assert.equal(tel('04-123 4567'), '041234567');
  assert.equal(tel('+972 50-000-0000'), '+972500000000');
  for (const bad of ['javascript:1', '04"onclick', '', 'abc']) assert.throws(() => tel(bad), Error, bad);
});

test('esc() and escAttr() escape HTML', () => {
  assert.equal(escAttr(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc('<b>'), '&lt;b&gt;');
});

test('esc() isolates number ranges so they keep their order in Hebrew', () => {
  assert.equal(esc('1940–2015'), '⁦1940–2015⁩');
  assert.equal(escAttr('1940–2015'), '1940–2015');
});

test('gist() skips the date, the greeting and the opening formula', () => {
  const body = 'ה׳ שבט תשע״ה|שלום וברכה|לנכון קבלתי את מכתבך. ' + 'תשובה ארוכה '.repeat(8);
  assert.ok(gist(body.split('|')).startsWith('תשובה ארוכה'));
});

test('ld() cannot close its own script tag', () => {
  const out = ld({ name: '</script><script>alert(1)</script>' });
  assert.equal(out.match(/<\/script>/g).length, 1);
  assert.ok(out.endsWith('</script>'));
});

test('every hidden section has a clean path and a reason (CLAUDE.md)', () => {
  for (const h of site.hidden || []) {
    assert.match(h.path, /^\/[\w-]+(\/[\w-]+)*\/$/, h.path);
    assert.ok(h.why && h.why.trim(), `missing "why" for ${h.path}`);
  }
});

test('hidden sections: links become text, cards and list items are dropped', { skip: !HIDDEN.length && 'nothing is hidden' }, () => {
  const h = HIDDEN[0];
  assert.ok(isHidden(`${h}5/`));
  assert.ok(!isHidden('/shut/'));
  assert.ok(!isHidden(h.replace(/\/$/, '-old/')));
  assert.equal(unlinkHidden(`<p>ראו <a href="${h}5/">כאן</a>.</p>`), '<p>ראו כאן.</p>');
  assert.equal(unlinkHidden(`<div><a class="card qcard" href="${h}">x</a></div>`), '<div></div>');
  assert.equal(unlinkHidden(`<ul><li><a href="${h}">א</a>: תיאור</li><li><a href="/shut/">ב</a></li></ul>`), '<ul><li><a href="/shut/">ב</a></li></ul>');
  const live = '<p><a href="/shut/12/">שאלה</a> <a href="https://example.com/">חוץ</a></p>';
  assert.equal(unlinkHidden(live), live);
});

test('validateCms() accepts good topics and pages and rejects bad ones', () => {
  const t = [{ slug: 'parasha', title: 'פרשה' }];
  const p = { slug: 'bereshit', topic: 'parasha', title: 'בראשית', blocks: [{ type: 'text' }] };
  assert.doesNotThrow(() => validateCms(t, [p]));
  assert.doesNotThrow(() => validateCms([], []));
  assert.throws(() => validateCms([{ slug: 'Bad Slug', title: 'x' }], []));
  assert.throws(() => validateCms([{ slug: 'shut', title: 'x' }], []), /slug/); // would overwrite a built-in section
  assert.throws(() => validateCms([...t, ...t], []), /duplicate/);
  assert.throws(() => validateCms(t, [{ ...p, topic: 'nope' }]), /unknown topic/);
  assert.throws(() => validateCms(t, [{ ...p, title: '' }]), /no title/);
  assert.throws(() => validateCms(t, [{ ...p, blocks: [{ type: 'script' }] }]), /block type/);
  assert.throws(() => validateCms(t, [{ ...p, slug: '../x' }]), /file name/);
});

test('mergeShut() applies editor edits: replace, add, delete', () => {
  const base = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }];
  assert.equal(mergeShut(base, []), base);
  assert.deepEqual(mergeShut(base, [{ id: 2, title: 'B' }, { id: 3, deleted: true }, { id: 9, title: 'new' }]).map((x) => x.title), ['a', 'B', 'new']);
});

test('validateShutEdit() rejects edits that would break the site', () => {
  const ok = { id: 7, kind: 'shut', title: 'כותרת', q: ['שאלה'], a: ['תשובה'], date: '' };
  assert.doesNotThrow(() => validateShutEdit('7.json', ok));
  assert.doesNotThrow(() => validateShutEdit('7.json', { id: 7, deleted: true }));
  for (const [f, x] of [['8.json', ok], ['7.json', { ...ok, kind: 'x' }], ['7.json', { ...ok, title: '' }], ['7.json', { ...ok, a: ['', ' '] }], ['7.json', { ...ok, q: 'text' }], ['7.json', { ...ok, a: [1] }], ['..json', { ...ok, id: '.' }]]) {
    assert.throws(() => validateShutEdit(f, x), Error, JSON.stringify(x).slice(0, 40));
  }
});

test('validateCms() checks topic kind, group and categories, and a page category', () => {
  const t = { slug: 'recipes', title: 'מתכונים', kind: 'collection', group: 'לימוד', categories: [{ id: 'meat', title: 'בשרי' }, { id: 'dairy', title: 'חלבי' }] };
  const p = { slug: 'soup', topic: 'recipes', title: 'מרק', category: 'meat' };
  assert.doesNotThrow(() => validateCms([t], [p]));
  assert.doesNotThrow(() => validateCms([{ slug: 'a', title: 'א' }], [])); // topics made before kinds existed
  assert.doesNotThrow(() => validateCms([t], [{ ...p, category: 'removed' }])); // an orphaned category must not stop the site
  assert.throws(() => validateCms([{ ...t, kind: 'tree' }], []), /kind/);
  assert.throws(() => validateCms([{ ...t, group: 'x'.repeat(41) }], []), /group/);
  assert.throws(() => validateCms([{ ...t, categories: [{ id: 'Bad Id', title: 'x' }] }], []), /categories/);
  assert.throws(() => validateCms([{ ...t, categories: [{ id: 'a', title: '' }] }], []), /categories/);
  assert.throws(() => validateCms([{ ...t, categories: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] }], []), /duplicate category/);
  assert.throws(() => validateCms([t], [{ ...p, category: 5 }]), /category/);
});

test('validateCms() allows one page, at most, in a single-page topic', () => {
  const t = { slug: 'about-us', title: 'עלינו', kind: 'page' };
  const p = { slug: 'about-us', topic: 'about-us', title: 'עלינו' };
  assert.doesNotThrow(() => validateCms([t], [p]));
  assert.doesNotThrow(() => validateCms([{ ...t, kind: 'pages' }], [p, { ...p, slug: 'b' }])); // the old name of a collection
  assert.throws(() => validateCms([t], [p, { ...p, slug: 'b' }]), /single page/);
});

test('pageNumbers() reaches every page of a long list within two clicks', () => {
  const total = 141;
  for (let cur = 1; cur <= total; cur += 7) {
    const near = new Set(pageNumbers(cur, total));
    assert.ok(near.has(1) && near.has(total) && near.has(cur));
  }
  const reach = new Set([1]);
  for (const a of pageNumbers(1, total)) for (const b of pageNumbers(a, total)) reach.add(b);
  assert.equal(reach.size, total);
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3]);
});

test('pagerHtml() links previous, next and numbers, and nothing for a single page', () => {
  const href = (n) => (n === 1 ? '/shut/' : `/shut/page/${n}/`);
  const h = pagerHtml(5, 12, href);
  assert.match(h, /href="\/shut\/page\/4\/">→ הקודם/);
  assert.match(h, /href="\/shut\/page\/6\/">הבא/);
  assert.match(h, /<span aria-current="page">5<\/span>/);
  assert.match(h, /href="\/shut\/"/);
  assert.doesNotMatch(pagerHtml(1, 1, href), /pager-nums|href=/);
});

test('validateCms() checks media blocks: a real /media/ file or an https link, and a title; an image block must name a registered photo, never a file or a link', () => {
  const t = [{ slug: 'm', title: 'מדיה' }], here = (n) => n === 'ab12cd34-x.png' || n === 'ab12cd34-x.pdf';
  const page = (b) => [{ slug: 'p', topic: 'm', title: 'דף', blocks: [b] }];
  assert.throws(() => validateCms(t, page({ type: 'image', src: '/media/ab12cd34-x.png', alt: 'תיאור' }), here), /registry/);
  assert.throws(() => validateCms(t, page({ type: 'image', src: 'https://cdn.example/x.png', alt: 'תיאור' }), here), /registry/);
  assert.doesNotThrow(() => validateCms(t, page({ type: 'video', src: 'https://cdn.example/v.mp4', title: 'סרטון' }), here));
  assert.doesNotThrow(() => validateCms(t, page({ type: 'file', src: '/media/ab12cd34-x.pdf', title: 'מסמך' }), here));
  for (const b of [{ type: 'video', src: '/media/missing.mp4', title: 'x' }, { type: 'video', src: '/media/ab12cd34-x.pdf', title: 'x' }, { type: 'video', src: ' ', title: ' ' },
    { type: 'file', src: 'http://insecure.example/x.pdf', title: 'x' }, { type: 'file', src: 'javascript:alert(1)', title: 'x' }, { type: 'file', src: '/media/../data/site.json', title: 'x' }, { type: 'audio', src: 'https://a.example/a.mp3', title: '' }]) {
    assert.throws(() => validateCms(t, page(b), here), Error, JSON.stringify(b));
  }
});
