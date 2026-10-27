// Unit tests for the build's text and safety helpers. Run with: npm test (also part of npm run check and CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { url, tel, esc, escAttr, gist, isHidden, unlinkHidden, HIDDEN, site, validateCms } from '../scripts/lib/core.mjs';
import { ld } from '../scripts/lib/parts.mjs';

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
