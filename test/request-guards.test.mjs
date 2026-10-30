import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestBodyError, boundedStream, readJsonBody } from '../cms-worker/request-guards.mjs';

const enc = new TextEncoder();
const streamOf = (chunks, state = {}) => {
  let index = 0;
  state.pulls = 0;
  state.cancelled = false;
  return new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
    cancel(reason) { state.cancelled = true; state.reason = reason; },
  }, { highWaterMark: 0 });
};
const bodyError = (status) => (error) => error instanceof RequestBodyError && error.status === status;
const readAll = async (stream) => {
  const reader = stream.getReader(), chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
};

test('JSON limits count actual bytes without trusting Content-Length', async () => {
  const bytes = enc.encode('{"value":"too long"}');
  const request = new Request('https://example.test', {
    method: 'POST', body: bytes, headers: { 'Content-Length': '1' },
  });
  await assert.rejects(readJsonBody(request, { maxBytes: 8 }), bodyError(413));
});

test('an oversized body without Content-Length stops reading and cancels its producer', async () => {
  const state = {}, body = streamOf(Array.from({ length: 100 }, () => new Uint8Array(16)), state);
  await assert.rejects(readJsonBody({ body }, { maxBytes: 32 }), bodyError(413));
  assert.equal(state.pulls, 3, 'only the first over-budget chunk is read');
  assert.equal(state.cancelled, true);
  assert.ok(bodyError(413)(state.reason));
  assert.equal(body.locked, false);
});

test('fragmented UTF-8 and byte views decode without corruption at the exact limit', async () => {
  const expected = { title: 'שלום 🌱', nested: { draft: true } };
  const bytes = enc.encode(JSON.stringify(expected));
  const backing = new Uint8Array(bytes.length + 10);
  backing.set(bytes, 5);
  const chunks = Array.from({ length: bytes.length }, (_, i) => backing.subarray(5 + i, 6 + i));
  assert.deepEqual(await readJsonBody({ body: streamOf(chunks) }, { maxBytes: bytes.length }), expected);
});

test('empty input is explicitly allowed for ordinary actions but can be rejected for login', async () => {
  assert.deepEqual(await readJsonBody({ body: null }, { maxBytes: 0 }), {});
  assert.deepEqual(await readJsonBody({ body: streamOf([]) }, { maxBytes: 0 }), {});
  await assert.rejects(readJsonBody({ body: null }, { maxBytes: 0, allowEmpty: false }), bodyError(400));
  await assert.rejects(readJsonBody({ body: streamOf([]) }, { maxBytes: 0, allowEmpty: false }), bodyError(400));
  await assert.rejects(readJsonBody({ body: streamOf([new Uint8Array([1])]) }, { maxBytes: 0 }), bodyError(413));
});

test('malformed JSON, non-object values and malformed UTF-8 are client errors', async () => {
  for (const text of [' ', '{', 'null', '[]', '[{}]', '"text"', '1', 'false']) {
    await assert.rejects(readJsonBody({ body: streamOf([enc.encode(text)]) }, { maxBytes: 100 }), bodyError(400), text);
  }
  const invalidUtf8 = new Uint8Array([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125]);
  await assert.rejects(readJsonBody({ body: streamOf([invalidUtf8]) }, { maxBytes: 100 }), bodyError(400));
});

test('a stream is not pulled until its consumer asks, and cancellation reaches the source', async () => {
  const state = {}, body = streamOf([enc.encode('a'), enc.encode('b')], state);
  const guarded = boundedStream(body, { maxBytes: 2, expectedBytes: 2 });
  await Promise.resolve();
  assert.equal(state.pulls, 0);
  const reader = guarded.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'a');
  await Promise.resolve();
  assert.equal(state.pulls, 1, 'there must be no autonomous prefetch');
  const reason = new Error('consumer stopped');
  await reader.cancel(reason);
  reader.releaseLock();
  assert.equal(state.cancelled, true);
  assert.equal(state.reason, reason);
  assert.equal(body.locked, false);
});

test('exact uploads preserve chunks and succeed only after the expected EOF', async () => {
  assert.deepEqual(await readAll(boundedStream(streamOf([]), { maxBytes: 0, expectedBytes: 0 })), Buffer.alloc(0));
  const state = {}, chunks = [enc.encode('abc'), enc.encode('de')];
  assert.equal((await readAll(boundedStream(streamOf(chunks, state), { maxBytes: 100, expectedBytes: 5 }))).toString(), 'abcde');
  assert.equal(state.pulls, 3, 'the upload must read through EOF');
  assert.equal(state.cancelled, false);
});

