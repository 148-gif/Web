// Unit tests for the internal-link audit (scripts/lib/linkaudit.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditSite, extractPage, mention, pagePath, resolve, formatReport, linkScores, reportKeys, needsAttention } from '../scripts/lib/linkaudit.mjs';

const page = (title, main, { nav = '', head = '' } = {}) => `<html><head><title>${title}</title>${head}</head><body><header><nav><a href="/">בית</a>${nav}</nav></header><main><h1>${title}</h1>${main}</main><footer></footer></body></html>`;
const codes = (res, code) => res.findings.filter((f) => f.code === code).map((f) => f.path || f.detail);

test('pagePath() and resolve()', () => {
  assert.equal(pagePath('index.html'), '/');
  assert.equal(pagePath('a/b/index.html'), '/a/b/');
  assert.equal(pagePath('404.html'), '/404');
  assert.equal(pagePath('app.js'), null);
  assert.equal(resolve('/a/b/?x=1#y', '/'), '/a/b/');
  assert.equal(resolve('../c/', '/a/b/'), '/a/c/');
  assert.equal(resolve('/site/a/', '/', '/site'), '/a/');
  for (const h of ['#x', 'https://x.co/', 'mailto:a@b.co', 'tel:1', '//x.co/a']) assert.equal(resolve(h, '/'), null);
});

test('extractPage() separates content links from navigation and finds bad anchors', () => {
  const p = extractPage('a/index.html', page('כותרת', '<a href="/b/">הלכות שבת</a> <a href="/c/"><img src="x.png" alt=""></a> <a href="/d/"></a><a onclick="go()">x</a>', { nav: '<a href="/menu/">תפריט</a>' }));
  assert.deepEqual(p.links.filter((l) => l.region === 'chrome').map((l) => l.to), ['/', '/menu/']);
  assert.deepEqual(p.links.filter((l) => l.region === 'content').map((l) => l.to), ['/b/', '/c/', '/d/']);
  assert.deepEqual(p.problems.map((x) => x.code).sort(), ['empty-anchor', 'empty-anchor', 'not-crawlable']);
  assert.equal(p.title, 'כותרת');
});

test('a pager inside a nav counts as content, noindex pages are left out', () => {
  const html = '<main><nav class="pager"><a href="/p/2/">2</a></nav></main>';
  assert.deepEqual(extractPage('index.html', html).links.map((l) => l.region), ['content']);
  assert.equal(extractPage('x/index.html', '<meta name="robots" content="noindex"><main></main>').noindex, true);
});

test('auditSite() finds orphans, broken links, depth, generic anchors and nav-only pages', () => {
  const files = {
    'index.html': page('בית', '<a href="/a/">עמוד א</a>', { nav: '<a href="/navonly/">רק בתפריט</a>' }),
    'a/index.html': page('עמוד א', '<a href="/b/">כאן</a> <a href="/nope/">שבור</a>'),
    'b/index.html': page('עמוד ב', '<a href="/c/">עמוד ג</a>'),
    'c/index.html': page('עמוד ג', '<a href="/d/">עמוד ד</a>'),
    'd/index.html': page('עמוד ד', '<a href="/e/">עמוד ה</a>'),
    'e/index.html': page('עמוד ה', ''),
    'navonly/index.html': page('רק בתפריט', ''),
    'orphan/index.html': page('יתום', ''),
    '404.html': page('לא נמצא', '<meta name="robots" content="noindex">'),
  };
  const res = auditSite(files);
  assert.deepEqual(codes(res, 'orphan'), ['/orphan/']);
  assert.deepEqual(codes(res, 'broken-link'), ['/a/']);
  assert.deepEqual(codes(res, 'nav-only'), ['/navonly/']);
  assert.deepEqual(codes(res, 'too-deep'), ['/d/', '/e/']);
  assert.equal(codes(res, 'generic-anchor').length, 1);
  assert.equal(res.stats.errors, 2);
});

