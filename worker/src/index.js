// ── mug-proxy: Mug's Cloudflare Worker (docs/CONTRACTS.md C3, C4, C10) ────────
//
// Fetches third-party shop pages and images for Convex, politely, and keeps
// images in R2. It holds no catalogue state and trusts nobody but Convex:
//
//   GET    /health                  public, booleans only
//   GET    /i/<key>                 public, an R2 image, immutable
//   POST   /v1/probe                robots verdict and platform for a shop
//   POST   /v1/discover             one page of a shop's product feed or listing
//   POST   /v1/extract              one product page as a Listing
//   POST   /v1/images/mirror        a shop image into R2
//   PUT    /v1/images/put?kind=     bytes from Convex into R2
//   DELETE /v1/images/<key>         an R2 image out
//
// Every POST, PUT and DELETE needs the bearer secret (auth.js); every failure
// is the C3 envelope on C3's status (errors.js); a bug answers INTERNAL as
// JSON instead of the runtime's HTML 500 page. Shop reading lives in shop.js,
// which the local runner imports too.
//
// Free plan: one shop page per call, and a budget of SUBREQUEST_BUDGET fetches
// per invocation (typically robots.txt, the page, and a redirect hop or two).
// robots.txt is cached per isolate for an hour (C10.2). Both live in runtime.js.

import { devLoopback } from '../../shared/net/guard.js';
import { readCapped } from '../../shared/net/polite.js';
import { authorize } from './auth.js';
import { ERROR_CODES, WORKER_VERSION, envelope, json, respond } from './errors.js';
import { deleteImage, imageOptions, mirrorImage, notConfigured, putImage, serveImage } from './images.js';
import { SUBREQUEST_BUDGET, robotsCache } from './runtime.js';
import { discover, extract, probe, validateDiscover, validateUrlBody } from './shop.js';

// The main module exports its handler and ERROR_CODES only: workerd reads every
// named export as an entrypoint and refuses a number or a string (runtime.js).
// Convex's tests hold convex/lib/proxy.ts PROXY_CODES equal to ERROR_CODES.
export { ERROR_CODES };

const JSON_BODY_CAP = 64 * 1024;

const ROUTES = {
  '/health': ['GET', 'HEAD'],
  '/v1/probe': ['POST'],
  '/v1/discover': ['POST'],
  '/v1/extract': ['POST'],
  '/v1/images/mirror': ['POST'],
  '/v1/images/put': ['PUT'],
};

async function readJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > JSON_BODY_CAP) return envelope('TOO_LARGE', `A JSON body is capped at ${JSON_BODY_CAP} bytes.`);
  const read = await readCapped(request.body, JSON_BODY_CAP);
  if (read.over) return envelope('TOO_LARGE', `A JSON body is capped at ${JSON_BODY_CAP} bytes.`);
  try {
    const value = JSON.parse(new TextDecoder().decode(read.bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return envelope('BAD_REQUEST', 'The body has to be a JSON object.');
    return { ok: true, value };
  } catch {
    return envelope('BAD_REQUEST', 'The body is not valid JSON.');
  }
}

function context(env) {
  return {
    fetchImpl: (url, init) => fetch(url, init),
    robotsCache,
    env,
    budget: { left: SUBREQUEST_BUDGET },
    via: 'worker',
  };
}

function health(env) {
  return json({
    ok: true,
    version: WORKER_VERSION,
    r2: !!env.IMAGES,
    token: !!env.MUG_PROXY_TOKEN,
    devLoopback: devLoopback(env),
  });
}

async function handleWrite(request, env, path, method) {
  const denied = await authorize(request, env);
  if (denied) return respond(denied);

  if (method === 'DELETE' && path.startsWith('/v1/images/')) {
    if (!env.IMAGES) return respond(notConfigured());
    return respond(await deleteImage(path.slice('/v1/images/'.length), env.IMAGES));
  }
  if (method === 'PUT' && path === '/v1/images/put') {
    if (!env.IMAGES) return respond(notConfigured());
    return respond(await putImage(request, new URL(request.url).searchParams.get('kind'), env.IMAGES));
  }
  if (method !== 'POST' || !ROUTES[path] || !ROUTES[path].includes('POST')) return null;

  if (path === '/v1/images/mirror' && !env.IMAGES) return respond(notConfigured());
  const body = await readJson(request);
  if (!body.ok) return respond(body);
  const ctx = context(env);

  if (path === '/v1/discover') {
    const args = validateDiscover(body.value);
    return respond(args.ok ? await discover(args, ctx) : args);
  }
  const args = validateUrlBody(body.value);
  if (!args.ok) return respond(args);
  if (path === '/v1/probe') return respond(await probe(args, ctx));
  if (path === '/v1/extract') return respond(await extract(args, ctx));
  return respond(await mirrorImage(args, ctx, env.IMAGES));
}

async function route(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (path.startsWith('/i/')) {
    if (method === 'OPTIONS') return imageOptions();
    if (method === 'GET' || method === 'HEAD') return serveImage(request, path.slice(3), env.IMAGES);
    return respond(envelope('BAD_REQUEST', 'Images are read with GET.'), { allow: 'GET, HEAD, OPTIONS' });
  }
  if (path === '/health' && (method === 'GET' || method === 'HEAD')) return health(env);

  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const answer = await handleWrite(request, env, path, method);
    if (answer) return answer;
  }
  if (ROUTES[path]) {
    return respond(envelope('BAD_REQUEST', `${path} answers ${ROUTES[path].join(' and ')} only.`), { allow: ROUTES[path].join(', ') });
  }
  return respond(envelope('NOT_FOUND', 'That path is not a route on this Worker.', { hint: 'The routes are listed in worker/README.md.' }));
}

export default {
  /**
   * C3: "a Worker bug still answers INTERNAL as JSON". An uncaught throw in a
   * fetch handler would reach Convex as the runtime's HTML error page, so the
   * router is wrapped and a throw becomes the envelope Convex already handles
   * (retry once later). The log line is for the operator.
   */
  async fetch(request, env) {
    try {
      return await route(request, env || {});
    } catch (err) {
      console.error('mug-proxy threw:', err && err.stack ? err.stack : err);
      return respond(envelope('INTERNAL', 'The Worker hit an error it did not expect.', { hint: 'Retry once later; the Worker log has the details.' }));
    }
  },
};
