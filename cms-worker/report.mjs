// Failure reports by email: the editor server (worker.mjs), the editor page, visitors' browsers (site/report.js) and the
// deploy workflows (scripts/notify-failure.mjs) all end up here. A report is cleaned and size-limited, throttled so one
// repeating failure is not a flood, and sent to the site owner through Resend (setup: cms-worker/README.md).
// Plain Node and Worker code only (fetch, crypto), so the workflows can import it too.
//
// Settings: RESEND_API_KEY and REPORT_TO (secrets; REPORT_TO is the owner's email, never written in this public repository),
// REPORT_FROM (optional; the default sender only delivers to the email of the Resend account itself).

const MAX = { kind: 20, where: 200, message: 1000, detail: 6000, stack: 3000, page: 300, key: 40, value: 500, extra: 20 };
export const KINDS = { save: 'שמירה', publish: 'פרסום', deploy: 'פריסה', load: 'טעינה', network: 'רשת', script: 'שגיאת קוד', resource: 'קובץ שלא נטען', server: 'שרת העריכה' };
const WHO = { editor: 'עורך מחובר (מאומת)', visitor: 'גולש באתר (לא מאומת)', server: 'שרת העריכה', ci: 'GitHub Actions' };
const LIMITS = { visitor: { day: 20, hours: 6 }, editor: { day: 100, hours: 1 }, server: { day: 100, hours: 1 } };
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const one = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const many = (v, n) => String(v ?? '').replace(/\r/g, '').replace(/[^\S\n]+$/gm, '').trim().slice(0, n);

// Whatever arrives (from a browser, so anyone) becomes a small, flat, text-only report.
export function cleanReport(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const extra = {};
  if (r.extra && typeof r.extra === 'object' && !Array.isArray(r.extra)) {
    for (const [k, v] of Object.entries(r.extra).slice(0, MAX.extra)) if (typeof v !== 'object') extra[one(k, MAX.key)] = one(v, MAX.value);
  }
  return {
    kind: Object.hasOwn(KINDS, r.kind) ? r.kind : 'other',
    where: one(r.where, MAX.where), message: one(r.message, MAX.message),
    detail: many(r.detail, MAX.detail), stack: many(r.stack, MAX.stack), page: one(r.page, MAX.page), extra,
  };
}

// ctx: { source: editor | visitor | server | ci, email, ua, origin, country, at }
export function formatReport(r, ctx = {}) {
  const at = ctx.at || new Date();
  const il = at.toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  const kind = KINDS[r.kind] || 'אחר';
  const subject = `[היכל הקודש] כישלון ב${kind}: ${r.where || r.message}`.slice(0, 150);
  const head = [
    ['סוג', kind], ['מה נעשה', r.where], ['השגיאה', r.message],
    ['מי', ctx.email ? `${WHO[ctx.source]}: ${ctx.email}` : WHO[ctx.source] || ctx.source],
    ['מתי', `${il} (שעון ישראל) · ${at.toISOString()}`],
    ['עמוד', r.page], ['דפדפן', ctx.ua], ['מדינה', ctx.country],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const extra = Object.entries(r.extra).map(([k, v]) => `${k}: ${v}`);
  const text = [
    head.join('\n'),
    r.detail && `--- פרטים ---\n${r.detail}`,
    r.stack && `--- מיקום בקוד ---\n${r.stack}`,
    extra.length && `--- מידע נוסף ---\n${extra.join('\n')}`,
    ctx.suppressed ? `(הכישלון הזה חזר ${ctx.suppressed} פעמים מאז הדיווח הקודם, ולא נשלח עליהן מייל נפרד)` : '',
    ctx.capNotice ? `(הגעתם למכסה היומית של הדיווחים מ${WHO[ctx.source]}. הדיווחים הבאים להיום לא יישלחו; בדקו את הלוגים ב־Cloudflare)` : '',
  ].filter(Boolean).join('\n\n');
  return { subject, text };
}

// One mail per failure per window, and a daily cap per kind of sender (anyone can post a visitor report).
// State lives in the EDITORS KV store: report:<fingerprint> = { at, n, exp } (n: repeats held back), report-day:<day>:<source> = count.
export async function throttle(env, r, source, now = Date.now()) {
  const kv = env.EDITORS, lim = LIMITS[source] || LIMITS.server;
  if (!kv) return { send: true, suppressed: 0 };
  try {
    const dk = `report-day:${new Date(now).toISOString().slice(0, 10)}:${source}`;
    const fk = `report:${(await sha256([source, r.kind, r.where, r.message.slice(0, 120), r.page].join('|'))).slice(0, 24)}`;
    const prev = JSON.parse((await kv.get(fk)) || 'null');
    if (prev && now - prev.at < lim.hours * 3600e3) {
      await kv.put(fk, JSON.stringify({ ...prev, n: prev.n + 1 }), { expiration: prev.exp });
      return { send: false };
    }
    const used = Number(await kv.get(dk)) || 0;
    if (used > lim.day) return { send: false };
    const exp = Math.floor(now / 1000) + 86400;
    await kv.put(dk, String(used + 1), { expiration: exp + 86400 });
    await kv.put(fk, JSON.stringify({ at: now, n: 0, exp }), { expiration: exp });
    return { send: true, suppressed: prev ? prev.n : 0, capNotice: used === lim.day };
  } catch {
    return { send: true, suppressed: 0 }; // a broken counter must not hide a failure
  }
}

export async function sendMail(env, { subject, text }, fetchFn = fetch) {
  if (!env.RESEND_API_KEY || !env.REPORT_TO) return { sent: false, why: 'not configured' };
  const r = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.REPORT_FROM || 'Heichal Reports <onboarding@resend.dev>', to: String(env.REPORT_TO).split(',').map((x) => x.trim()).filter(Boolean), subject, text }),
  });
  if (!r.ok) console.error('report mail failed', r.status, (await r.text()).slice(0, 300));
  return { sent: r.ok, why: r.ok ? '' : `resend ${r.status}` };
}

// Never throws: reporting a failure must not cause one.
export async function deliver(env, report, ctx, fetchFn = fetch) {
  try {
    const t = ctx.throttled === false ? { send: true } : await throttle(env, report, ctx.source, ctx.at?.getTime?.());
    if (!t.send) return { sent: false, why: 'throttled' };
    return await sendMail(env, formatReport(report, { ...ctx, suppressed: t.suppressed, capNotice: t.capNotice }), fetchFn);
  } catch (e) {
    console.error('report failed', e);
    return { sent: false, why: 'error' };
  }
}

// The end of a GitHub Actions job log, without timestamps and colour codes, plus the lines GitHub marked as errors.
export function tailLog(log, n = 60) {
  const lines = String(log).split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd()); // eslint-disable-line no-control-regex
  return { errors: lines.filter((l) => l.startsWith('##[error]')).map((l) => l.slice(9)), tail: lines.filter(Boolean).slice(-n).join('\n') };
}
