// Public invitation form; authority comes only from a private, expiring code.
// Never place the invitation code or password in a URL or external request.
export function renderAuthInvitation({ apiBasePath = '', nonce } = {}) {
  if (typeof apiBasePath !== 'string' || (apiBasePath && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiBasePath))) throw new TypeError('Invalid API base path');
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) throw new TypeError('An explicit CSP nonce is required');
  const endpoint = JSON.stringify(`${apiBasePath}/auth/invitations/accept`);
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>קבלת הזמנה לחשבון מנהל | היכל הקודש</title>
<style nonce="${nonce}">
:root{color-scheme:light;--bg:#fbf8f1;--surface:#fff;--ink:#1a2034;--mute:#5b6378;--line:#e7dcc2;--navy:#0b1d50;--field:#fff;--field-line:#8b8270;--focus:#14337f;--err:#a3201a;--err-bg:#fbeaea;--ok:#1b6b3a;--ok-bg:#e7f4ec;--gold:#e6c466}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#090e1d;--surface:#111933;--ink:#ece6d6;--mute:#a6adc0;--line:#243055;--navy:#2b4fae;--field:#0f1528;--field-line:#647398;--focus:#b4c8f4;--err:#ff9b94;--err-bg:#2d1618;--ok:#6fcf97;--ok-bg:#12281d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 Arial,"Arial Hebrew",sans-serif}main{max-width:560px;margin:40px auto;padding:28px;background:var(--surface);border:1px solid var(--line);border-radius:16px}h1{font-size:1.7rem;line-height:1.3;margin:0 0 12px}.brand{font-weight:700;color:var(--mute);margin:0 0 12px}.lead,.help{color:var(--mute)}.help{font-size:.9rem}label{display:block;font-weight:700;margin:18px 0 6px}input{width:100%;min-width:0;padding:11px 12px;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--field-line);border-radius:8px}button,a{font:inherit}button{width:100%;min-height:46px;margin-top:22px;padding:10px 16px;border:1px solid var(--navy);border-radius:10px;background:var(--navy);color:#fff;cursor:pointer;font-weight:700}button:disabled{opacity:.65;cursor:wait}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}a{color:var(--focus);display:inline-flex;min-height:44px;align-items:center}.message{border-radius:10px;padding:12px 14px;overflow-wrap:anywhere}.message:empty{display:none}.error{color:var(--err);background:var(--err-bg)}.success{color:var(--ok);background:var(--ok-bg)}[hidden]{display:none!important}@media(max-width:600px){main{margin:16px;padding:22px 18px}h1{font-size:1.45rem}}
</style></head><body><main>
<p class="brand">היכל הקודש</p><h1>קבלת הזמנה לחשבון מנהל</h1><p class="lead">קיבלתם הזמנה אישית? בחרו את פרטי הכניסה שלכם. קוד ההזמנה הפרטי תקף לזמן מוגבל ולשימוש אחד.</p>
<form id="invitation-form" method="post" action="${apiBasePath}/auth/invitations/accept">
<label for="invitation-code">קוד ההזמנה הפרטי</label><input id="invitation-code" name="code" type="password" autocomplete="off" spellcheck="false" dir="ltr" required maxlength="128" aria-describedby="code-help"><p id="code-help" class="help">הזינו כאן את הקוד שנמסר לכם על ידי מנהל מורשה. אין לשלוח קוד או סיסמה בצ׳אט.</p>
<label for="invitation-user">שם משתמש</label><input id="invitation-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" required minlength="3" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{2,63}" aria-describedby="username-help username-error"><p id="username-help" class="help">3–64 תווים באנגלית: אותיות, ספרות, נקודה, קו תחתון או מקף. מתחילים באות או בספרה. לדוגמה: yaakov-admin. שם המשתמש אינו כתובת דוא״ל.</p><p id="username-error" class="message error"></p>
<label for="invitation-name">שם תצוגה</label><input id="invitation-name" name="displayName" type="text" autocomplete="name" required maxlength="80" aria-describedby="displayName-help displayName-error"><p id="displayName-help" class="help">1–40 תווים, ללא סימני &lt; &gt; או תווי בקרה. השם יופיע בפעולות הניהול ובפרסומים.</p><p id="displayName-error" class="message error"></p>
<label for="invitation-password">סיסמה חדשה</label><input id="invitation-password" name="password" type="password" autocomplete="new-password" dir="ltr" required minlength="15" maxlength="256" aria-describedby="password-help password-error"><p id="password-help" class="help">15–128 תווים, עד 512 בתים. השתמשו בסיסמה ייחודית ושמרו אותה במנהל סיסמאות.</p><p id="password-error" class="message error"></p>
<label for="invitation-confirm">הסיסמה החדשה שוב</label><input id="invitation-confirm" name="confirmation" type="password" autocomplete="new-password" dir="ltr" required minlength="15" maxlength="256">
<p id="invitation-error" class="message error" role="alert"></p><button id="invitation-submit" type="submit" disabled>יצירת חשבון המנהל</button>
</form><p id="invitation-success" class="message success" role="status" hidden></p><a id="invitation-login" href="/admin/" hidden>מעבר למסך הכניסה</a><noscript><p class="message error">יש להפעיל JavaScript בדפדפן כדי להשלים את יצירת החשבון.</p></noscript>
</main><script nonce="${nonce}">
'use strict';
var form = document.getElementById('invitation-form'), submit = document.getElementById('invitation-submit'), error = document.getElementById('invitation-error');
var fields = { username: document.getElementById('invitation-user'), displayName: document.getElementById('invitation-name'), password: document.getElementById('invitation-password') };
function showFieldErrors(errors) {
  var first;
  Object.keys(fields).forEach(function (key) {
    var text = typeof errors[key] === 'string' ? errors[key] : '';
    document.getElementById(key + '-error').textContent = text;
    if (text) { fields[key].setAttribute('aria-invalid', 'true'); if (!first) first = fields[key]; }
    else fields[key].removeAttribute('aria-invalid');
  });
  if (first) first.focus();
  return Boolean(first);
}
form.addEventListener('submit', async function (event) {
  event.preventDefault(); if (submit.disabled) return;
  error.textContent = '';
  var password = document.getElementById('invitation-password'), confirmation = document.getElementById('invitation-confirm'), code = document.getElementById('invitation-code');
  var username = fields.username.value.trim(), displayName = fields.displayName.value.trim(), errors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(username)) errors.username = 'שם המשתמש צריך להכיל 3–64 תווים באנגלית, ללא רווחים או @. לדוגמה: yaakov-admin.';
  if (!displayName || !displayName.isWellFormed() || [...displayName].length > 40 || /[\\p{Cc}<>]/u.test(displayName)) errors.displayName = 'שם התצוגה צריך להכיל 1–40 תווים, ללא סימני < > או תווי בקרה.';
  if (!password.value.isWellFormed() || [...password.value].length < 15 || [...password.value].length > 128 || password.value.length > 256 || new TextEncoder().encode(password.value).length > 512) errors.password = 'הסיסמה צריכה להכיל 15–128 תווים, עד 512 בתים.';
  if (showFieldErrors(errors)) { error.textContent = 'בדקו את השדות המסומנים. הפרטים טרם נשלחו.'; return; }
  fields.username.value = username; fields.displayName.value = displayName;
  if (!/^[A-Za-z0-9_-]{43}$/.test(code.value)) { error.textContent = 'הזינו את קוד ההזמנה המקורי במלואו. הפרטים טרם נשלחו.'; code.focus(); return; }
  if (password.value !== confirmation.value) { error.textContent = 'הסיסמאות אינן זהות.'; return; }
  if (!form.reportValidity()) return;
  submit.disabled = true; submit.textContent = 'יוצר את החשבון…';
  try {
    var response = await fetch(${endpoint}, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, username: document.getElementById('invitation-user').value.trim(), displayName: document.getElementById('invitation-name').value.trim(), password: password.value }) });
    var result = {}; try { result = await response.json(); } catch { /* show safe generic failure */ }
    if (response.status !== 201 || result.created !== true) { if (result.fieldErrors && typeof result.fieldErrors === 'object') showFieldErrors(result.fieldErrors); throw new Error(result.message || 'לא ניתן להשלים את יצירת החשבון. בדקו את הקוד ונסו שוב.'); }
    form.reset(); form.hidden = true;
    var success = document.getElementById('invitation-success'); success.textContent = 'חשבון המנהל נוצר. אפשר להתחבר עם שם המשתמש והסיסמה שבחרתם.'; success.hidden = false; success.tabIndex = -1; success.focus();
    document.getElementById('invitation-login').hidden = false;
  } catch (failure) { error.textContent = (failure.message || 'החיבור נפסק. בדקו אם החשבון נוצר לפני ניסיון נוסף.') + ' מטעמי אבטחה הקוד והסיסמה נמחקו מהטופס. לפני ניסיון נוסף הזינו שוב את קוד ההזמנה המקורי ואת הסיסמה.'; }
  finally { password.value = ''; confirmation.value = ''; code.value = ''; submit.disabled = false; submit.textContent = 'יצירת חשבון המנהל'; }
});
// A script-disabled or blocked page never enables its credential submit button.
// Explicit POST remains the fallback even if native submission bypasses it.
form.noValidate = true; // Run our accessible field messages before native checks.
submit.disabled = false;
</script></body></html>`;
}
