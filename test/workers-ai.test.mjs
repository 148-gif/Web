import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkersAi, WorkersAiConfigurationError, WorkersAiRequestError, WORKERS_AI_ACCOUNT_ID, WORKERS_AI_MODEL, WORKERS_AI_PROVIDER } from '../server/workers-ai.mjs';
import worker, { makeSession, slugFor } from '../cms-worker/worker.mjs';
import { createD1DataStore } from '../cms-worker/data-store.mjs';
import { makeD1 } from './helpers/d1.mjs';

const TOKEN = 'fixture-only-workers-ai-token-not-a-real-key';
const SETTINGS = { CMS_AI_PROVIDER: WORKERS_AI_PROVIDER, CLOUDFLARE_AI_ACCOUNT_ID: WORKERS_AI_ACCOUNT_ID, CLOUDFLARE_AI_API_TOKEN: TOKEN };
const INPUT = { text: 'נושא חדש', source_lang: 'he', target_lang: 'en' };
const success = (translated_text = 'A new topic') => Response.json({ success: true, errors: [], result: { translated_text } });
const generic = (error) => {
  assert.ok(error instanceof WorkersAiRequestError);
  assert.equal(error.message, 'Workers AI request failed');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(TOKEN), false);
  return true;
};

test('AI is disabled by default and never discovers deployment tokens or contacts a provider on construction', () => {
  const values = {};
  Object.defineProperty(values, 'CLOUDFLARE_API_TOKEN', { get() { throw new Error('Deployment credentials must not be read'); } });
  const transport = { fetchImpl: () => { throw new Error('Construction must not call a provider'); } };
  assert.equal(createWorkersAi(values, transport), undefined);
  assert.equal(createWorkersAi({ ...values, CMS_AI_PROVIDER: 'disabled' }, transport), undefined);
  const ai = createWorkersAi(SETTINGS, transport);
  assert.equal(typeof ai.run, 'function');
  assert.equal(JSON.stringify(ai), '{}');
  assert.ok(Object.isFrozen(ai));
});

test('partial or unsupported AI settings fail without echoing their values', () => {
  for (const values of [
    null, [], { CMS_AI_PROVIDER: null }, { CMS_AI_PROVIDER: '' }, { CMS_AI_PROVIDER: 'another-provider' },
    { CLOUDFLARE_AI_ACCOUNT_ID: WORKERS_AI_ACCOUNT_ID }, { CLOUDFLARE_AI_API_TOKEN: TOKEN },
    { ...SETTINGS, CMS_AI_PROVIDER: 'disabled' }, { CMS_AI_PROVIDER: WORKERS_AI_PROVIDER },
    { ...SETTINGS, CLOUDFLARE_AI_ACCOUNT_ID: undefined }, { ...SETTINGS, CLOUDFLARE_AI_ACCOUNT_ID: '0'.repeat(32) },
    { ...SETTINGS, CLOUDFLARE_AI_API_TOKEN: undefined, CLOUDFLARE_API_TOKEN: TOKEN },
    ...['', ' ', 'short', 'x'.repeat(513), TOKEN + '\r\nX-Secret: test', TOKEN + ' '].map((token) => ({ ...SETTINGS, CLOUDFLARE_AI_API_TOKEN: token })),
  ]) assert.throws(() => createWorkersAi(values), (error) => error instanceof WorkersAiConfigurationError && !error.message.includes(TOKEN) && !error.message.includes('another-provider'));
});

