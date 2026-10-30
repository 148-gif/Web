import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectStaging } from '../server/staging-smoke.mjs';
import { main } from '../scripts/smoke-cpanel.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/smoke-cpanel.mjs', import.meta.url));
const HTML = '<!doctype html><html><head><title>Staging</title><meta name="robots" content="noindex, nofollow"></head><body>PRIVATE-PAGE-CONTENT</body></html>';
const hasFinding = (report, code) => report.checks.some((check) => check.observations.some((entry) => entry.findings.some((problem) => problem.code === code)));

async function site(t, { disallow = false, external = 'https://elsewhere.example.test/' } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    if (path === '/disconnect') { request.socket.destroy(); return; }
    if (path === '/timeout') return;
    if (path === '/body-timeout') { response.setHeader('Content-Type', 'text/html'); response.write('<html><head>'); return; }
    if (path === '/robots.txt') { response.setHeader('Content-Type', 'text/plain'); response.end(`User-agent: *\n${disallow ? 'Disallow: /' : 'Allow: /\nDisallow:'}\n`); return; }
    if (path === '/redirect' || path === '/redirect-no-header' || path === '/external' || path === '/credentials' || path === '/loop') {
      if (path === '/redirect-no-header') response.removeHeader('X-Robots-Tag');
      response.statusCode = 302;
      response.setHeader('Location', path === '/external' ? external : path === '/credentials' ? `http://DO-NOT-RETURN:PRIVATE-PASSWORD@127.0.0.1:${server.address().port}/` : path === '/loop' ? '/loop' : '/');
      response.end(); return;
    }
    if (path === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end('body { color: red; }'); return; }
    if (path === '/manual.pdf' || path === '/missing-header.pdf') {
      if (path === '/missing-header.pdf') response.removeHeader('X-Robots-Tag');
      response.setHeader('Content-Type', 'application/pdf'); response.end('%PDF-1.7\n' + 'binary-private-data'.repeat(60000)); return;
    }
    if (path === '/not-found') { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/scoped') response.setHeader('X-Robots-Tag', 'googlebot: noindex, nofollow');
    if (path === '/no-nofollow') response.setHeader('X-Robots-Tag', 'noindex');
    if (path === '/large-head') { response.end(`<html><head>${' '.repeat(8192)}<meta name="robots" content="noindex,nofollow"></head></html>`); return; }
    if (path === '/missing-meta') { response.end('<html><head><title>PRIVATE-PAGE-CONTENT</title></head><body></body></html>'); return; }
    if (path === '/counterfeit') {
      response.end('<html><head><!-- <meta name="robots" content="noindex,nofollow"> --><script>const text = \'<meta name="robots" content="noindex,nofollow">\';</script><title><meta name="robots" content="noindex,nofollow"></title></head></html>'); return;
    }
    if (path === '/head-only') {
      response.end('<html><head><meta content="a > b </head>" name="description"><meta CONTENT="noindex,&#110;ofollow" NAME="ROBOTS"></head><body>' + 'LARGE-PRIVATE-BODY'.repeat(60000)); return;
    }
    response.end(HTML);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('staging checks HTML, CSS and PDF noindex headers without storing contents or sending credentials', async (t) => {
  const { origin, requests } = await site(t);
  const report = await inspectStaging({ origin, paths: ['/', '/style.css', '/manual.pdf'], checkRobots: true, maxBodyBytes: 512 });
  assert.equal(report.ok, true);
  assert.equal(report.readOnly, true);
  assert.deepEqual(report.checks.map((check) => check.path), ['/', '/style.css', '/manual.pdf', '/robots.txt']);
  assert.ok(report.checks.every((check) => check.observations[0].header.noindex && check.observations[0].header.nofollow));
  assert.deepEqual(report.checks[0].observations[0].meta, { noindex: true, nofollow: true });
  assert.equal(report.checks[2].observations[0].inspectedBytes, 0, 'PDF bodies are canceled after headers');
  assert.equal(report.checks[3].observations[0].crawlingAllowed, true);
  assert.ok(!JSON.stringify(report).includes('PRIVATE-PAGE-CONTENT') && !JSON.stringify(report).includes('binary-private-data'));
  assert.ok(requests.every((request) => request.method === 'GET' && !request.authorization && !request.cookie));
});

test('missing headers on PDF/static responses and crawler-scoped headers fail the check', async (t) => {
  const { origin } = await site(t);
  const report = await inspectStaging({ origin, paths: ['/missing-header.pdf', '/scoped', '/no-nofollow'] });
  assert.equal(report.ok, false);
  assert.ok(report.checks.every((check) => !check.ok));
  assert.ok(hasFinding(report, 'missing-robots-header'));
  assert.equal(report.checks[1].observations[0].header.noindex, false, 'googlebot-only directives do not cover all crawlers');
});

test('HTML backup metadata must be real and within the head; large bodies need not be downloaded', async (t) => {
  const { origin } = await site(t);
  const report = await inspectStaging({ origin, paths: ['/missing-meta', '/counterfeit', '/head-only'], maxBodyBytes: 512 });
  assert.equal(report.checks[0].ok, false);
  assert.equal(report.checks[1].ok, false, 'comments, script and title contents cannot counterfeit a meta tag');
  assert.equal(report.checks[2].ok, true);
  assert.ok(hasFinding(report, 'missing-robots-meta'));
  assert.ok(report.checks[2].observations[0].inspectedBytes <= 512);
  assert.ok(!JSON.stringify(report).includes('LARGE-PRIVATE-BODY'));
});

test('same-origin redirects are checked while cross-origin and credential redirects are never followed', async (t) => {
  const elsewhere = await site(t);
  const { origin } = await site(t, { external: elsewhere.origin + '/' });
  const report = await inspectStaging({ origin, paths: ['/redirect', '/external', '/credentials', '/redirect-no-header'] });
  assert.equal(report.checks[0].ok, true);
  assert.deepEqual(report.checks[0].observations.map((entry) => entry.status), [302, 200]);
  assert.equal(report.checks[1].ok, false);
  assert.equal(report.checks[2].ok, false);
  assert.equal(report.checks[3].ok, false, 'redirect response headers are checked too');
  assert.ok(hasFinding(report, 'cross-origin-redirect'));
  assert.equal(elsewhere.requests.length, 0);
  assert.ok(!JSON.stringify(report).includes('DO-NOT-RETURN') && !JSON.stringify(report).includes('PRIVATE-PASSWORD'));
});

test('body limits, request timeouts, bad status and redirect loops produce bounded findings', async (t) => {
  const { origin } = await site(t);
  const report = await inspectStaging({ origin, paths: ['/large-head', '/timeout', '/body-timeout', '/not-found', '/loop', '/disconnect'], timeoutMs: 300, maxBodyBytes: 256 });
  assert.equal(report.ok, false);
  for (const code of ['body-limit', 'timeout', 'http-status', 'redirect-loop', 'request-failed']) assert.ok(hasFinding(report, code), code);
  assert.ok(report.checks.every((check) => check.observations.length <= 4));
  assert.ok(JSON.stringify(report).length < 10000);
});

test('robots Disallow is not treated as indexing protection and blocks the optional crawler check', async (t) => {
  const { origin } = await site(t, { disallow: true });
  const report = await inspectStaging({ origin, paths: ['/'], checkRobots: true });
  assert.equal(report.checks[0].ok, true);
  assert.equal(report.ok, false);
  assert.ok(hasFinding(report, 'robots-disallow'));
});

test('staging tool rejects unsafe targets and unbounded settings before making any request', async (t) => {
  const { origin, requests } = await site(t);
  for (const options of [
    {}, { origin: 'http://public.example' }, { origin: 'https://user:secret@example.test' }, { origin: 'https://example.test/subpath' },
    { origin, paths: ['//other.example/'] }, { origin, paths: ['/a\\b'] }, { origin, paths: ['/a#fragment'] }, { origin, paths: [] },
    { origin, paths: Array(33).fill('/') }, { origin, timeoutMs: 0 }, { origin, timeoutMs: Infinity }, { origin, maxBodyBytes: 2 ** 32 },
  ]) await assert.rejects(inspectStaging(options), TypeError);
  assert.equal(requests.length, 0);
});

test('CLI accepts repeated paths and returns a summary with failure exit code 2', async (t) => {
  const { origin } = await site(t);
  let output = '';
  assert.equal(await main(['--origin', origin, '--path', '/', '--path', '/manual.pdf', '--check-robots'], (text) => { output += text; }), 0);
  assert.equal(JSON.parse(output).checks.length, 3);
  await assert.rejects(run(process.execPath, [script, '--origin', origin, '--path', '/missing-header.pdf']), (error) => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stdout).ok, false);
    assert.equal(error.stderr, '');
    return true;
  });
  await assert.rejects(main(['--path', '/']), /--origin is required/);
  await assert.rejects(main(['--origin', origin, '--origin', origin]), /Repeated option/);
  await assert.rejects(main(['--origin', origin, '--timeout-ms', '1e6']), /positive integers/);
});