test('consumer cancellation settles a pending read and releases the source', async () => {
  let pulled;
  const started = new Promise((resolve) => { pulled = resolve; });
  const state = {};
  const body = new ReadableStream({
    pull() { pulled(); },
    cancel(reason) { state.reason = reason; },
  }, { highWaterMark: 0 });
  const reader = boundedStream(body, { maxBytes: 10 }).getReader();
  const pending = reader.read();
  await started;
  const reason = new Error('upload consumer stopped');
  await reader.cancel(reason);
  assert.deepEqual(await pending, { done: true, value: undefined });
  reader.releaseLock();
  assert.equal(state.reason, reason);
  assert.equal(body.locked, false);
});

for (const pendingRead of [false, true]) {
  test(`consumer cancellation does not wait for a stalled upstream cancellation (pending read: ${pendingRead})`, { timeout: 2000 }, async () => {
    let markPulled, reasonReceived;
    const pulled = new Promise((resolve) => { markPulled = resolve; });
    const body = new ReadableStream({
      pull(controller) {
        markPulled();
        if (pendingRead) return new Promise(() => {});
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) { reasonReceived = reason; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const reader = boundedStream(body, { maxBytes: 10 }).getReader();
    const first = reader.read();
    await pulled;
    if (!pendingRead) assert.equal((await first).value[0], 1);
    const reason = new Error('consumer no longer accepts bytes');
    await reader.cancel(reason);
    if (pendingRead) assert.deepEqual(await first, { done: true, value: undefined });
    reader.releaseLock();
    assert.equal(reasonReceived, reason);
    assert.equal(body.locked, false);
  });
}

test('a too-short exact upload fails instead of completing successfully', async () => {
  const body = streamOf([enc.encode('abc')]);
  await assert.rejects(readAll(boundedStream(body, { maxBytes: 100, expectedBytes: 4 })), bodyError(400));
  assert.equal(body.locked, false);
});

test('an over-budget chunk is never forwarded, including when it crosses the exact length', async () => {
  const state = {}, body = streamOf([enc.encode('abc'), enc.encode('def'), enc.encode('never read')], state);
  const reader = boundedStream(body, { maxBytes: 100, expectedBytes: 5 }).getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'abc');
  await assert.rejects(reader.read(), bodyError(413));
  reader.releaseLock();
  assert.equal(state.pulls, 2);
  assert.equal(state.cancelled, true);
  assert.equal(body.locked, false);
});

test('upstream failures remain infrastructure errors and release the source lock', async () => {
  const failure = new Error('simulated transport failure');
  const body = new ReadableStream({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
  await assert.rejects(readJsonBody({ body }, { maxBytes: 100 }), (error) => error === failure);
  assert.equal(body.locked, false);
});

test('non-byte streams are rejected and cancelled', async () => {
  const state = {}, body = streamOf(['not bytes'], state);
  await assert.rejects(readAll(boundedStream(body, { maxBytes: 100 })), bodyError(400));
  assert.equal(state.cancelled, true);
  assert.equal(body.locked, false);
});

test('cancellation failures cannot mask an over-budget body', async () => {
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(2)); },
    cancel() { throw new Error('simulated cancellation failure'); },
  }, { highWaterMark: 0 });
  await assert.rejects(readAll(boundedStream(body, { maxBytes: 1 })), bodyError(413));
  assert.equal(body.locked, false);
});

test('a slow upstream cancellation does not delay an oversize error', async () => {
  let finishCancellation;
  const cancelled = new Promise((resolve) => { finishCancellation = resolve; });
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(2)); },
    cancel() { return cancelled; },
  }, { highWaterMark: 0 });
  try {
    await assert.rejects(readAll(boundedStream(body, { maxBytes: 1 })), bodyError(413));
    assert.equal(body.locked, false);
  } finally { finishCancellation(); }
});

test('invalid limits fail as configuration errors before locking a source', async () => {
  for (const maxBytes of [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) {
    const body = streamOf([]);
    assert.throws(() => boundedStream(body, { maxBytes }), TypeError);
    assert.equal(body.locked, false);
  }
  assert.throws(() => boundedStream(streamOf([]), { maxBytes: 1, expectedBytes: 2 }), RangeError);
  assert.throws(() => boundedStream(streamOf([]), { maxBytes: 1, expectedBytes: -1 }), TypeError);
  await assert.rejects(readJsonBody({ body: null }, { maxBytes: 1, allowEmpty: 'yes' }), TypeError);
});
