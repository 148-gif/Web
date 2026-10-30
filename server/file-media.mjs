// Local media for a Node deployment. The root is private persistent storage,
// outside the web document root, beneath directories controlled by the app owner.
// A single container keeps metadata and bytes in the same atomic replacement.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { RequestBodyError } from '../cms-worker/request-guards.mjs';

const MAGIC = Buffer.from('HCMEDIA1');
const HEADER_BYTES = 4096;
const HEADER_START = MAGIC.length + 4;
const KEY = /^[a-z0-9][\w.-]{0,100}$/;
const locks = new Map();

const validKey = (key) => {
  if (typeof key !== 'string' || !KEY.test(key)) throw new TypeError('Invalid media key');
  return key;
};
const metadataOf = (value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid media metadata');
  const out = {};
  for (const name of ['contentType', 'cacheControl']) {
    if (value[name] === undefined) continue;
    // Header metadata must reject every ASCII control character, including NUL.
    // eslint-disable-next-line no-control-regex
    if (typeof value[name] !== 'string' || value[name].length > 1024 || /[\x00-\x1f\x7f]/.test(value[name])) throw new TypeError('Invalid media metadata');
    out[name] = value[name];
  }
  return out;
};

async function locked(root, key, fn) {
  const name = `${root}\0${key}`, previous = locks.get(name);
  let release;
  const current = new Promise((done) => { release = done; });
  locks.set(name, current);
  if (previous) await previous;
  try { return await fn(); }
  finally { release(); if (locks.get(name) === current) locks.delete(name); }
}

// This is an app-owned root, not a general-purpose filesystem browser. Reject
// symlink components, including when a path changes after adapter construction.
async function privateRoot(root) {
  const base = parse(root).root;
  let path = base;
  for (const part of root.slice(base.length).split('/').filter(Boolean)) {
    path = join(path, part);
    let st;
    try { st = await lstat(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(path, { mode: 0o700 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      st = await lstat(path);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Media root must use real directories');
    if (path === root && (st.mode & 0o077)) throw new Error('Media root must be private (mode 0700)');
  }
  if (await realpath(root) !== root) throw new Error('Media root must be canonical');
}

function regularPrivateFile(st) {
  if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077)) throw new Error('Unsafe media container');
}

async function checkDestination(path) {
  try { regularPrivateFile(await lstat(path)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeAll(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (!bytesWritten) throw new Error('Could not write media bytes');
    offset += bytesWritten;
  }
}

async function readHeader(file) {
  const header = Buffer.alloc(HEADER_BYTES);
  let offset = 0;
  while (offset < header.length) {
    const { bytesRead } = await file.read(header, offset, header.length - offset, offset);
    if (!bytesRead) throw new Error('Incomplete media container');
    offset += bytesRead;
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid media container');
  const length = header.readUInt32BE(MAGIC.length);
  if (!length || length > HEADER_BYTES - HEADER_START) throw new Error('Invalid media metadata length');
  let saved;
  try { saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(HEADER_START, HEADER_START + length))); }
  catch { throw new Error('Invalid media metadata'); }
  if (!saved || saved.version !== 1) throw new Error('Unsupported media container');
  return metadataOf(saved.httpMetadata);
}

export function createFileMedia({ root, maxBytes = 90 * 1024 * 1024 } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) === parse(resolve(root)).root) throw new TypeError('An absolute private media root is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('This filesystem adapter requires O_NOFOLLOW support');
  root = resolve(root);
  const pathOf = (key) => join(root, `${validKey(key)}.media`);

  async function inspect(key) {
    const path = pathOf(key);
    await privateRoot(root);
    let file;
    // Nonblocking open lets fstat reject a corrupted FIFO/special target without
    // occupying a filesystem worker while waiting for another process to open it.
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const st = await file.stat();
      regularPrivateFile(st);
      if (!Number.isSafeInteger(st.size) || st.size < HEADER_BYTES) throw new Error('Invalid media size');
      return { file, head: { key, size: st.size - HEADER_BYTES, httpMetadata: await readHeader(file) } };
    } catch (error) { await file.close(); throw error; }
  }

  return {
    async put(key, body, { httpMetadata } = {}) {
      const path = pathOf(key), metadata = metadataOf(httpMetadata);
      if (!body || typeof body.getReader !== 'function' || body.locked) throw new TypeError('Media body must be an unlocked readable byte stream');
      const encoded = Buffer.from(JSON.stringify({ version: 1, httpMetadata: metadata }));
      if (encoded.length > HEADER_BYTES - HEADER_START) throw new TypeError('Media metadata is too large');
      return locked(root, key, async () => {
        await privateRoot(root);
        await checkDestination(path);
        const temporary = join(root, `.upload-${randomUUID()}`);
        let file, reader, total = 0, complete = false;
        try {
          file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          const header = Buffer.alloc(HEADER_BYTES);
          MAGIC.copy(header); header.writeUInt32BE(encoded.length, MAGIC.length); encoded.copy(header, HEADER_START);
          await writeAll(file, header, 0);
          reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) { complete = true; break; }
            if (!(value instanceof Uint8Array)) throw new RequestBodyError('גוף ההעלאה אינו תקין', 400);
            if (value.byteLength > maxBytes - total) throw new RequestBodyError('הקובץ גדול מדי', 413);
            await writeAll(file, value, HEADER_BYTES + total);
            total += value.byteLength;
          }
          await file.sync();
          await file.close(); file = null;
          // Recheck before replacement; rename never follows the destination.
          await privateRoot(root); await checkDestination(path);
          await rename(temporary, path);
          return { key, size: total, httpMetadata: metadata };
        } finally {
          if (reader) {
            if (!complete) void reader.cancel().catch(() => {});
            try { reader.releaseLock(); } catch { /* cancellation settles pending reads */ }
          }
          if (file) await file.close();
          await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
      });
    },
    async head(key) {
      const found = await inspect(key);
      if (!found) return null;
      await found.file.close();
      return found.head;
    },
    async get(key, { range } = {}) {
      const found = await inspect(key);
      if (!found) return null;
      const { file, head } = found;
      let offset = 0, length = head.size;
      try {
        if (range !== undefined) {
          if (!range || typeof range !== 'object' || !Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset > head.size) throw new RangeError('Invalid media range');
          offset = range.offset;
          if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) throw new RangeError('Invalid media range');
          length = Math.min(range.length ?? head.size - offset, head.size - offset);
        }
        let body;
        if (!length) { await file.close(); body = new ReadableStream({ start(controller) { controller.close(); } }); }
        else body = Readable.toWeb(file.createReadStream({ start: HEADER_BYTES + offset, end: HEADER_BYTES + offset + length - 1, autoClose: true, highWaterMark: 65536 }), {
          strategy: { highWaterMark: 65536, size: (chunk) => chunk.byteLength },
        });
        return { ...head, range: { offset, length }, body, arrayBuffer: () => new Response(body).arrayBuffer() };
      } catch (error) { await file.close(); throw error; }
    },
    async delete(key) {
      const path = pathOf(key);
      return locked(root, key, async () => {
        await privateRoot(root); await checkDestination(path);
        await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      });
    },
  };
}

// Atomicity is per file; process-local locks serialize same-key writers/deleters.
// Several Node processes must coordinate ownership through the database first.
// A crashed writer may leave .upload-* files. They are never served; remove them
// only after proving no writer owns them, rather than deleting by age alone.
