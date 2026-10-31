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
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 Arial,"Arial Hebrew",sans-serif}main{max-width:560px;margin:40px auto;padding:28px;background:var(--surface);border:1px solid var(--line);border-radius:16px}h1{font-size:1.7rem;line-height:1.3;margin:0 0 12px}.brand{font-weight:700;color:var(--mute);margin:0 0 12px}.lead,.help{color:var(--mute)}.help{font-size:.9rem}label{display:block;font-weight:700;margin:18px 0 6px}input{width:100%;min-width:0;padding:11px 12px;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--field-line);border-radius:8px}button,a{font:inherit}button{width:100%;min-height:46px;margin-top:22px;padding:10px 16px;border:1px solid var(--navy);border-radius:10px;background:var(--navy);color:#fff;cursor:pointer;font-weight:700}button:disabled{opacity:.65;cursor:wait}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}a{color:var(--focus);display:inline-flex;min-height:44px;align-items:center}.message{border-radius:10px;padding:12px 14px;overflow-wrap:anywhere}.message:empty{display:none}.error{color:var(--err);background:var(--err-bg)}.success{color:var(--ok);background:var(--ok-bg)}[hidden]{display:none!important}@media(max-width:600px){main{margin:16px;padding:22px 18px}h1{font-size:1.45rem}}
</style></head><body><main>
<p class="brand">היכל הקודש</p><h1>הגדרת חשבון מנהל</h1><p class="lead">בחרו את פרטי הכניסה שלכם. קוד ההקמה הפרטי תקף לזמן מוגבל ולשימוש אחד.</p>
<form id="setup-form" method="post" action="${apiBasePath}/auth/bootstrap">
<label for="setup-code">קוד ההקמה הפרטי</label><input id="setup-code" name="code" type="password" autocomplete="off" spellcheck="false" dir="ltr" required maxlength="128" aria-describedby="code-help"><p id="code-help" class="help">הזינו כאן את הקוד שנוצר בלוח האחסון. אין לשלוח קוד או סיסמה בצ׳אט.</p>
<label for="setup-user">שם משתמש</label><input id="setup-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" required maxlength="64">
<label for="setup-name">שם תצוגה</label><input id="setup-name" name="displayName" type="text" autocomplete="name" required maxlength="40"><p class="help">השם יופיע בפעולות הניהול ובפרסומים. אין להזין כתובת דוא״ל במקום שם.</p>
<label for="setup-password">סיסמה חדשה</label><input id="setup-password" name="password" type="password" autocomplete="new-password" dir="ltr" required minlength="15" maxlength="128" aria-describedby="password-help"><p id="password-help" class="help">15 תווים לפחות. השתמשו בסיסמה ייחודית ושמרו אותה במנהל סיסמאות.</p>
<label for="setup-confirm">הסיסמה החדשה שוב</label><input id="setup-confirm" name="confirmation" type="password" autocomplete="new-password" dir="ltr" required minlength="15" maxlength="128">
<p id="setup-error" class="message error" role="alert"></p><button id="setup-submit" type="submit" disabled>יצירת חשבון המנהל</button>
</form><p id="setup-success" class="message success" role="status" hidden></p><a id="setup-login" href="/admin/" hidden>מעבר למסך הכניסה</a><noscript><p class="message error">יש להפעיל JavaScript בדפדפן כדי להשלים את ההקמה.</p></noscript>
</main><script nonce="${nonce}">
'use strict';
var form = document.getElementById('setup-form'), submit = document.getElementById('setup-submit'), error = document.getElementById('setup-error');
form.addEventListener('submit', async function (event) {
  event.preventDefault(); if (submit.disabled || !form.reportValidity()) return;
  error.textContent = '';
  var password = document.getElementById('setup-password'), confirmation = document.getElementById('setup-confirm'), code = document.getElementById('setup-code');
  if (password.value !== confirmation.value) { error.textContent = 'הסיסמאות אינן זהות.'; return; }
  submit.disabled = true; submit.textContent = 'יוצר את החשבון…';
  try {
    var response = await fetch(${endpoint}, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, username: document.getElementById('setup-user').value.trim(), displayName: document.getElementById('setup-name').value.trim(), password: password.value }) });
    var result = {}; try { result = await response.json(); } catch { /* show safe generic failure */ }
    if (response.status !== 201 || result.created !== true) throw new Error(result.message || 'לא ניתן להשלים את ההקמה. בדקו את הקוד ונסו שוב.');
    form.reset(); form.hidden = true;
    var success = document.getElementById('setup-success'); success.textContent = 'חשבון המנהל נוצר. אפשר להתחבר עם שם המשתמש והסיסמה שבחרתם.'; success.hidden = false; success.tabIndex = -1; success.focus();
    document.getElementById('setup-login').hidden = false;
  } catch (failure) { error.textContent = failure.message || 'החיבור נפסק. בדקו אם החשבון נוצר לפני ניסיון נוסף.'; }
  finally { password.value = ''; confirmation.value = ''; code.value = ''; submit.disabled = false; submit.textContent = 'יצירת חשבון המנהל'; }
});
// A script-disabled or blocked page never enables its credential submit button.
// Explicit POST remains the fallback even if native submission bypasses it.
submit.disabled = false;
</script></body></html>`;
}
