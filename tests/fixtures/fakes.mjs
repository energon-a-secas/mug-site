// Test doubles for the network and for R2, shared by the Worker, polite and
// runner tests. Synthetic by construction: nothing here was ever fetched.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A fixture file's text (or bytes with { binary: true }). */
export function fixture(name, { binary = false } = {}) {
  const buf = readFileSync(join(HERE, name));
  return binary ? new Uint8Array(buf) : buf.toString('utf8');
}

/**
 * A fetch() over a table of routes. A route is matched on the exact URL, then
 * on the URL without its query. A route is { status, body, headers } or a
 * function (url, init) returning a Response (or a promise of one). Unknown
 * URLs answer 404. Every call is logged on fn.calls.
 */
export function fakeWeb(routes = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = String(url);
    const route = routes[key] ?? routes[key.split('?')[0]];
    if (route === undefined) return new Response('no such fixture', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (typeof route === 'function') return route(key, init);
    const status = route.status ?? 200;
    const empty = status === 204 || status === 304;
    return new Response(empty ? null : route.body ?? '', { status, headers: route.headers ?? {} });
  };
  fn.calls = calls;
  fn.urls = () => calls.map((c) => c.url);
  return fn;
}

/** A route that never answers until the request is aborted. */
export function hang(url, init = {}) {
  return new Promise((resolve, reject) => {
    const signal = init.signal;
    const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (!signal) return;
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** A body that streams `total` bytes in chunks, with no Content-Length. */
export function streamOf(total, chunk = 64 * 1024) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new TypeError('FakeR2 stores bytes or strings');
}

/**
 * An in-memory R2 bucket: head, get, put and delete, with httpMetadata,
 * customMetadata, size, etag (MD5 hex, as R2) and httpEtag (quoted). Every
 * call is logged on .calls so a test can assert the bucket was not touched.
 */
export class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.calls = [];
  }

  meta(key, o) {
    return { key, size: o.bytes.length, etag: o.etag, httpEtag: `"${o.etag}"`, httpMetadata: { ...o.httpMetadata }, customMetadata: { ...o.customMetadata }, uploaded: o.uploaded };
  }

  async head(key) {
    this.calls.push(['head', key]);
    const o = this.objects.get(key);
    return o ? this.meta(key, o) : null;
  }

  async get(key) {
    this.calls.push(['get', key]);
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes;
    return { ...this.meta(key, o), body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer };
  }

  async put(key, value, options = {}) {
    this.calls.push(['put', key]);
    const bytes = bytesOf(value);
    const o = {
      bytes,
      etag: createHash('md5').update(bytes).digest('hex'),
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
      uploaded: new Date(0),
    };
    this.objects.set(key, o);
    return this.meta(key, o);
  }

  async delete(key) {
    this.calls.push(['delete', key]);
    this.objects.delete(key);
  }

  count(op) {
    return this.calls.filter(([name]) => name === op).length;
  }
}
