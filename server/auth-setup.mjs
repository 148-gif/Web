// Private setup page. The caller serves it only while an explicit, expiring
// bootstrap capability is armed. No code or secret is placed in the URL.
export function renderAuthSetup({ apiBasePath = '', nonce } = {}) {
  if (typeof apiBasePath !== 'string' || (apiBasePath && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiBasePath))) throw new TypeError('Invalid API base path');
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) throw new TypeError('An explicit CSP nonce is required');
  const endpoint = JSON.stringify(`${apiBasePath}/auth/bootstrap`);
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>הגדרת חשבון מנהל | היכל הקודש</title>
<style nonce="${nonce}">
:root{color-scheme:light;--bg:#fbf8f1;--surface:#fff;--ink:#1a2034;--mute:#5b6378;--line:#e7dcc2;--navy:#0b1d50;--field:#fff;--field-line:#8b8270;--focus:#14337f;--err:#a3201a;--err-bg:#fbeaea;--ok:#1b6b3a;--ok-bg:#e7f4ec;--gold:#e6c466}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#090e1d;--surface:#111933;--ink:#ece6d6;--mute:#a6adc0;--line:#243055;--navy:#2b4fae;--field:#0f1528;--field-line:#647398;--focus:#b4c8f4;--err:#ff9b94;--err-bg:#2d1618;--ok:#6fcf97;--ok-bg:#12281d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 Arial,"Arial Hebrew",sans-serif}main{max-width:560px;margin:40px auto;padding:28px;background:var(--surface);border:1px solid var(--line);border-radius:16px}h1{font-size:1.7rem;line-height:1.3;margin:0 0 12px}.brand{font-weight:700;color:var(--mute);margin:0 0 12px}.lead,.help{color:var(--mute)}.help{font-size:.9rem}label{display:block;font-weight:700;margin:18px 0 6px}input{width:100%;min-width:0;padding:11px 12px;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--field-line);border-radius:8px}button,a{font:inherit}button{width:100%;min-height:46px;margin-top:22px;padding:10px 16px;border:1px solid var(--navy);border-radius:10px;background:var(--navy);color:#fff;cursor:pointer;font-weight:700}button:disabled{opacity:.65;cursor:wait}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}a{color:var(--focus);display:inline-flex;min-height:44px;align-items:center}.message{border-radius:10px;padding:12px 14px;overflow-wrap:anywhere}.message:empty,.field-error:empty{display:none}.field-error{color:var(--err);font-size:.9rem;margin:6px 0}input[aria-invalid="true"]{border-color:var(--err)}.error{color:var(--err);background:var(--err-bg)}.success{color:var(--ok);background:var(--ok-bg)}[hidden]{display:none!important}@media(max-width:600px){main{margin:16px;padding:22px 18px}h1{font-size:1.45rem}}
</style></head><body><main>
<p class="brand">היכל הקודש</p><h1>הגדרת חשבון מנהל</h1><p class="lead">בחרו את פרטי הכניסה שלכם. קוד ההקמה הפרטי תקף לזמן מוגבל ולשימוש אחד.</p>
<form id="setup-form" method="post" action="${apiBasePath}/auth/bootstrap">
<label for="setup-code">קוד ההקמה הפרטי</label><input id="setup-code" name="code" type="password" autocomplete="off" spellcheck="false" dir="ltr" required maxlength="128" aria-describedby="code-help code-error"><p id="code-error" class="field-error"></p><p id="code-help" class="help">הזינו כאן את הקוד שנוצר בלוח האחסון. אין לשלוח קוד או סיסמה בצ׳אט.</p>
<label for="setup-user">שם משתמש</label><input id="setup-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" required minlength="3" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{2,63}" aria-describedby="username-help username-error"><p id="username-error" class="field-error"></p><p id="username-help" class="help">3–64 תווים באנגלית: אותיות, ספרות, נקודה, קו תחתון או מקף. התחילו באות או בספרה. אין להזין כתובת דוא״ל או @. אותיות גדולות יישמרו כקטנות.</p>
<label for="setup-name">שם תצוגה</label><input id="setup-name" name="displayName" type="text" autocomplete="name" required maxlength="80" aria-describedby="displayName-help displayName-error"><p id="displayName-error" class="field-error"></p><p id="displayName-help" class="help">1–40 תווים. השם יופיע בפעולות הניהול ובפרסומים. אין להזין כתובת דוא״ל במקום שם.</p>
<label for="setup-password">סיסמה חדשה</label><input id="setup-password" name="password" type="password" autocomplete="new-password" dir="ltr" required minlength="15" maxlength="256" aria-describedby="password-help password-error"><p id="password-error" class="field-error"></p><p id="password-help" class="help">15–128 תווים, עד 512 בתים. השתמשו בסיסמה ייחודית ושמרו אותה במנהל סיסמאות.</p>
<label for="setup-confirm">הסיסמה החדשה שוב</label><input id="setup-confirm" name="confirmation" type="password" autocomplete="new-password" dir="ltr" required minlength="15" maxlength="256" aria-describedby="confirmation-error"><p id="confirmation-error" class="field-error"></p>
<p id="setup-error" class="message error" role="alert"></p><p id="setup-retry" class="help" role="status" hidden></p><button id="setup-submit" type="submit" disabled>יצירת חשבון המנהל</button>
</form><p id="setup-success" class="message success" role="status" hidden></p><a id="setup-login" href="/admin/" hidden>מעבר למסך הכניסה</a><noscript><p class="message error">יש להפעיל JavaScript בדפדפן כדי להשלים את ההקמה.</p></noscript>
</main><script nonce="${nonce}">
'use strict';
var form = document.getElementById('setup-form'), submit = document.getElementById('setup-submit'), error = document.getElementById('setup-error'), retry = document.getElementById('setup-retry');
var fields = {
  code: document.getElementById('setup-code'), username: document.getElementById('setup-user'), displayName: document.getElementById('setup-name'),
  password: document.getElementById('setup-password'), confirmation: document.getElementById('setup-confirm')
};
var messages = {
  code: 'יש להזין את קוד ההקמה הפרטי.',
  username: 'שם המשתמש צריך להכיל 3–64 תווים באנגלית ולהתחיל באות או בספרה. מותרות אותיות, ספרות, נקודה, קו תחתון ומקף; כתובת דוא״ל ו־@ אינם מותרים.',
  displayName: 'שם התצוגה צריך להכיל 1–40 תווים, ללא סימני < > או תווי בקרה.',
  password: 'הסיסמה צריכה להכיל 15–128 תווים, עד 512 בתים.',
  confirmation: 'הסיסמאות אינן זהות. הזינו שוב את אותה סיסמה.'
};
function wellFormed(value) {
  return Array.from(value).every(function (character) { var n = character.charCodeAt(0); return character.length !== 1 || n < 0xD800 || n > 0xDFFF; });
}
function clearFieldErrors() {
  Object.keys(fields).forEach(function (key) { document.getElementById(key + '-error').textContent = ''; fields[key].removeAttribute('aria-invalid'); });
}
function markFields(errors) {
  var first;
  Object.keys(fields).forEach(function (key) {
    if (typeof errors[key] !== 'string' || !errors[key] || errors[key].length > 300) return;
    document.getElementById(key + '-error').textContent = errors[key]; fields[key].setAttribute('aria-invalid', 'true');
    if (!first) first = fields[key];
  });
  if (first) first.focus();
}
form.addEventListener('submit', async function (event) {
  event.preventDefault(); if (submit.disabled) return;
  error.textContent = ''; retry.hidden = true; retry.textContent = ''; clearFieldErrors();
  var username = fields.username.value.trim().toLowerCase(), name = fields.displayName.value.trim(), password = fields.password.value, errors = {};
  fields.username.value = username;
  if (!fields.code.value.trim()) errors.code = messages.code;
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) errors.username = messages.username;
  if (!name || !wellFormed(name) || Array.from(name).length > 40 || /[\\p{Cc}<>]/u.test(name)) errors.displayName = messages.displayName;
  if (!wellFormed(password) || Array.from(password).length < 15 || Array.from(password).length > 128 || password.length > 256 || new TextEncoder().encode(password).length > 512) errors.password = messages.password;
  if (password !== fields.confirmation.value) errors.confirmation = messages.confirmation;
  if (Object.keys(errors).length) { markFields(errors); error.textContent = 'יש לתקן את השדות המסומנים. הפרטים נשמרו ולא נשלחו.'; return; }
  var submitted = false, succeeded = false;
  submit.disabled = true; submit.textContent = 'יוצר את החשבון…';
  try {
    var pending = fetch(${endpoint}, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: fields.code.value, username: username, displayName: name, password: password }) });
    submitted = true;
    var response = await pending, result = {}; try { result = await response.json(); } catch { /* show safe generic failure */ }
    if (response.status !== 201 || result.created !== true) {
      if (response.status === 400 && result.fieldErrors && typeof result.fieldErrors === 'object' && !Array.isArray(result.fieldErrors)) {
        var returned = {};
        ['username', 'displayName', 'password'].forEach(function (key) { if (typeof result.fieldErrors[key] === 'string') returned[key] = result.fieldErrors[key]; });
        markFields(returned);
      }
      error.textContent = typeof result.message === 'string' && result.message.length <= 300 ? result.message : 'לא ניתן להשלים את ההקמה. בדקו את הפרטים ואת תוקף הקוד.';
      return;
    }
    succeeded = true; form.reset(); form.hidden = true;
    var success = document.getElementById('setup-success'); success.textContent = 'חשבון המנהל נוצר. אפשר להתחבר עם שם המשתמש והסיסמה שבחרתם.'; success.hidden = false; success.tabIndex = -1; success.focus();
    document.getElementById('setup-login').hidden = false;
  } catch {
    error.textContent = submitted ? 'החיבור נפסק או שהתשובה לא נקלטה. בדקו אם החשבון נוצר לפני ניסיון נוסף.' : 'הטופס לא נשלח. הפרטים נשמרו; בדקו את החיבור ונסו שוב.';
  } finally {
    if (submitted) {
      fields.password.value = ''; fields.confirmation.value = ''; fields.code.value = '';
      if (!succeeded) { retry.textContent = 'מטעמי אבטחה קוד ההקמה והסיסמאות נמחקו מהטופס. לניסיון נוסף הזינו שוב את הקוד המקורי, כל עוד הוא עדיין בתוקף ולא נוצל, ואת הסיסמה ואישורה.'; retry.hidden = false; }
    }
    submit.disabled = false; submit.textContent = 'יצירת חשבון המנהל';
  }
});
// Custom validation counts Unicode code points and reports accessible Hebrew
// field errors before fetch; the static POST/disabled fallback remains intact.
form.noValidate = true;
// A script-disabled or blocked page never enables its credential submit button.
// Explicit POST remains the fallback even if native submission bypasses it.
submit.disabled = false;
</script></body></html>`;
}