test('auditSite() compares the sitemap and suggests unlinked mentions', () => {
  const files = {
    'index.html': page('בית', '<a href="/a/">א</a> <a href="/b/">ב</a>'),
    'a/index.html': page('הלכות נטילת ידיים', ''),
    'b/index.html': page('על התפילה', 'כאן מדברים על הלכות נטילת ידיים לפני התפילה'),
  };
  const res = auditSite(files, { sitemap: ['/', '/a/', '/gone/'] });
  assert.deepEqual(codes(res, 'sitemap-missing-page'), ['/gone/']);
  assert.deepEqual(codes(res, 'not-in-sitemap'), ['/b/']);
  assert.deepEqual(res.suggestions.map((s) => [s.from, s.to, s.anchor]), [['/b/', '/a/', 'הלכות נטילת ידיים']]);
  assert.match(formatReport(res), /הצעות לקישורים חדשים/);
});

test('mention() matches whole phrases, with a Hebrew prefix letter', () => {
  assert.equal(mention('סעיף יב וסעיף י', 'סעיף י'), 'סעיף יב וסעיף י'.lastIndexOf('סעיף י'));
  assert.equal(mention('סעיף יב', 'סעיף י'), -1);
  assert.equal(mention('בתיקון הכללי', 'תיקון הכללי'), 1);
  assert.equal(mention('הכתיקון הכללי', 'תיקון הכללי'), -1);
});

test('linkScores() ranks a page that many pages link to above one nobody links to', () => {
  const out = new Map([['/', new Set(['/a/', '/b/'])], ['/a/', new Set(['/c/'])], ['/b/', new Set(['/c/'])], ['/c/', new Set(['/'])], ['/d/', new Set(['/'])]]);
  const s = linkScores(['/', '/a/', '/b/', '/c/', '/d/'], out);
  assert.ok(s.get('/c/') > s.get('/a/') && s.get('/a/') > s.get('/d/'));
  assert.equal(Math.max(...s.values()), 100);
  assert.equal(Math.min(...s.values()), 0);
  assert.equal(linkScores([], new Map()).size, 0);
});

test('auditSite() applies the config: ignore, ignorePairs and aliases', () => {
  const files = {
    'index.html': page('בית', '<a href="/a/">א</a> <a href="/b/">ב</a> <a href="/o/">ג</a>'),
    'a/index.html': page('הלכות נטילת ידיים', ''),
    'b/index.html': page('על התפילה', 'מדברים על נטילה שחרית ועל הלכות נטילת ידיים'),
    'o/index.html': page('יתום', ''),
  };
  const base = auditSite(files);
  assert.equal(base.suggestions.length, 1);
  assert.equal(auditSite(files, { config: { ignorePairs: [['/b/', '/a/']] } }).suggestions.length, 0);
  assert.equal(auditSite(files, { config: { aliases: { '/a/': ['נטילה שחרית'] } } }).suggestions[0].anchor, 'הלכות נטילת ידיים');
  const noOrphan = auditSite({ ...files, 'index.html': page('בית', '<a href="/a/">א</a> <a href="/b/">ב</a>') });
  assert.equal(codes(noOrphan, 'orphan').length, 1);
  assert.equal(codes(auditSite({ ...files, 'index.html': page('בית', '<a href="/a/">א</a> <a href="/b/">ב</a>') }, { config: { ignore: [{ code: 'orphan', path: '/o/' }] } }), 'orphan').length, 0);
});

test('reportKeys() and the report tell what is new, and info lines do not need a person', () => {
  const files = { 'index.html': page('בית', '<a href="/a/">א</a>'), 'a/index.html': page('עמוד', '') };
  const res = auditSite(files);
  assert.equal(needsAttention(res), false);
  const broken = auditSite({ ...files, 'a/index.html': page('עמוד', '<a href="/gone/">שבור</a>') });
  assert.equal(needsAttention(broken), true);
  assert.match(formatReport(broken, { previous: reportKeys(res) }), /חדש מאז הריצה הקודמת: 1/);
  assert.match(formatReport(broken, { previous: reportKeys(broken) }), /לא נוספו בעיות חדשות/);
});
