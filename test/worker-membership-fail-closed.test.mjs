import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeSession, sha256 } from '../cms-worker/worker.mjs';

const email = 'revoked@example.test', origin = 'https://site.example';

async function world(t, modern, legacy = JSON.stringify([email])) {
  const state = { legacyReads: 0, schemaCalls: 0, logCalls: 0 };
  const env = {
    ALLOWED_ORIGIN: origin, SESSION_SECRET: 'local-membership-test-signing-key', GOOGLE_CLIENT_ID: 'test-client', OWNERS: '',
    RATE_LIMIT_STORE: async () => true,
    DATA_STORE: {
      async ensureSchema() { state.schemaCalls++; },
      async appendLog() { state.logCalls++; },
    },
    EDITORS: { async get(key) {
      if (key === 'people') {
        if (modern instanceof Error) throw modern;
        return modern;
      }
      if (key === 'editors') {
        state.legacyReads++;
        if (legacy instanceof Error) throw legacy;
        return legacy;
      }
      return null;
    } },
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).startsWith('https://oauth2.googleapis.com/tokeninfo?access_token='));
    return Response.json({ aud: env.GOOGLE_CLIENT_ID, email, email_verified: 'true', expires_in: '3000' });
  });
  const token = await makeSession(email, env);
  const request = (login) => new Request(`https://worker.example${login ? '/session' : '/me'}`, {
    method: login ? 'POST' : 'GET',
    headers: { Origin: origin, ...(login ? {} : { Authorization: `Bearer ${token}` }) },
    ...(login ? { body: JSON.stringify({ access_token: 'local-test-access-token' }) } : {}),
  });
  return { env, state, call: (login) => worker.fetch(request(login), env) };
}

for (const [name, modern] of [
  ['lookup failure', new Error('private backing-store failure')],
  ['malformed JSON', '{private-invalid-json'],
  ['empty stored text', ''],
  ['JSON false', 'false'],
  ['JSON zero', '0'],
  ['JSON empty string', '""'],
  ['JSON object', '{}'],
]) {
  test(`modern membership ${name} cannot grant access through an obsolete legacy record`, async (t) => {
    const w = await world(t, modern);
    for (const login of [false, true]) {
      const response = await w.call(login);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { message: 'שגיאה בשרת העריכה' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    assert.deepEqual(w.state, { legacyReads: 0, schemaCalls: 0, logCalls: 0 });
  });
}

for (const [name, modern] of [['missing', null], ['undefined', undefined], ['JSON null', 'null']]) {
  test(`${name} modern membership preserves supported legacy sign-in and session checks`, async (t) => {
    const w = await world(t, modern);
    const session = await w.call(false);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).email, email);
    const login = await w.call(true);
    assert.equal(login.status, 200);
    assert.equal(typeof (await login.json()).token, 'string');
    assert.ok(w.state.legacyReads > 0);
    assert.equal(w.state.logCalls, 1);
  });
}

test('an authoritative empty modern list denies the obsolete legacy account', async (t) => {
  const w = await world(t, '[]');
  assert.equal((await w.call(false)).status, 401);
  assert.equal((await w.call(true)).status, 403);
  assert.deepEqual(w.state, { legacyReads: 0, schemaCalls: 0, logCalls: 0 });
});

for (const [name, legacy] of [['lookup failure', new Error('private legacy failure')], ['malformed JSON', '{broken'], ['invalid JSON type', 'false']]) {
  test(`an absent modern record does not hide a legacy ${name}`, async (t) => {
    const w = await world(t, null, legacy);
    for (const login of [false, true]) {
      const response = await w.call(login);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { message: 'שגיאה בשרת העריכה' });
    }
    assert.equal(w.state.schemaCalls, 0);
    assert.equal(w.state.logCalls, 0);
  });
}

test('valid modern membership and roles remain independent of a failed legacy lookup', async (t) => {
  const w = await world(t, JSON.stringify([{ email, name: 'Current editor', publisher: true }]), new Error('obsolete legacy storage unavailable'));
  for (const login of [false, true]) {
    const response = await w.call(login);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.name, 'Current editor');
    assert.equal(body.publisher, true);
  }
  assert.equal(w.state.legacyReads, 0);
});

for (const [name, value] of [['lookup failure', new Error('cosmetic names unavailable')], ['malformed JSON', '{broken']]) {
  test(`an authorized owner retains the cosmetic display-name fallback on ${name}`, async (t) => {
    const w = await world(t, '[]');
    w.env.OWNERS = await sha256(email);
    const get = w.env.EDITORS.get;
    w.env.EDITORS.get = async (key) => {
      if (key === 'owner-names') {
        if (value instanceof Error) throw value;
        return value;
      }
      return get(key);
    };
    for (const login of [false, true]) {
      const response = await w.call(login);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.owner, true);
      assert.equal(body.name, '');
    }
    assert.equal(w.state.legacyReads, 0);
    let writes = 0;
    w.env.EDITORS.put = async () => { writes++; };
    const token = await makeSession(email, w.env), logsBefore = w.state.logCalls;
    const mutation = await worker.fetch(new Request('https://worker.example/me', {
      method: 'PUT', headers: { Origin: origin, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Changed owner name' }),
    }), w.env);
    assert.equal(mutation.status, 500);
    assert.deepEqual(await mutation.json(), { message: 'שגיאה בשרת העריכה' });
    assert.equal(writes, 0);
    assert.equal(w.state.logCalls, logsBefore);
  });
}
