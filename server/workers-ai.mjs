// Optional Node replacement for the existing Cloudflare env.AI binding.
// Construction validates settings only: no provider call, token discovery,
// retry, account/model switching or billing/configuration change is performed.
export const WORKERS_AI_PROVIDER = 'cloudflare-workers-ai';
export const WORKERS_AI_ACCOUNT_ID = '65aba402e181a43a2657b8a4cd0cfda1';
export const WORKERS_AI_MODEL = '@cf/meta/m2m100-1.2b';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${WORKERS_AI_ACCOUNT_ID}/ai/run/${WORKERS_AI_MODEL}`;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_TRANSLATION_BYTES = 4096;
const FAILURE = 'Workers AI request failed';

export class WorkersAiConfigurationError extends Error {}
export class WorkersAiRequestError extends Error {
  constructor() { super(FAILURE); this.name = 'WorkersAiRequestError'; }
}
const invalid = (name, detail) => { throw new WorkersAiConfigurationError(`${name}: ${detail}`); };
const reject = () => { throw new WorkersAiRequestError(); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cancel = (body) => { if (body && !body.locked) void body.cancel().catch(() => {}); };

function requestBody(model, input) {
  if (model !== WORKERS_AI_MODEL || !object(input) || Object.keys(input).some((key) => !['text', 'source_lang', 'target_lang'].includes(key))) reject();
  const { text, source_lang, target_lang } = input;
  if (typeof text !== 'string' || !text.isWellFormed() || !text.trim() || text.length > 80 || Buffer.byteLength(text, 'utf8') > 320 || source_lang !== 'he' || target_lang !== 'en') reject();
  return JSON.stringify({ text, source_lang, target_lang });
}

async function translationFrom(response, signal) {
  if (!(response instanceof Response) || !response.ok || response.redirected || !response.body || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    cancel(response?.body); reject();
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) { cancel(response.body); reject(); }
  const reader = response.body.getReader(), chunks = [];
  let total = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) reject();
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) reject();
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_RESPONSE_BYTES - total) reject();
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    if (!object(data) || data.success !== true || (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length)) || !object(data.result)) reject();
    const translated = data.result.translated_text;
    if (typeof translated !== 'string' || !translated.isWellFormed() || !translated.trim() || translated.length > 2048 || Buffer.byteLength(translated, 'utf8') > MAX_TRANSLATION_BYTES) reject();
    return { translated_text: translated };
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) abort();
    reader.releaseLock();
  }
}

// The dedicated API token remains only in this closure. Deliberately ignore
// CLOUDFLARE_API_TOKEN and every deployment credential: none is a fallback.
export function createWorkersAi(values = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!object(values)) invalid('CMS_AI_PROVIDER', 'requires explicit environment settings');
  const provider = values.CMS_AI_PROVIDER === undefined ? 'disabled' : values.CMS_AI_PROVIDER;
  if (!['disabled', WORKERS_AI_PROVIDER].includes(provider)) invalid('CMS_AI_PROVIDER', 'must be disabled or cloudflare-workers-ai');
  if (provider === 'disabled') {
    if (values.CLOUDFLARE_AI_ACCOUNT_ID !== undefined || values.CLOUDFLARE_AI_API_TOKEN !== undefined) invalid('CMS_AI_PROVIDER', 'AI-specific credentials require explicit cloudflare-workers-ai selection; remove them when disabled');
    return undefined;
  }
  if (values.CLOUDFLARE_AI_ACCOUNT_ID !== WORKERS_AI_ACCOUNT_ID) invalid('CLOUDFLARE_AI_ACCOUNT_ID', 'must explicitly select the approved existing Cloudflare account');
  const token = values.CLOUDFLARE_AI_API_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(token)) invalid('CLOUDFLARE_AI_API_TOKEN', 'requires a dedicated token in private runtime configuration');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) invalid('Workers AI transport', 'requires a fetch implementation and a timeout between1 and30000 milliseconds');
  return Object.freeze({
    async run(model, input) {
      let controller, timer;
      try {
        const body = requestBody(model, input);
        controller = new AbortController();
        const deadline = new Promise((_, fail) => {
          timer = setTimeout(() => { controller.abort(); fail(new WorkersAiRequestError()); }, timeoutMs);
        });
        const operation = (async () => {
          const response = await fetchImpl(ENDPOINT, {
            method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body,
          });
          return translationFrom(response, controller.signal);
        })();
        return await Promise.race([operation, deadline]);
      } catch {
        // No provider response, URL, input, token or original exception/cause is
        // included in errors. The existing Worker safely falls back to no slug.
        throw new WorkersAiRequestError();
      } finally {
        clearTimeout(timer);
        controller?.abort();
      }
    },
  });
}
