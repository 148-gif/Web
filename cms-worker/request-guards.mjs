// Request bodies are untrusted even when Content-Length is absent or incorrect.
// These helpers use WHATWG streams so the same limits can serve Workers and Node.
export class RequestBodyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RequestBodyError';
    this.status = status;
  }
}

const byteLimit = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
};
const tooLarge = () => new RequestBodyError('הבקשה גדולה מדי', 413);
const invalidBody = () => new RequestBodyError('גוף הבקשה אינו תקין', 400);

// Do not read ahead of the consumer or forward an over-budget chunk. A consumer
// must read to EOF to establish exact length; bytes already consumed are not a
// completed upload until that check succeeds. Storage callers must retain their
// own atomic completion/cleanup behavior and, where needed, known-length metadata.
export function boundedStream(body, { maxBytes, expectedBytes } = {}) {
  byteLimit(maxBytes, 'maxBytes');
  if (expectedBytes !== undefined) {
    byteLimit(expectedBytes, 'expectedBytes');
    if (expectedBytes > maxBytes) throw new RangeError('expectedBytes exceeds maxBytes');
  }
  if (!body || typeof body.getReader !== 'function') throw new TypeError('body must be a readable byte stream');
  const ceiling = expectedBytes ?? maxBytes;
  const reader = body.getReader();
  let total = 0, finished = false;
  const release = () => { try { reader.releaseLock(); } catch { /* retry after an in-flight read settles */ } };
  const cancelSource = (reason) => {
    let cancellation;
    try { cancellation = reader.cancel(reason); } catch { release(); return Promise.resolve(); }
    release();
    // A cancellation failure must not replace the original body/size error.
    return Promise.resolve(cancellation).catch(() => {});
  };
  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (finished) { release(); return; }
        if (done) {
          finished = true;
          release();
          if (expectedBytes !== undefined && total !== expectedBytes) {
            controller.error(new RequestBodyError('ההעלאה לא הושלמה בגודל שהוצהר', 400));
          } else controller.close();
          return;
        }
        if (!(value instanceof Uint8Array)) throw invalidBody();
        if (value.byteLength > ceiling - total) throw tooLarge();
        total += value.byteLength;
        controller.enqueue(value);
      } catch (error) {
        if (finished) { release(); return; }
        finished = true;
        controller.error(error);
        // Error the consumer immediately, even if upstream cancellation is slow.
        void cancelSource(error);
      }
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      // Stream cancellation closes this wrapper and prevents further reads now.
      // An upstream cancellation hook may never settle; it must not keep a
      // failed storage pipeline (and its upload reservation) waiting forever.
      void cancelSource(reason);
    },
  }, { highWaterMark: 0 });
}

// Use a growing byte buffer, rather than retaining an unbounded number of tiny
// chunks. The limit counts encoded bytes, including multi-byte Hebrew text.
export async function readJsonBody(request, { maxBytes, allowEmpty = true } = {}) {
  byteLimit(maxBytes, 'maxBytes');
  if (typeof allowEmpty !== 'boolean') throw new TypeError('allowEmpty must be a boolean');
  if (!request || !('body' in request)) throw new TypeError('request must have a body property');
  if (request.body === null) {
    if (allowEmpty) return {};
    throw invalidBody();
  }
  const reader = boundedStream(request.body, { maxBytes }).getReader();
  let buffer = new Uint8Array(0), length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const needed = length + value.byteLength;
      if (needed > buffer.byteLength) {
        const next = new Uint8Array(Math.min(maxBytes, Math.max(needed, buffer.byteLength ? buffer.byteLength * 2 : 8192)));
        next.set(buffer.subarray(0, length));
        buffer = next;
      }
      buffer.set(value, length);
      length = needed;
    }
  } catch (error) {
    // boundedStream already cancels the source, including upstream read errors.
    // Cancel this consumer too so it never retains a locked wrapper.
    try { await reader.cancel(error); } catch { /* preserve the original error */ }
    throw error;
  } finally { reader.releaseLock(); }
  if (!length && allowEmpty) return {};
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
  catch { throw invalidBody(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidBody();
  return parsed;
}
