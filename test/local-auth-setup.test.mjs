import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { initializeLocalAuthSchema, runLocalAuthSetup } from '../scripts/setup-local-auth.mjs';
import { renderAuthSetup } from '../server/auth-setup.mjs';
import { passwordAcceptable } from '../server/local-auth-crypto.mjs';

test('local auth setup defaults to a credential-free dry plan with no database connection', async () => {
  let calls = 0;
  const report = await runLocalAuthSetup([], { values: new Proxy({}, { get() { throw new Error('must not inspect credentials'); } }), poolFactory() { calls++; throw new Error('must not connect'); } });
  assert.equal(calls, 0); assert.equal(report.apply, false); assert.equal(report.databaseConnected, false); assert.equal(report.schemaInitialized, false);
  assert.equal(report.createsPasswordsOrBootstrapCredentials, false);
  assert.equal(report.modifiesExistingTables, false); assert.equal(report.additiveTables.length, 3);
  assert.match(report.schemaSha256, /^[a-f0-9]{64}$/);
});

test('local auth setup rejects unreviewed hash, mismatched target and unknown flags before connection', async () => {
  const plan = await initializeLocalAuthSchema(null); let calls = 0;
  const dependencies = { values: { MYSQL_DATABASE: 'expected' }, poolFactory() { calls++; throw new Error('must not connect'); } };
  for (const args of [
    ['--apply', '--database', 'expected', '--schema-sha256', '0'.repeat(64)],
    ['--apply', '--database', 'different', '--schema-sha256', plan.schemaSha256],
    ['--apply', '--apply'], ['--force'], ['--database', 'expected'],
  ]) await assert.rejects(runLocalAuthSetup(args, dependencies));
  assert.equal(calls, 0);
});

// Execute the rendered script, including its real submit handler, against an
// isolated DOM stub. All credentials are deliberately fake; no DB is touched.
function setupForm(fetchImpl = async () => ({ status: 400, json: async () => ({ message: 'בדקו את הפרטים.' }) })) {
  const elements = new Map(), posts = [];
  let focused, onSubmit;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: true, disabled: id === 'setup-submit', attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      focus() { focused = id; },
      addEventListener(type, handler) { if (type === 'submit') onSubmit = handler; },
      reset() { for (const entry of elements.values()) entry.value = ''; },
    });
    return elements.get(id);
  }
  const html = renderAuthSetup({ apiBasePath: '/cms-api', nonce: 'fixture-setup-nonce-32-characters' });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  runInNewContext(script, {
    document: { getElementById: element }, TextEncoder,
    fetch(url, options) { posts.push({ url, options }); return fetchImpl(url, options); },
  });
  const values = { code: 'Q'.repeat(43), user: 'fixture-admin', name: 'מנהל בדיקה', password: 'Only fake test password 123!', confirm: 'Only fake test password 123!' };
  for (const [key, value] of Object.entries(values)) element(`setup-${key}`).value = value;
  return { html, element, posts, values, focused: () => focused, submit: () => onSubmit({ preventDefault() {} }) };
}

test('setup renderer keeps a disabled explicit POST fallback and accessible field guidance', () => {
  const { html } = setupForm();
  assert.match(html, /<form id="setup-form" method="post" action="\/cms-api\/auth\/bootstrap">/);
  assert.match(html, /<button id="setup-submit" type="submit" disabled>/);
  assert.match(html, /id="setup-user"[^>]*aria-describedby="username-help username-error"/);
  assert.match(html, /id="setup-password"[^>]*maxlength="256"/);
  assert.match(html, /id="setup-name"[^>]*maxlength="80"/);
  assert.match(html, /אין להזין כתובת דוא״ל או @/);
});

test('invalid username is focused and prevents submission without erasing setup credentials', async () => {
  for (const username of ['test@example.invalid', 'ab', '.admin', 'משתמש']) {
    const fixture = setupForm(); fixture.element('setup-user').value = username;
    await fixture.submit();
    assert.equal(fixture.posts.length, 0);
    assert.equal(fixture.focused(), 'setup-user');
    assert.equal(fixture.element('setup-user').attributes['aria-invalid'], 'true');
    assert.match(fixture.element('username-error').textContent, /3–64/);
    assert.equal(fixture.element('setup-code').value, fixture.values.code);
    assert.equal(fixture.element('setup-password').value, fixture.values.password);
    assert.equal(fixture.element('setup-confirm').value, fixture.values.confirm);
    assert.match(fixture.element('setup-error').textContent, /לא נשלחו/);
  }
});

