// ── The C3 envelope ──────────────────────────────────────────────────────────
//
// Every answer this Worker gives is JSON (except the image bytes of /i/), and
// every failure carries one of ERROR_CODES on the HTTP status C3 assigns it.
// Convex deploys separately and switches on `code`, so the list is exported and
// a test holds Convex's own list (convex/lib/proxy.ts PROXY_CODES) equal to it.
// Additive only: renaming a code breaks that test on purpose.

export const WORKER_VERSION = '1.0.0';

export const ERROR_CODES = Object.freeze([
  'UNAUTHORIZED',
  'BAD_REQUEST',
  'URL_NOT_ALLOWED',
  'ROBOTS_DISALLOWED',
  'UPSTREAM_BLOCKED',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'TOO_LARGE',
  'NOT_A_PRODUCT',
  'NOT_AN_IMAGE',
  'NOT_CONFIGURED',
  'NOT_FOUND',
  'INTERNAL',
]);

/** C3's status for each code. */
export const HTTP_STATUS = Object.freeze({
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  URL_NOT_ALLOWED: 400,
  ROBOTS_DISALLOWED: 403,
  UPSTREAM_BLOCKED: 502,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  TOO_LARGE: 413,
  NOT_A_PRODUCT: 422,
  NOT_AN_IMAGE: 422,
  NOT_CONFIGURED: 501,
  NOT_FOUND: 404,
  INTERNAL: 500,
});

/** { ok: false, code, message, hint?, upstreamStatus?, retryable? }: the one failure shape. */
export function envelope(code, message, extra = {}) {
  const out = { ok: false, code: ERROR_CODES.includes(code) ? code : 'INTERNAL', message: String(message || code) };
  if (extra.hint) out.hint = String(extra.hint);
  if (Number.isInteger(extra.upstreamStatus)) out.upstreamStatus = extra.upstreamStatus;
  if (extra.retryable === true) out.retryable = true;
  return out;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * A Response for an operation's result: 200 for { ok: true }, C3's status for a
 * failure. Failures are rebuilt through envelope() so nothing internal (a
 * fetched URL, a stack) leaks into the answer by accident.
 */
export function respond(result, headers = {}) {
  if (result && result.ok === true) return json(result, 200, headers);
  const failure = envelope(result && result.code, result && result.message, result || {});
  return json(failure, HTTP_STATUS[failure.code] || 500, headers);
}