test('the adapter sends one bounded request only to the approved account/model and hides its private settings', async () => {
  let calls = 0;
  const ai = createWorkersAi(SETTINGS, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${WORKERS_AI_ACCOUNT_ID}/ai/run/${WORKERS_AI_MODEL}`);
    assert.equal(new URL(url).search, '');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), INPUT);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ success: true, errors: [], messages: [TOKEN], result: { translated_text: 'A new topic', private_metadata: TOKEN } });
  } });
  assert.deepEqual(await ai.run(WORKERS_AI_MODEL, INPUT), { translated_text: 'A new topic' });
  assert.equal(calls, 1);
});

test('model, language, extra options and text limits are enforced before any provider call', async () => {
  let calls = 0;
  const ai = createWorkersAi(SETTINGS, { fetchImpl: async () => { calls++; return success(); } });
  for (const [model, input] of [
    ['@cf/another-model', INPUT], [WORKERS_AI_MODEL + '?other=1', INPUT], ['https://example.test', INPUT],
    [WORKERS_AI_MODEL, null], [WORKERS_AI_MODEL, []], [WORKERS_AI_MODEL, { ...INPUT, stream: true }],
    [WORKERS_AI_MODEL, { ...INPUT, source_lang: 'en' }], [WORKERS_AI_MODEL, { ...INPUT, target_lang: 'fr' }],
    ...['', '   ', 'א'.repeat(81), '\ud800', 123].map((text) => [WORKERS_AI_MODEL, { ...INPUT, text }]),
  ]) await assert.rejects(ai.run(model, input), generic);
  assert.equal(calls, 0);
  assert.deepEqual(await ai.run(WORKERS_AI_MODEL, { ...INPUT, text: '😀'.repeat(40) }), { translated_text: 'A new topic' });
  assert.equal(calls, 1);
});

test('provider failures, redirects and malformed JSON have one generic error and no retries', async () => {
  for (const response of [
    () => new Response(TOKEN, { status: 302, headers: { Location: 'https://untrusted.example' } }),
    () => new Response(TOKEN, { status: 401 }), () => new Response(TOKEN, { status: 429 }),
    () => new Response(TOKEN, { status: 500 }), () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    () => { throw new Error(TOKEN); },
  ]) {
    let calls = 0;
    const ai = createWorkersAi(SETTINGS, { fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(ai.run(WORKERS_AI_MODEL, INPUT), generic);
    assert.equal(calls, 1);
  }
});

test('response size is checked while streaming even without a trustworthy content length', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '999999999' }]) {
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(8192)); },
      cancel() { canceled = true; },
    });
    const ai = createWorkersAi(SETTINGS, { fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json', ...headers } }) });
    await assert.rejects(ai.run(WORKERS_AI_MODEL, INPUT), generic);
    assert.equal(canceled, true);
  }
});

test('only a bounded successful translation is exposed from the provider envelope', async () => {
  for (const envelope of [
    null, [], {}, { success: false, result: { translated_text: 'looks valid' } },
    { success: true, errors: [{ message: TOKEN }], result: { translated_text: 'looks valid' } },
    { success: true, errors: {}, result: { translated_text: 'looks valid' } },
    { success: true, result: [] },
    ...[undefined, 123, '', ' ', '\ud800', 'x'.repeat(2049), 'א'.repeat(2048) + 'x', '€'.repeat(2048)].map((translated_text) => ({ success: true, result: { translated_text } })),
  ]) {
    const ai = createWorkersAi(SETTINGS, { fetchImpl: async () => Response.json(envelope) });
    await assert.rejects(ai.run(WORKERS_AI_MODEL, INPUT), generic);
  }
  const ai = createWorkersAi(SETTINGS, { fetchImpl: async () => success('א'.repeat(2048)) });
  assert.equal((await ai.run(WORKERS_AI_MODEL, INPUT)).translated_text.length, 2048);
});

test('timeout aborts stalled headers without waiting for a transport that ignores abort', async () => {
  let signal;
  const ai = createWorkersAi(SETTINGS, { timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(ai.run(WORKERS_AI_MODEL, INPUT), generic);
  assert.equal(signal.aborted, true);
});

test('timeout covers a stalled response body and does not wait for upstream cancellation', async () => {
  let signal, canceled = false;
  const body = new ReadableStream({ pull() {}, cancel() { canceled = true; return new Promise(() => {}); } });
  const ai = createWorkersAi(SETTINGS, { timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  } });
  await assert.rejects(ai.run(WORKERS_AI_MODEL, INPUT), generic);
  assert.equal(signal.aborted, true);
  assert.equal(canceled, true);
});

test('the existing glossary and denied quota never call the adapter; failures still return no slug', async () => {
  let calls = 0;
  const env = { AI: createWorkersAi(SETTINGS, { fetchImpl: async () => { calls++; throw new Error(TOKEN); } }) };
  assert.equal((await slugFor(env, 'ברסלב', () => { throw new Error('Glossary is free'); })).source, 'glossary');
  assert.deepEqual(await slugFor(env, INPUT.text, async () => false), { slug: null, limited: true });
  assert.equal(calls, 0);
  assert.deepEqual(await slugFor(env, INPUT.text, async () => true), { slug: null });
  assert.equal(calls, 1);
});

test('the authenticated translate route reserves its database quota before the Node provider call', async (t) => {
  const db = makeD1(), store = createD1DataStore(db), email = 'editor@example.test';
  t.after(() => db.raw.close());
  let calls = 0;
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', SESSION_SECRET: 'local-ai-route-signing-key', OWNERS: '',
    DATA_STORE: store, RATE_LIMIT_STORE: async () => true, TRANSLATE_PER_USER: 1, TRANSLATE_PER_DAY: 1,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email, name: 'Editor', publisher: false }]) : null },
    AI: createWorkersAi(SETTINGS, { fetchImpl: async () => {
      calls++;
      assert.equal(db.raw.prepare('SELECT n FROM ai_usage WHERE email = ?').get(email).n, 1);
      return success();
    } }),
  };
  const token = await makeSession(email, env);
  const translate = async (text) => {
    const response = await worker.fetch(new Request('https://api.example/translate', {
      method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}` }, body: JSON.stringify({ text }),
    }), env);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await translate('ברסלב')).source, 'glossary');
  assert.equal(calls, 0);
  assert.equal((await translate(INPUT.text)).slug, 'new-topic');
  assert.deepEqual(await translate('נושא אחר'), { slug: null, limited: true });
  assert.equal(calls, 1);
});
