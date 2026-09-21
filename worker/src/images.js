// ── Images in R2 (C4) ────────────────────────────────────────────────────────
//
// Keys are content addresses: o/, t/ or p/, the SHA-256 of the stored bytes,
// and the extension the bytes sniff as (never the URL's, never the
// Content-Type a shop or a browser claimed). The same bytes are therefore
// stored once, and a key never changes meaning, which is what lets /i/ serve
// every object as immutable for a year.
//
// /i/<key> only ever touches R2 for a key of exactly that shape: anything else
// is a 404 before the bucket is asked, so /i/ cannot be used to probe the
// bucket or read an object this Worker did not write.

import { sniffImage, contentTypeFor } from '../../shared/images/sniff.js';
import { CAPS, politeFetch, readCapped } from '../../shared/net/polite.js';
import { envelope, json } from './errors.js';

export const KEY_PATTERN = /^[otp]\/[0-9a-f]{64}\.(jpg|png|gif|webp|avif)$/;
export const IMAGE_CAP = CAPS.image;
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const KIND_PREFIX = Object.freeze({ original: 'o', thumb: 't', photo: 'p' });

const PUBLIC_HEADERS = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'cross-origin',
};

/** Lowercase hex SHA-256 of the bytes. */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

export function notConfigured() {
  return envelope('NOT_CONFIGURED', 'This Worker has no R2 binding (IMAGES), so it cannot store images.', {
    hint: 'Bind the mug-images bucket in wrangler.toml; until then Convex stores images itself (C4.3).',
  });
}

/**
 * Sniffs, hashes and stores bytes under `<prefix>/<sha256>.<ext>`, skipping the
 * write when that key already exists. Answers C3's { ok, key, bytes, contentType, w?, h? }.
 */
export async function storeImage(bucket, bytes, { prefix, source } = {}) {
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    return envelope('NOT_AN_IMAGE', 'Those bytes are not a jpg, png, gif, webp or avif image.', { hint: 'Drop this image.' });
  }
  const key = `${prefix}/${await sha256Hex(bytes)}.${sniffed.ext}`;
  const existing = await bucket.head(key);
  if (!existing) {
    const options = { httpMetadata: { contentType: sniffed.contentType, cacheControl: IMMUTABLE } };
    if (source) options.customMetadata = { source: String(source).slice(0, 1024) };
    await bucket.put(key, bytes, options);
  }
  const out = { ok: true, key, bytes: bytes.length, contentType: sniffed.contentType };
  if (sniffed.w) out.w = sniffed.w;
  if (sniffed.h) out.h = sniffed.h;
  return out;
}

/** C3 /v1/images/mirror: fetch a shop's image politely and store it as an original. */
export async function mirrorImage({ url }, ctx, bucket) {
  const got = await politeFetch(url, { fetchImpl: ctx.fetchImpl, robotsCache: ctx.robotsCache, env: ctx.env, budget: ctx.budget, kind: 'image' });
  if (!got.ok) return got;
  return storeImage(bucket, got.body, { prefix: KIND_PREFIX.original, source: url });
}

/** C3 PUT /v1/images/put?kind=: raw bytes from Convex (a browser-made thumbnail or photo, or an admin upload). */
export async function putImage(request, kind, bucket) {
  // Own keys only: kind=constructor would otherwise read Object's prototype.
  const prefix = Object.hasOwn(KIND_PREFIX, kind) ? KIND_PREFIX[kind] : null;
  if (!prefix) return envelope('BAD_REQUEST', '`kind` has to be thumb, photo or original.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > IMAGE_CAP) return envelope('TOO_LARGE', `The image is over the ${IMAGE_CAP}-byte cap.`);
  const read = await readCapped(request.body, IMAGE_CAP);
  if (read.over) return envelope('TOO_LARGE', `The image is over the ${IMAGE_CAP}-byte cap.`);
  if (!read.bytes.length) return envelope('BAD_REQUEST', 'The request carried no bytes.');
  return storeImage(bucket, read.bytes, { prefix });
}

/** C3 DELETE /v1/images/<key>: { ok, deleted } where deleted says whether the object existed. */
export async function deleteImage(key, bucket) {
  if (!KEY_PATTERN.test(key)) return envelope('BAD_REQUEST', 'That is not an image key (o/, t/ or p/, a SHA-256 and an image extension).');
  const existing = await bucket.head(key);
  if (existing) await bucket.delete(key);
  return { ok: true, deleted: !!existing };
}

function etagOf(object) {
  if (object.httpEtag) return object.httpEtag;
  return object.etag ? `"${object.etag}"` : null;
}

function matchesEtag(header, etag) {
  if (!etag) return false;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === '*' || bare(t) === bare(etag));
}

function objectHeaders(key, object) {
  const headers = {
    ...PUBLIC_HEADERS,
    'content-type': (object.httpMetadata && object.httpMetadata.contentType) || contentTypeFor(key.split('.').pop()) || 'application/octet-stream',
    'cache-control': IMMUTABLE,
  };
  const etag = etagOf(object);
  if (etag) headers.etag = etag;
  if (Number.isInteger(object.size)) headers['content-length'] = String(object.size);
  return headers;
}

function notFound() {
  return json(envelope('NOT_FOUND', 'No image has that key.'), 404, PUBLIC_HEADERS);
}

/** GET or HEAD /i/<key>: the object, immutable, with a 304 for a matching If-None-Match. */
export async function serveImage(request, key, bucket) {
  if (!KEY_PATTERN.test(key)) return notFound();
  if (!bucket) return json(notConfigured(), 501, PUBLIC_HEADERS);
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch) {
    const head = await bucket.head(key);
    if (!head) return notFound();
    if (matchesEtag(ifNoneMatch, etagOf(head))) {
      const headers = objectHeaders(key, head);
      delete headers['content-length'];
      delete headers['content-type'];
      return new Response(null, { status: 304, headers });
    }
  }
  if (request.method === 'HEAD') {
    const head = await bucket.head(key);
    return head ? new Response(null, { status: 200, headers: objectHeaders(key, head) }) : notFound();
  }
  const object = await bucket.get(key);
  if (!object) return notFound();
  return new Response(object.body, { status: 200, headers: objectHeaders(key, object) });
}

/** OPTIONS /i/<key>: images are public; a preflight gets the same open answer. */
export function imageOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...PUBLIC_HEADERS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' },
  });
}
