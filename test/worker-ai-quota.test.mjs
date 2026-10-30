import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';

const EMAILS = ['one@example.test', 'two@example.test', 'three@example.test'];
const NOW = Date.UTC(2026, 9, 30, 23, 59, 59);
const DAY = '2026-10-30';
const barrier = (count) => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return async () => { if (--count === 0) release(); await ready; };
};

async function world(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = makeD1(), state = { calls: 0, claims: 0, beforeClaim: null, failClaim: false, failAI: false };
  t.after(() => db.raw.close());
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Translation tests must not make network requests'); });
  const original = db.prepare;
  db.prepare = (sql) => {
    const statement = original(sql);
    if (!sql.startsWith('INSERT INTO ai_usage')) return statement;
    return { ...statement, bind(...args) {
      const bound = statement.bind(...args);
      return { ...bound, async first() {
        state.claims++;
        if (state.beforeClaim) await state.beforeClaim();
        if (state.failClaim) throw new Error('simulated quota database failure');
        return bound.first();
      } };
    } };
  };
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', SESSION_SECRET: 'local-signing-test', DB: db,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify(EMAILS.map((email) => ({ email, name: email, publisher: false }))) : null },
    AI: { run: async () => {
      state.calls++;
      if (state.failAI) throw new Error('simulated model failure');
      return { translated_text: 'Community Times' };
    } },
    ...options,
  };
  const tokens = await Promise.all(EMAILS.map((email) => makeSession(email, env)));
  const api = async (path, user = 0, body) => {
    const response = await worker.fetch(new Request(`https://worker.example${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${tokens[user]}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await api('/me')).status, 200);
  const ask = (user = 0, text = 'זמני הקהילה') => api('/translate', user, { text });
  const rows = () => db.raw.prepare('SELECT day, email, n FROM ai_usage ORDER BY day, email').all();
  const seed = (user, n, day = DAY) => db.raw.prepare('INSERT INTO ai_usage (day, email, n) VALUES (?, ?, ?)').run(day, EMAILS[user], n);
  return { env, db, state, ask, rows, seed };
}

test('concurrent calls by one editor can claim its last daily allowance only once', { timeout: 2000 }, async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: '2', TRANSLATE_PER_DAY: '10' });
  w.seed(0, 1);
  w.state.beforeClaim = barrier(2);
  const responses = await Promise.all([w.ask(), w.ask()]);
  assert.equal(responses.filter((r) => r.body.source === 'ai').length, 1);
  assert.equal(responses.filter((r) => r.body.limited === true).length, 1);
  assert.equal(w.state.calls, 1);
  assert.deepEqual(w.rows().map((r) => r.n), [2]);
});

for (const sameUser of [false, true]) {
  test(`concurrent calls have only one winner for the site-wide last allowance (same editor: ${sameUser})`, { timeout: 2000 }, async (t) => {
    const w = await world(t, { TRANSLATE_PER_USER: 5, TRANSLATE_PER_DAY: 2 });
    w.seed(2, 1);
    w.state.beforeClaim = barrier(2);
    const responses = await Promise.all([w.ask(0), w.ask(sameUser ? 0 : 1)]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal(responses.filter((r) => r.body.limited === true).length, 1);
    assert.equal(responses.filter((r) => r.body.source === 'ai').length, 1);
    assert.equal(w.state.calls, 1);
    assert.equal(w.rows().reduce((n, r) => n + r.n, 0), 2);
    const before = w.rows();
    assert.equal((await w.ask(1)).body.limited, true);
    assert.deepEqual(w.rows(), before, 'denial must not insert a zero row or grow a counter');
    assert.equal(w.state.calls, 1);
  });
}

test('missing configuration retains the 100-call daily default per editor', async (t) => {
  const w = await world(t);
  w.seed(0, 99);
  assert.equal((await w.ask()).body.source, 'ai');
  assert.equal((await w.ask()).body.limited, true);
  assert.deepEqual(w.rows().map((r) => r.n), [100]);
  assert.equal(w.state.calls, 1);
});

test('missing global configuration retains the 300-call site-wide daily default', async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: '1000' });
  w.seed(0, 299);
  assert.equal((await w.ask(1)).body.source, 'ai');
  assert.equal((await w.ask(2)).body.limited, true);
  assert.equal(w.rows().reduce((n, r) => n + r.n, 0), 300);
  assert.equal(w.state.calls, 1);
});

for (const setting of ['TRANSLATE_PER_USER', 'TRANSLATE_PER_DAY']) {
  test(`invalid ${setting} configurations fail closed without model calls or counters`, async (t) => {
    const w = await world(t);
    for (const value of [0, -1, 1.5, Infinity, 'Infinity', Number.MAX_SAFE_INTEGER, 10001, true, 'bad', '', null]) {
      w.env[setting] = value;
      const response = await w.ask();
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { slug: null, limited: true }, String(value));
    }
    assert.equal(w.state.calls, 0);
    assert.equal(w.state.claims, 0);
    assert.equal(w.rows().length, 0);
    w.env[setting] = '2';
    assert.equal((await w.ask()).body.source, 'ai', 'correcting configuration re-enables valid claims');
    assert.equal(w.state.calls, 1);
  });
}

test('valid integer configuration includes the explicit 10,000-call maximum', async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: '10000', TRANSLATE_PER_DAY: 10000 });
  w.seed(0, 9999);
  assert.equal((await w.ask()).body.source, 'ai');
  assert.equal((await w.ask()).body.limited, true);
  assert.deepEqual(w.rows().map((r) => r.n), [10000]);
});

test('glossary terms and empty input remain free even after the budget is exhausted', async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: 1, TRANSLATE_PER_DAY: 1 });
  w.seed(0, 1);
  assert.equal((await w.ask(0, 'ברסלב')).body.source, 'glossary');
  assert.deepEqual((await w.ask(0, '  ')).body, { slug: null });
  assert.equal(w.state.calls, 0);
  assert.equal(w.state.claims, 0);
  assert.deepEqual(w.rows().map((r) => r.n), [1]);
});

test('an absent AI binding uses the fallback without consuming any budget', async (t) => {
  const w = await world(t, { AI: undefined });
  assert.deepEqual((await w.ask()).body, { slug: null });
  assert.equal((await w.ask(0, 'ברסלב')).body.source, 'glossary');
  assert.equal(w.state.claims, 0);
  assert.equal(w.rows().length, 0);
});

test('quota database failures do not call the model or consume budget, and a retry can succeed', async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: 1, TRANSLATE_PER_DAY: 1 });
  w.state.failClaim = true;
  assert.equal((await w.ask()).status, 500);
  assert.equal(w.state.calls, 0);
  assert.equal(w.rows().length, 0);
  w.state.failClaim = false;
  assert.equal((await w.ask()).body.source, 'ai');
  assert.deepEqual(w.rows().map((r) => r.n), [1]);
});

test('an attempted model call remains counted when the provider fails', async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: 1, TRANSLATE_PER_DAY: 1 });
  w.state.failAI = true;
  assert.deepEqual((await w.ask()).body, { slug: null });
  w.state.failAI = false;
  assert.equal((await w.ask()).body.limited, true);
  assert.equal(w.state.calls, 1);
  assert.deepEqual(w.rows().map((r) => r.n), [1]);
});

test('the next UTC day has fresh counters while the prior day stays recorded', async (t) => {
  const w = await world(t, { TRANSLATE_PER_USER: 1, TRANSLATE_PER_DAY: 1 });
  assert.equal((await w.ask()).body.source, 'ai');
  assert.equal((await w.ask()).body.limited, true);
  t.mock.timers.setTime(NOW + 2000);
  assert.equal((await w.ask()).body.source, 'ai');
  assert.deepEqual(w.rows().map((r) => ({ day: r.day, n: r.n })), [{ day: '2026-10-30', n: 1 }, { day: '2026-10-31', n: 1 }]);
  assert.equal(w.state.calls, 2);
});
