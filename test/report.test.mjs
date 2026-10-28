// Unit tests for failure reports (cms-worker/report.mjs and the /report endpoint of cms-worker/worker.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReport, formatReport, throttle, sendMail, deliver, tailLog } from '../cms-worker/report.mjs';
import { handle, makeSession, sha256 } from '../cms-worker/worker.mjs';

const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const mailEnv = (extra = {}) => ({ RESEND_API_KEY: 'rk', REPORT_TO: 'owner@x.y', EDITORS: kv(), ...extra });
const mails = [];
const resend = async (u, opt) => { mails.push({ u, ...opt, body: JSON.parse(opt.body) }); return new Response('{}', { status: 200 }); };

test('cleanReport() keeps a small, flat, text-only report from any input', () => {
  const r = cleanReport({ kind: 'save', where: 'PUT\nx'.repeat(100), message: 'm'.repeat(5000), extra: { a: 1, b: { nested: true }, ['k'.repeat(99)]: 'v' }, evil: '<script>' });
  assert.equal(r.kind, 'save');
  assert.ok(r.where.length <= 200 && !r.where.includes('\n'));
  assert.equal(r.message.length, 1000);
  assert.deepEqual(Object.keys(r.extra).map((k) => k.length), [1, 40]);
  assert.equal(r.extra.a, '1');
  assert.equal(cleanReport({ kind: 'nope' }).kind, 'other');
  for (const junk of [null, 'x', 5, [], undefined]) assert.equal(cleanReport(junk).kind, 'other');
});

test('formatReport() names what failed, who, when and the details', () => {
  const { subject, text } = formatReport(cleanReport({ kind: 'save', where: 'PUT contents/data/uman.json', message: '422 sha mismatch', detail: 'body here', page: 'https://s/admin/#/file/uman.json', extra: { branch: 'live' } }), { source: 'editor', email: 'e@x.y', ua: 'UA/1', at: new Date('2026-10-28T10:00:00Z') });
  assert.match(subject, /^\[היכל הקודש\] כישלון בשמירה: PUT contents\/data\/uman\.json$/);
  for (const part of ['422 sha mismatch', 'e@x.y', 'UA/1', '2026-10-28 12:00:00', 'body here', 'branch: live', 'uman.json']) assert.ok(text.includes(part), part);
  assert.match(formatReport(cleanReport({ kind: 'load', message: 'm' }), { source: 'visitor', suppressed: 3 }).text, /חזר 3 פעמים/);
});

test('throttle() sends the first report, holds repeats for the window, then counts them in the next mail', async () => {
  const env = mailEnv(), r = cleanReport({ kind: 'load', where: 'w', message: 'm' }), t0 = Date.UTC(2026, 9, 28, 10);
  assert.deepEqual(await throttle(env, r, 'visitor', t0), { send: true, suppressed: 0, capNotice: false });
  assert.equal((await throttle(env, r, 'visitor', t0 + 60e3)).send, false);
  assert.equal((await throttle(env, r, 'visitor', t0 + 3600e3)).send, false);
  assert.equal((await throttle(env, cleanReport({ kind: 'load', where: 'other', message: 'm' }), 'visitor', t0 + 60e3)).send, true);
  const again = await throttle(env, r, 'visitor', t0 + 7 * 3600e3); // visitors: 6 hours
  assert.equal(again.send, true);
  assert.equal(again.suppressed, 2);
});

test('throttle() caps visitor reports per day, with one last notice', async () => {
  const env = mailEnv(), t0 = Date.UTC(2026, 9, 28, 10), sent = [];
  for (let i = 0; i < 25; i++) sent.push(await throttle(env, cleanReport({ kind: 'load', where: `w${i}`, message: 'm' }), 'visitor', t0));
  assert.equal(sent.filter((x) => x.send).length, 21);
  assert.equal(sent.filter((x) => x.capNotice).length, 1);
  assert.equal((await throttle(env, cleanReport({ kind: 'load', where: 'w', message: 'm' }), 'editor', t0)).send, true); // editors have their own cap
});

test('sendMail() posts to Resend only when configured, and never throws from deliver()', async () => {
  mails.length = 0;
  assert.deepEqual(await sendMail({}, { subject: 's', text: 't' }, resend), { sent: false, why: 'not configured' });
  assert.equal(mails.length, 0);
  assert.equal((await sendMail(mailEnv({ REPORT_TO: 'a@x.y, b@x.y' }), { subject: 's', text: 't' }, resend)).sent, true);
  assert.equal(mails[0].u, 'https://api.resend.com/emails');
  assert.equal(mails[0].headers.Authorization, 'Bearer rk');
  assert.deepEqual(mails[0].body.to, ['a@x.y', 'b@x.y']);
  const down = async () => { throw new Error('offline'); };
  assert.equal((await deliver(mailEnv(), cleanReport({ kind: 'save', message: 'm' }), { source: 'ci', throttled: false }, down)).sent, false);
});

test('tailLog() strips timestamps and colours, keeps the end and the lines GitHub marked as errors', () => {
  const log = ['2026-10-28T10:00:00.1234567Z start', ...Array.from({ length: 100 }, (_, i) => `2026-10-28T10:00:01.0000000Z \x1b[31mline ${i}\x1b[0m`), '2026-10-28T10:00:02.0000000Z ##[error]Process completed with exit code 1.'].join('\n');
  const { errors, tail } = tailLog(log, 5);
  assert.deepEqual(errors, ['Process completed with exit code 1.']);
  assert.equal(tail.split('\n').length, 5);
  assert.ok(tail.includes('line 99') && !tail.includes('\x1b') && !tail.includes('2026-10-28'));
});

test('/report: editors are named from a verified session, visitors are marked anonymous, others are refused', async () => {
  mails.length = 0;
  const real = globalThis.fetch;
  globalThis.fetch = resend;
  try {
    const env = mailEnv({ GITHUB_TOKEN: 'ghp', OWNERS: await sha256('a@gmail.com'), ALLOWED_ORIGIN: 'https://site.example' });
    const post = (body, headers = {}, origin = 'https://site.example') => handle(new Request('https://w/report', { method: 'POST', headers: { Origin: origin, 'User-Agent': 'UA/9', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);

    let res = await post({ kind: 'save', where: 'PUT x', message: 'boom' }, { Authorization: `Bearer ${await makeSession('a@gmail.com', env)}` });
    assert.equal(res.status, 202);
    assert.match(mails[0].body.text, /עורך מחובר \(מאומת\): a@gmail\.com/);

    res = await post({ kind: 'load', where: 'search', message: 'boom' }, { Authorization: 'Bearer forged.token' });
    assert.equal(res.status, 202);
    assert.match(mails[1].body.text, /גולש באתר \(לא מאומת\)/);
    assert.match(mails[1].body.text, /UA\/9/);

    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('x'.repeat(30000))).status, 413);
    assert.equal((await post({ kind: 'load', message: 'm' }, {}, 'https://evil.example')).status, 403);
    assert.equal(mails.length, 2);

    // without mail settings the endpoint still answers the same and sends nothing
    res = await handle(new Request('https://w/report', { method: 'POST', headers: { Origin: 'https://site.example' }, body: '{"kind":"load","message":"m"}' }), { ...env, RESEND_API_KEY: '' });
    assert.equal(res.status, 202);
    assert.equal(mails.length, 2);
  } finally { globalThis.fetch = real; }
});
