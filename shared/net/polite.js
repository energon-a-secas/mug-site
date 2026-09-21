// ── politeFetch: the only way Mug reads a shop ───────────────────────────────
//
// Shared by the Worker and the runner, so the two cannot disagree about what
// is polite (docs/CONTRACTS.md C10). Every request:
//   1. passes the SSRF guard (guard.js),
//   2. is checked against the host's robots.txt, fetched before the first
//      request to that host and cached for an hour in the Map the caller owns,
//   3. identifies itself with USER_AGENT, never as a browser (there is no
//      option to change it, on purpose),
//   4. follows at most five redirects by hand, each hop re-checked (1 and 2),
//   5. gives up after 15 s, and reads the body as a stream, so a body over the
//      cap is cut off rather than buffered,
// and every failure comes back as a C3 code in an envelope, never as a throw.
//
// Pacing is not here: C10.5 puts it in the caller (Convex spaces its Worker
// calls, the runner waits between requests).

import { USER_AGENT } from '../contract.js';
import { checkUrl } from './guard.js';
import { ROBOTS_MAX_BYTES, robotsPolicy, robotsVerdict } from './robots.js';

/** Every code politeFetch can answer; a subset of the Worker's ERROR_CODES (C3). */
export const FETCH_ERROR_CODES = Object.freeze([
  'URL_NOT_ALLOWED', 'ROBOTS_DISALLOWED', 'UPSTREAM_BLOCKED', 'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT', 'TOO_LARGE',
]);

/** C10.4 body caps by kind of request. */
export const CAPS = Object.freeze({ page: 5 * 1024 * 1024, json: 5 * 1024 * 1024, image: 15 * 1024 * 1024 });
export const TIMEOUT_MS = 15000;
export const MAX_REDIRECTS = 5;
export const ROBOTS_TTL_MS = 60 * 60 * 1000;
// "Disallowed for now" (a 5xx or a timeout) is remembered for less time, so a
// shop that was briefly down is asked again within the hour.
export const ROBOTS_RETRY_MS = 10 * 60 * 1000;
const ROBOTS_CACHE_MAX = 500;
const PEEK_BYTES = 64 * 1024;

const ACCEPT = {
  page: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
  json: 'application/json,text/plain;q=0.5,*/*;q=0.1',
  image: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
  robots: 'text/plain,*/*;q=0.5',
};

const BLOCKING_STATUSES = new Set([401, 403, 429, 503]);
const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const BLOCKED_HINT = 'The shop refuses MugBot from here. The local runner can try from a home connection, still as MugBot and still bound by robots.txt.';

function failure(code, message, extra = {}) {
  const out = { ok: false, code, message };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the shop';
  }
}

/**
 * Reads a byte stream up to `cap` bytes. Over the cap it cancels the stream and
 * answers { over: true }, or with `truncate` keeps the first `cap` bytes.
 */
