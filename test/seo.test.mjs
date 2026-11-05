import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seoFile, validateSeo, validateSeoSettings, findPhrase, paragraphsOf, annotateHtml, contentRecommendations, resolveRedirect } from '../site/admin/seo-model.mjs';
import { transformSeo, filterSeoSitemap, redirectRules } from '../scripts/lib/seo-build.mjs';
const state = (records = {}, settings = { indexing: 'index', rules: [] }) => ({ records, settings, rendered: new Map() });
const shell = (body, head = '') => '<html><head><title>מקור</title><meta name="description" content="תיאור מקור">' + head + '</head><body><main>' + body + '</main></body></html>';
test('SEO records bind one canonical path to one file and reject protected routes or unsafe targets', () => {
  const record = { version: 1, path: '/shut/123/', title: 'כותרת', indexing: 'inherit' };
  assert.equal(validateSeo(record, seoFile(record.path)), record);
  for (const path of ['/admin/', '/cms-api/', '//evil.example/', '/a/../b/', 'https://other.test/']) assert.throws(() => validateSeo({ ...record, path }));
  assert.throws(() => validateSeo(record, seoFile('/shut/124/')));
  assert.throws(() => validateSeo({ ...record, canonical: 'https://other.test/' }));
  assert.throws(() => validateSeo({ ...record, title: 'x\nheader' }));
  assert.throws(() => validateSeoSettings({ indexing: 'index', rules: [{ anchor: 'מילות יעד', to: '/target/', enabled: 'yes' }] }));
});
test('Hebrew phrase matches preserve original niqqud, quotes and source offsets', () => {
  const text = 'עיינו בספר זֹאת הַתּוֹרָה מדי שבוע';
  const match = findPhrase(text, 'זאת התורה');
  assert.equal(match.anchor, 'זֹאת הַתּוֹרָה');
  assert.equal(text.slice(match.start, match.end), match.anchor);
  assert.equal(findPhrase('סעיף יב', 'סעיף י'), null);
  const repeated = 'סעיף יב מופיע קודם, ואילו סעיף י הוא היעד הנכון.';
  const selected = findPhrase(repeated, 'סעיף י');
  assert.equal(selected.start, repeated.lastIndexOf('סעיף י'));
  const linked = annotateHtml(shell('<p>' + repeated + '</p>'), [{ quote: repeated, anchor: selected.anchor, start: selected.start, to: '/target/' }]);
  assert.match(linked.html, /סעיף יב מופיע קודם, ואילו <a href="\/target\/">סעיף י<\/a>/);
  assert.equal(linked.applied.length, 1);
});
test('approved annotations create escaped real links without changing the source words', () => {
  const quote = 'בספר "זאת התורה" יש דברי חיזוק & עצות.';
  const html = shell('<p>בספר &quot;זאת התורה&quot; יש דברי חיזוק &amp; עצות.</p>');
  const link = { quote, anchor: 'זאת התורה', to: '/library/zot-hatorah/' };
  const result = annotateHtml(html, [link]);
  assert.equal(result.applied.length, 1);
  assert.match(result.html, /<a href="\/library\/zot-hatorah\/">זאת התורה<\/a>/);
  assert.match(result.html, /&amp; עצות/);
  assert.deepEqual(paragraphsOf(html), [quote]);
  const ambiguous = annotateHtml(shell('<p>' + quote + '</p><p>' + quote + '</p>'), [link]);
  assert.equal(ambiguous.applied.length, 0);
  assert.equal(ambiguous.stale.length, 1);
  assert.equal(annotateHtml(shell('<p>קטע אחר</p>'), [link]).stale.length, 1);
});
test('annotations do not nest links or alter navigation and headings', () => {
  const link = { quote: 'זאת התורה', anchor: 'זאת התורה', to: '/target/' };
  for (const body of ['<a href="/other/">זאת התורה</a>', '<nav>זאת התורה</nav>', '<h1>זאת התורה</h1>']) assert.equal(annotateHtml(shell(body), [link]).applied.length, 0);
});
test('book recommendations require context and are not suppressed by a navigation link', () => {
  const target = '/library/zot-hatorah/', good = 'וכן נדפס ספר זאת התורה על פרשיות השבוע.', verse = 'שנאמר זאת התורה אדם כי ימות באהל.';
  const page = (path, title, text, links = []) => ({ path, title, text, links, paragraphs: [text], noindex: false });
  const pages = [page('/shut/1/', 'לימוד פרשת השבוע', good, [{ to: target, region: 'chrome' }]), page('/shut/2/', 'על פסוק בתורה', verse), page(target, 'זאת התורה', 'פירוש על פרשיות השבוע')];
  const found = contentRecommendations(pages).inline;
  assert.deepEqual(found.map((x) => x.from), ['/shut/1/']);
  const dismissed = contentRecommendations(pages, { records: { '/shut/1/': { dismissed: [{ quote: good, anchor: 'זאת התורה', to: target }] } } }).inline;
  assert.equal(dismissed.length, 0);
});
test('SEO output escapes metadata, preserves H1 and cannot lift an existing noindex guard', () => {
  const path = '/page/', cfg = { path, title: 'כותרת <בטוחה>', description: 'תיאור "בטוח"', indexing: 'index' };
  const html = transformSeo(shell('<h1>כותרת התוכן</h1>', '<meta name="robots" content="noindex,nofollow">'), path, state({ [path]: cfg }), 'https://example.test');
  assert.match(html, /<title>כותרת &lt;בטוחה&gt;<\/title>/);
  assert.match(html, /content="תיאור &quot;בטוח&quot;"/);
  assert.match(html, /<h1>כותרת התוכן<\/h1>/);
  assert.match(html, /noindex,nofollow/);
  assert.match(transformSeo(shell('תוכן'), path, state({}, { indexing: 'noindex' })), /noindex,follow/);
});
test('sitemap has unique eligible canonical URLs and redirects reject cycles', () => {
  const path = '/a/', noindex = '/b/', xml = '<urlset><url><loc>https://example.test/a/</loc></url><url><loc>https://example.test/a/</loc></url><url><loc>https://example.test/b/</loc></url></urlset>';
  const result = filterSeoSitemap(xml, state({ [noindex]: { path: noindex, indexing: 'noindex' } }));
  assert.equal((result.match(/<url>/g) || []).length, 1);
  const records = { '/old/': { path: '/old/', redirectTo: path } };
  assert.equal(resolveRedirect('/old/', records), path);
  assert.match(redirectRules(state(records)), /RewriteRule \^old\/\?\$ \/a\/ \[R=301,L,NE\]/);
  assert.throws(() => resolveRedirect('/old/', { '/old/': { redirectTo: '/other/' }, '/other/': { redirectTo: '/old/' } }));
});
test('automatic rules are opt-in and pinned related content remains controllable', () => {
  const html = shell('<p>אפשר ללמוד ענייני תפילה בכל יום.</p>'), rule = { anchor: 'ענייני תפילה', to: '/prayer/', enabled: false, include: ['/shut/'] };
  assert.doesNotMatch(transformSeo(html, '/shut/1/', state({}, { rules: [rule] })), /href="\/prayer\/"/);
  assert.match(transformSeo(html, '/shut/1/', state({}, { rules: [{ ...rule, enabled: true }] })), /href="\/prayer\/"/);
  assert.doesNotMatch(transformSeo(html, '/other/', state({}, { rules: [{ ...rule, enabled: true }] })), /href="\/prayer\/"/);
  const custom = transformSeo(html, '/shut/1/', state({ '/shut/1/': { relatedAuto: false, related: [{ path: '/prayer/', title: 'תפילה' }] } }));
  assert.match(custom, /id="seo-related"/);
});

test('generic pages and unrelated chapter titles do not become exact entity recommendations', () => {
  const page = (path, title, text, entityType = '') => ({ path, title, text, entityType, paragraphs: [text], links: [], noindex: false });
  const source = page('/shut/3/', 'שאלה בענייני הלכה', 'היום יום טוב ושמח, ובספר אחר נזכר סעיף א ללימוד.');
  const pages = [source, page('/friends/yom-tov/', 'יום טוב', 'כתובת איש קשר', 'Person'), page('/library/other/a/', 'סעיף א', 'הלכות ארוכות בענייני לימוד', 'Chapter')];
  assert.equal(contentRecommendations(pages).inline.length, 0);
});
test('automatic rules skip partial words and select a later complete occurrence', () => {
  const quote = 'למדנו סעיף יב תחילה ואחר כך סעיף י בצורה מסודרת.';
  const rule = { anchor: 'סעיף י', to: '/target/', enabled: true };
  const html = transformSeo(shell('<p>' + quote + '</p>'), '/source/', state({}, { rules: [rule] }));
  assert.match(html, /סעיף יב תחילה ואחר כך <a href="\/target\/">סעיף י<\/a>/);
});