test('empty code, invalid display names and mismatched confirmation fail before fetch', async () => {
  for (const [id, value, focus] of [
    ['setup-code', ' ', 'setup-code'], ['setup-name', ' ', 'setup-name'],
    ['setup-name', 'שם\u0001', 'setup-name'], ['setup-name', '<שם>', 'setup-name'],
    ['setup-name', 'ש'.repeat(41), 'setup-name'], ['setup-name', '\ud800', 'setup-name'],
    ['setup-confirm', 'A different fake password', 'setup-confirm'],
  ]) {
    const fixture = setupForm(); fixture.element(id).value = value;
    await fixture.submit();
    assert.equal(fixture.posts.length, 0); assert.equal(fixture.focused(), focus);
    assert.equal(fixture.element('setup-password').value, fixture.values.password);
  }
});

test('client password validation matches server codepoint, byte and well-formed limits', async () => {
  for (const password of ['a'.repeat(14), 'a'.repeat(15), 'a'.repeat(128), 'a'.repeat(129), '🔐'.repeat(14), '🔐'.repeat(15), '🔐'.repeat(128), '🔐'.repeat(129), 'a'.repeat(20) + '\ud800']) {
    const fixture = setupForm();
    fixture.element('setup-password').value = password; fixture.element('setup-confirm').value = password;
    await fixture.submit();
    assert.equal(fixture.posts.length === 1, passwordAcceptable(password));
    if (!passwordAcceptable(password)) {
      assert.equal(fixture.focused(), 'setup-password');
      assert.equal(fixture.element('setup-password').value, password);
    }
  }
});

test('normalization leaves password exact and accepts long Unicode display names', async () => {
  const fixture = setupForm();
  fixture.element('setup-user').value = '  Admin.Name_2-3  ';
  fixture.element('setup-name').value = '  ' + '🗝️'.repeat(20) + '  ';
  await fixture.submit();
  assert.equal(fixture.posts.length, 1);
  const { url, options } = fixture.posts[0];
  assert.equal(url, '/cms-api/auth/bootstrap'); assert.equal(options.method, 'POST');
  const sent = JSON.parse(options.body);
  assert.equal(sent.username, 'admin.name_2-3');
  assert.equal(sent.displayName, '🗝️'.repeat(20));
  assert.equal(sent.password, fixture.values.password); assert.equal(sent.code, fixture.values.code);
});

test('submitted field errors focus the field and clear sensitive inputs with explicit retry instructions', async () => {
  const fixture = setupForm(async () => ({ status: 400, json: async () => ({
    message: 'בדקו את השדות המסומנים ונסו שוב.',
    fieldErrors: { username: 'שם המשתמש אינו תקין.', code: 'Untrusted code error must not appear.' },
  }) }));
  await fixture.submit();
  assert.equal(fixture.posts.length, 1); assert.equal(fixture.focused(), 'setup-user');
  assert.equal(fixture.element('username-error').textContent, 'שם המשתמש אינו תקין.');
  assert.equal(fixture.element('code-error').textContent, '');
  for (const id of ['setup-code', 'setup-password', 'setup-confirm']) assert.equal(fixture.element(id).value, '');
  assert.equal(fixture.element('setup-retry').hidden, false);
  assert.match(fixture.element('setup-retry').textContent, /נמחקו מהטופס/);
  assert.match(fixture.element('setup-retry').textContent, /הקוד המקורי.*בתוקף ולא נוצל/);
  await fixture.submit();
  assert.equal(fixture.posts.length, 1, 'retry without reentering credentials must not submit');
  assert.equal(fixture.focused(), 'setup-code');
});

test('a dispatched network failure clears credentials but a synchronous fetch refusal preserves them', async () => {
  const failed = setupForm(() => Promise.reject(new Error('fixture network failure')));
  await failed.submit();
  assert.equal(failed.element('setup-code').value, '');
  assert.equal(failed.element('setup-password').value, '');
  assert.equal(failed.element('setup-retry').hidden, false);
  assert.match(failed.element('setup-error').textContent, /בדקו אם החשבון נוצר/);
  const refused = setupForm(() => { throw new Error('fixture fetch refused synchronously'); });
  await refused.submit();
  assert.equal(refused.element('setup-code').value, refused.values.code);
  assert.equal(refused.element('setup-password').value, refused.values.password);
  assert.equal(refused.element('setup-retry').hidden, true);
  assert.match(refused.element('setup-error').textContent, /הטופס לא נשלח/);
});

test('successful setup resets secrets, hides the form and focuses success', async () => {
  const fixture = setupForm(async () => ({ status: 201, json: async () => ({ created: true }) }));
  await fixture.submit();
  assert.equal(fixture.posts.length, 1); assert.equal(fixture.element('setup-form').hidden, true);
  assert.equal(fixture.element('setup-password').value, ''); assert.equal(fixture.element('setup-code').value, '');
  assert.equal(fixture.focused(), 'setup-success'); assert.equal(fixture.element('setup-login').hidden, false);
  assert.equal(fixture.element('setup-retry').hidden, true);
});