export async function readCapped(stream, cap, { truncate = false } = {}) {
  if (!stream) return { bytes: new Uint8Array(0), over: false, truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (total + chunk.length > cap) {
      if (truncate) {
        chunks.push(chunk.subarray(0, cap - total));
        total = cap;
      }
      await reader.cancel().catch(() => {});
      return { bytes: concat(chunks, total), over: !truncate, truncated: truncate };
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { bytes: concat(chunks, total), over: false, truncated: false };
}

function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function discard(res) {
  try {
    if (res && res.body) await res.body.cancel();
  } catch {
    // Nothing to do: the body is being thrown away.
  }
}

function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Text from response bytes: the charset in Content-Type, else a <meta charset>
 * in the first KiB, else UTF-8. An encoding the runtime cannot decode falls
 * back to UTF-8 rather than failing.
 */
export function decodeText(bytes, contentType = '') {
  let charset = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || '')) || [])[1];
  if (!charset) {
    const head = latin1(bytes.subarray(0, 1024));
    charset = (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || [])[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function looksLikeHtml(contentType, bytes) {
  if (/html/i.test(contentType || '')) return true;
  const head = latin1(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

// Pages a bot-management layer shows instead of the shop. The strong set is
// what a 2xx answer must carry to count as a block (these never appear on a
// normal product page); the weak set only names the vendor in the message
// when the status already says "refused".
const STRONG_SIGNS = [
  [/<title>\s*just a moment/i, 'a Cloudflare challenge page'],
  [/attention required!\s*\|\s*cloudflare/i, 'a Cloudflare block page'],
  [/\/cdn-cgi\/challenge-platform\//i, 'a Cloudflare challenge page'],
  [/px-captcha/i, 'a PerimeterX block page'],
  [/captcha-delivery\.com/i, 'a DataDome block page'],
  [/incapsula incident id/i, 'an Imperva block page'],
  [/sucuri website firewall/i, 'a Sucuri block page'],
  [/errors\.edgesuite\.net/i, 'an Akamai block page'],
];
const WEAK_SIGNS = [
  [/<title>\s*access denied\s*<\/title>[\s\S]*reference\s*#/i, 'an Akamai block page'],
  [/cloudflare/i, 'a Cloudflare page'],
  [/perimeterx|_pxappid/i, 'a PerimeterX page'],
  [/datadome/i, 'a DataDome page'],
  [/_incapsula_resource/i, 'an Imperva page'],
];

/**
 * What kind of block page this is, or null. `strict` (used on 2xx answers)
 * only accepts signs that never appear on an ordinary page.
 */
export function detectChallenge({ headers, text = '', strict = true } = {}) {
  const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
  if (String(get('cf-mitigated') || '').toLowerCase() === 'challenge') return 'a Cloudflare challenge';
  if (String(get('x-amzn-waf-action') || '').toLowerCase() === 'captcha') return 'an AWS WAF captcha';
  for (const [re, what] of STRONG_SIGNS) if (re.test(text)) return what;
  if (strict) return null;
  if (get('x-datadome')) return 'a DataDome page';
  if (/akamaighost/i.test(String(get('server') || ''))) return 'an Akamai block page';
  for (const [re, what] of WEAK_SIGNS) if (re.test(text)) return what;
  return null;
}

function blockedMessage(url, status, sign) {
  const host = hostLabel(url);
  const reason = status === 429 ? ' (too many requests)' : status === 503 ? ' (service unavailable)' : '';
  return sign ? `${host} answered ${status} with ${sign}.` : `${host} answered ${status}${reason}.`;
}

function settings(options = {}) {
  const kind = ['page', 'json', 'image'].includes(options.kind) ? options.kind : 'page';
  return {
    kind,
    fetchImpl: typeof options.fetchImpl === 'function' ? options.fetchImpl : (u, init) => globalThis.fetch(u, init),
    robotsCache: options.robotsCache instanceof Map ? options.robotsCache : null,
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS,
    maxBytes: Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : CAPS[kind],
    env: options.env || {},
    budget: options.budget && typeof options.budget === 'object' ? options.budget : null,
    now: typeof options.now === 'function' ? options.now : Date.now,
  };
}

const BUDGET_SPENT = 'This call has used its whole subrequest budget.';

/** Takes one subrequest from the budget; false when none is left. */
function spend(budget) {
  if (!budget) return true;
  if (!(budget.left > 0)) return false;
  budget.left -= 1;
  return true;
}

function classifyThrow(err, timedOut, url) {
  if (err && typeof err.mugCode === 'string' && FETCH_ERROR_CODES.includes(err.mugCode)) {
    return failure(err.mugCode, String(err.message || err.mugCode).slice(0, 300));
  }
  const code = err && (err.code || (err.cause && err.cause.code));
  if (timedOut || (err && err.name === 'TimeoutError') || TIMEOUT_ERROR_CODES.has(code)) {
    return failure('UPSTREAM_TIMEOUT', `${hostLabel(url)} did not answer in time.`, { hint: 'Try again later.' });
  }
  const detail = String((err && err.message) || err || 'unknown error').slice(0, 200);
  return failure('UPSTREAM_ERROR', `${hostLabel(url)} could not be reached: ${detail}`);
}

async function fetchRobots(origin, o) {
  let current = `${origin}/robots.txt`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = checkUrl(current, { env: o.env });
    if (!checked.ok) return robotsPolicy({ error: 'refused', detail: checked.message });
    if (!spend(o.budget)) return { kind: 'error', failure: failure('UPSTREAM_ERROR', BUDGET_SPENT) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    try {
      const res = await o.fetchImpl(checked.url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: ACCEPT.robots },
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        await discard(res);
        const location = res.headers.get('location');
        if (!location) return robotsPolicy({ error: 'network', detail: `a ${res.status} redirect without a Location` });
        current = new URL(location, checked.url).href;
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        const { bytes } = await readCapped(res.body, ROBOTS_MAX_BYTES, { truncate: true });
        return robotsPolicy({ status: res.status, text: new TextDecoder('utf-8').decode(bytes) });
      }
      await discard(res);
      return robotsPolicy({ status: res.status });
    } catch (err) {
      // A connection the runner's address check refused is the guard's
      // verdict on the host, not an unreadable robots.txt: answer it as such.
      if (err && err.mugCode === 'URL_NOT_ALLOWED') return { kind: 'error', failure: failure('URL_NOT_ALLOWED', String(err.message).slice(0, 300)) };
      const timedOut = controller.signal.aborted || (err && err.name === 'TimeoutError');
      return robotsPolicy({ error: timedOut ? 'timeout' : 'network', detail: String((err && err.message) || err).slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  }
  return robotsPolicy({ error: 'redirects' });
}

function pruneCache(cache, now) {
  if (cache.size < ROBOTS_CACHE_MAX) return;
  for (const [key, entry] of cache) if (!(entry.expiresAt > now)) cache.delete(key);
  while (cache.size >= ROBOTS_CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** The robots policy for an origin, from the cache when fresh. Concurrent callers share one fetch. */
async function policyFor(origin, o) {
  const cache = o.robotsCache;
  const now = o.now();
  const hit = cache ? cache.get(origin) : null;
  if (hit && hit.expiresAt > now) return hit.promise;
  const entry = { expiresAt: now + ROBOTS_TTL_MS, promise: null };
  entry.promise = fetchRobots(origin, o).then((policy) => {
    if (cache && policy.kind === 'error') cache.delete(origin);
    entry.expiresAt = o.now() + (policy.kind === 'disallow-all' ? ROBOTS_RETRY_MS : ROBOTS_TTL_MS);
    entry.fetchedAt = o.now();
    return policy;
  });
  if (cache) {
    pruneCache(cache, now);
    cache.set(origin, entry);
  }
  return entry.promise;
}

/**
 * The robots.txt verdict for one URL, fetching robots.txt if the cache has
 * none: { ok: true, allowed, rule, status, group } or a failure envelope
 * (URL_NOT_ALLOWED for a refused URL, UPSTREAM_ERROR for a spent budget).
 */
export async function robotsCheck(rawUrl, options = {}) {
  const o = settings(options);
  const checked = checkUrl(rawUrl, { env: o.env });
  if (!checked.ok) return checked;
  const policy = await policyFor(checked.url.origin, o);
  if (policy.kind === 'error') return policy.failure;
  const { allowed, rule } = robotsVerdict(policy, checked.url);
  return { ok: true, allowed, rule, status: policy.status ?? null, group: policy.group ?? null };
}

/**
 * GET one URL politely. Options: { fetchImpl, robotsCache, kind: "page" | "image" | "json",
 * timeoutMs, maxBytes, env, budget: { left }, now }.
 *
 * Success: { ok: true, url (after redirects), status, headers, contentType, body (Uint8Array),
 * bytes, ms, redirects }. Failure: { ok: false, code, message, hint?, upstreamStatus?, url? },
 * with `code` one of FETCH_ERROR_CODES.
 */
export async function politeFetch(rawUrl, options = {}) {
  const o = settings(options);
  const started = o.now();
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const checked = checkUrl(current, { env: o.env });
    if (!checked.ok) return failure(checked.code, checked.message, { url: String(current).slice(0, 300) });
    const url = checked.url;

    const policy = await policyFor(url.origin, o);
    if (policy.kind === 'error') return policy.failure;
    const verdict = robotsVerdict(policy, url);
    if (!verdict.allowed) {
      return failure('ROBOTS_DISALLOWED', `${url.host}'s robots.txt does not allow MugBot to read ${url.pathname}${verdict.rule ? ` (${verdict.rule})` : ''}.`, {
        hint: policy.kind === 'disallow-all' ? 'robots.txt could not be read, which counts as a refusal for now (RFC 9309).' : 'The shop asks bots to stay out of this path, so Mug does.',
        // CONTRACTS A12: an unreadable robots.txt is a refusal for now, not a
        // rule, so the caller may ask once more later. A real Disallow never is.
        retryable: policy.kind === 'disallow-all' ? true : undefined,
        upstreamStatus: policy.status ?? undefined,
        url: url.href,
      });
    }

    if (!spend(o.budget)) return failure('UPSTREAM_ERROR', BUDGET_SPENT, { url: url.href });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    try {
      const res = await o.fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: ACCEPT[o.kind] },
        signal: controller.signal,
      });
      const status = res.status;
      const headers = res.headers;

      if (status >= 300 && status < 400 && status !== 304) {
        await discard(res);
        const location = headers.get('location');
        if (!location) return failure('UPSTREAM_ERROR', `${url.host} answered ${status} without a Location.`, { upstreamStatus: status, url: url.href });
        if (hop >= MAX_REDIRECTS) return failure('UPSTREAM_ERROR', `${url.host} redirected more than ${MAX_REDIRECTS} times.`, { upstreamStatus: status, url: url.href });
        try {
          current = new URL(location, url).href;
        } catch {
          return failure('UPSTREAM_ERROR', `${url.host} redirected to an address that does not parse.`, { upstreamStatus: status, url: url.href });
        }
        continue;
      }

      if (String(headers.get('cf-mitigated') || '').toLowerCase() === 'challenge' || BLOCKING_STATUSES.has(status)) {
        const peek = await readCapped(res.body, PEEK_BYTES, { truncate: true });
        const sign = detectChallenge({ headers, text: decodeText(peek.bytes, headers.get('content-type')), strict: false });
        return failure('UPSTREAM_BLOCKED', blockedMessage(url.href, status, sign), { hint: BLOCKED_HINT, upstreamStatus: status, url: url.href });
      }
      if (status < 200 || status > 299) {
        await discard(res);
        return failure('UPSTREAM_ERROR', `${url.host} answered ${status}.`, { upstreamStatus: status, url: url.href });
      }

      const declared = Number(headers.get('content-length'));
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        await discard(res);
        return failure('TOO_LARGE', `${url.host} sent ${declared} bytes, over the ${o.maxBytes}-byte cap.`, { upstreamStatus: status, url: url.href });
      }
      const read = await readCapped(res.body, o.maxBytes);
      if (read.over) return failure('TOO_LARGE', `${url.host} sent more than the ${o.maxBytes}-byte cap.`, { upstreamStatus: status, url: url.href });

      const contentType = headers.get('content-type') || '';
      if (looksLikeHtml(contentType, read.bytes)) {
        const sign = detectChallenge({ headers, text: decodeText(read.bytes.subarray(0, PEEK_BYTES), contentType), strict: true });
        if (sign) return failure('UPSTREAM_BLOCKED', `${url.host} answered ${status} with ${sign}.`, { hint: BLOCKED_HINT, upstreamStatus: status, url: url.href });
      }
      return {
        ok: true,
        url: url.href,
        status,
        headers,
        contentType,
        body: read.bytes,
        bytes: read.bytes.length,
        ms: Math.max(0, Math.round(o.now() - started)),
        redirects: hop,
      };
    } catch (err) {
      const out = classifyThrow(err, controller.signal.aborted, url.href);
      out.url = url.href;
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** { url, status, bytes, ms }: the `fetched` block C3 answers carry. */
export function fetchedOf(result) {
  return { url: result.url, status: result.status, bytes: result.bytes, ms: result.ms };
}
