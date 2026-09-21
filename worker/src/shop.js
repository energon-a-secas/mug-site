// ── Reading a shop: probe, discover, extract (C3) ────────────────────────────
//
// The three operations that turn a shop into listings, written against an
// injected fetch so the Worker and the local runner run this same file: the
// runner imports it, which is what makes "a listing read by the Worker and one
// read by the runner cannot differ" true for discovery as well as extraction.
// No Worker-only API is used here.
//
// ctx = { fetchImpl, robotsCache, env, budget, via: "worker" | "runner", now }.
// Every function answers an object: { ok: true, ... } or a C3 failure envelope.
//
// Sitemap indexes (jsonld adapter): C3 gives Convex nothing to recurse with,
// and Convex stages every returned URL as a product page, so the Worker
// recurses one level itself. A call on an index fetches the index and ONE child
// sitemap (robots, index, child: three subrequests) and answers up to 200 of
// the child's product URLs. `next.url` is the index URL again, with the
// position in its fragment ("#mug-child=1&mug-offset=200"); a fragment is never
// sent to the shop, and Convex passes `next.url` back verbatim (A1). A child
// that robots.txt refuses, that is missing, or that is itself an index is
// skipped (counted in `skipped`) rather than failing the scan.

import { fromHtml } from '../../shared/extract/html.js';
import { listingLinks, nextPageUrl, sitemapKind, sitemapUrls, wordFilter } from '../../shared/extract/listing-page.js';
import { sourceBrand } from '../../shared/extract/opengraph.js';
import { fromShopifyProduct, shopifyBase, shopifyHandle, shopifyJsonUrl, shopifyProductsUrl } from '../../shared/extract/shopify.js';
import { fromWooProduct, wooProductsUrl } from '../../shared/extract/woocommerce.js';
import { checkUrl } from '../../shared/net/guard.js';
import { CAPS, decodeText, fetchedOf, politeFetch, readCapped, robotsCheck } from '../../shared/net/polite.js';

export const ADAPTERS = Object.freeze(['shopify', 'woocommerce', 'jsonld']);
export const FEED_PAGE_SIZE = 50;
export const SITEMAP_PAGE_SIZE = 200;
export const MAX_PAGE = 1000;

function fail(code, message, extra = {}) {
  const out = { ok: false, code, message };
  if (extra.hint) out.hint = extra.hint;
  if (Number.isInteger(extra.upstreamStatus)) out.upstreamStatus = extra.upstreamStatus;
  return out;
}

function net(ctx, extra = {}) {
  return { fetchImpl: ctx.fetchImpl, robotsCache: ctx.robotsCache, env: ctx.env, budget: ctx.budget, ...extra };
}

function clock(ctx) {
  return typeof ctx.now === 'function' ? ctx.now() : Date.now();
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the shop';
  }
}

function parseJson(got) {
  try {
    return { ok: true, value: JSON.parse(decodeText(got.body, got.contentType)) };
  } catch {
    return fail('UPSTREAM_ERROR', `${hostOf(got.url)} answered with something that is not JSON.`, { upstreamStatus: got.status });
  }
}

// ── Request shapes ───────────────────────────────────────────────────────────

function parsesAsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** { ok: true, url } when body.url is an absolute http(s) URL, else BAD_REQUEST. */
export function validateUrlBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('BAD_REQUEST', 'The body has to be a JSON object.');
  if (!parsesAsUrl(body.url)) return fail('BAD_REQUEST', '`url` has to be an absolute http or https URL.');
  return { ok: true, url: body.url.trim(), brand: sourceBrand(body.brand) };
}

function wordList(value, name) {
  if (value === undefined || value === null) return { ok: true, words: [] };
  if (!Array.isArray(value) || value.some((w) => typeof w !== 'string')) return fail('BAD_REQUEST', `\`${name}\` has to be an array of strings.`);
  const words = [...new Set(value.map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 30).map((w) => w.slice(0, 40));
  return { ok: true, words };
}

/** C3 /v1/discover's body, checked: { adapter, url, page?, include?, exclude?, brand? (A6) }. */
export function validateDiscover(body) {
  const base = validateUrlBody(body);
  if (!base.ok) return base;
  if (body.adapter === 'manual') return fail('BAD_REQUEST', 'A manual source has nothing to discover.');
  if (!ADAPTERS.includes(body.adapter)) return fail('BAD_REQUEST', '`adapter` has to be shopify, woocommerce or jsonld.');
  const page = body.page === undefined || body.page === null ? 1 : body.page;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return fail('BAD_REQUEST', `\`page\` has to be a whole number from 1 to ${MAX_PAGE}.`);
  const include = wordList(body.include, 'include');
  if (!include.ok) return include;
  const exclude = wordList(body.exclude, 'exclude');
  if (!exclude.ok) return exclude;
  return { ok: true, adapter: body.adapter, url: base.url, page, include: include.words, exclude: exclude.words, brand: base.brand };
}

// ── probe ────────────────────────────────────────────────────────────────────

const HARD_FAILURES = ['UPSTREAM_BLOCKED', 'UPSTREAM_TIMEOUT'];

/**
 * C3 /v1/probe: the robots verdict for the URL's own path, and the platform:
 * /products.json?limit=1 answering { products: [] } is Shopify, else
 * /wp-json/wc/store/v1/products?per_page=1 answering an array is WooCommerce,
 * else unknown. `status` is the HTTP status of the last detection answer.
 */
export async function probe({ url }, ctx) {
  const checked = checkUrl(url, { env: ctx.env });
  if (!checked.ok) return checked;
  const robots = await robotsCheck(checked.url.href, net(ctx));
  if (!robots.ok) return robots;
  const verdict = { allowed: robots.allowed, rule: robots.rule };
  const origin = checked.url.origin;
  const errors = [];
  let status = null;

  const shop = await politeFetch(`${origin}/products.json?limit=1`, net(ctx, { kind: 'json' }));
  if (shop.ok) {
    status = shop.status;
    const data = parseJson(shop);
    if (data.ok && data.value && typeof data.value === 'object' && !Array.isArray(data.value) && Array.isArray(data.value.products)) {
      return { ok: true, robots: verdict, platform: 'shopify', status };
    }
  } else {
    errors.push(shop);
    if (shop.upstreamStatus) status = shop.upstreamStatus;
  }

  const woo = await politeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=1`, net(ctx, { kind: 'json' }));
  if (woo.ok) {
    status = woo.status;
    const data = parseJson(woo);
    if (data.ok && Array.isArray(data.value)) return { ok: true, robots: verdict, platform: 'woocommerce', status };
  } else {
    errors.push(woo);
    if (woo.upstreamStatus) status = woo.upstreamStatus;
  }

  // A shop that refused both questions is reported as refusing, so the admin
  // learns this source needs the runner; anything else is simply "unknown".
  if (errors.length === 2 && errors.every((e) => HARD_FAILURES.includes(e.code))) return errors[0];
  return { ok: true, robots: verdict, platform: 'unknown', status };
}

// ── discover ─────────────────────────────────────────────────────────────────

function listingText(listing) {
  return [listing.name, listing.productType, ...(listing.tags || [])].filter(Boolean).join(' \n ');
}

/** Normalised listings minus "not a mug" and the source's word filters; the rest counted as skipped. */
function keepListings(results, { include, exclude }) {
  const filter = wordFilter({ include, exclude });
  const listings = [];
  let skipped = 0;
  for (const r of results) {
    if (!r.ok || r.listing.isMug.verdict === 'no' || filter(listingText(r.listing)) !== 'keep') skipped++;
    else listings.push(r.listing);
  }
  return { listings, skipped };
}

async function discoverShopify({ url, page, include, exclude, brand }, ctx) {
  const got = await politeFetch(shopifyProductsUrl(url, page), net(ctx, { kind: 'json' }));
  if (!got.ok) return got;
  const data = parseJson(got);
  if (!data.ok) return data;
  const products = data.value && typeof data.value === 'object' && Array.isArray(data.value.products) ? data.value.products : null;
  if (!products) return fail('UPSTREAM_ERROR', `${hostOf(got.url)} did not answer with a Shopify products feed.`, { upstreamStatus: got.status });
  const baseUrl = shopifyBase(url);
  const now = clock(ctx);
  const { listings, skipped } = keepListings(products.map((p) => fromShopifyProduct(p, { baseUrl, via: ctx.via, now, brand })), { include, exclude });
  return { ok: true, listings, skipped, next: products.length >= FEED_PAGE_SIZE ? { page: page + 1 } : null, fetched: fetchedOf(got) };
}

async function discoverWoo({ url, page, include, exclude, brand }, ctx) {
  const got = await politeFetch(wooProductsUrl(url, { page, search: include[0] }), net(ctx, { kind: 'json' }));
  if (!got.ok) return got;
  const data = parseJson(got);
  if (!data.ok) return data;
  if (!Array.isArray(data.value)) return fail('UPSTREAM_ERROR', `${hostOf(got.url)} did not answer with a WooCommerce Store API product list.`, { upstreamStatus: got.status });
  const baseUrl = new URL(url).origin;
  const now = clock(ctx);
  const { listings, skipped } = keepListings(data.value.map((p) => fromWooProduct(p, { baseUrl, via: ctx.via, now, brand })), { include, exclude });
  const totalPages = Number(got.headers && got.headers.get('x-wp-totalpages'));
  const more = Number.isInteger(totalPages) && totalPages > 0 ? page < totalPages : data.value.length >= FEED_PAGE_SIZE;
  return { ok: true, listings, skipped, next: more ? { page: page + 1 } : null, fetched: fetchedOf(got) };
}

/** Sitemaps may be served gzipped (.xml.gz); inflated under the same cap. */
async function inflate(got) {
  const bytes = got.body;
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return { ok: true, bytes };
  if (typeof DecompressionStream !== 'function') return fail('UPSTREAM_ERROR', 'The sitemap is gzipped and this runtime cannot inflate it.');
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const read = await readCapped(stream, CAPS.page);
    if (read.over) return fail('TOO_LARGE', `The sitemap inflates past the ${CAPS.page}-byte cap.`);
    return { ok: true, bytes: read.bytes };
  } catch {
    return fail('UPSTREAM_ERROR', 'The gzipped sitemap does not inflate.', { upstreamStatus: got.status });
  }
}

function sitemapPosition(raw) {
  let hash = '';
  try {
    hash = new URL(raw).hash.replace(/^#/, '');
  } catch {
    hash = '';
  }
  const params = new URLSearchParams(hash);
  const child = Number(params.get('mug-child'));
  const offset = Number(params.get('mug-offset'));
  return {
    child: Number.isInteger(child) && child >= 0 ? child : 0,
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
  };
}

function withPosition(indexUrl, child, offset) {
  const u = new URL(indexUrl);
  u.hash = `mug-child=${child}&mug-offset=${offset}`;
  return u.href;
}

// A child sitemap failing in one of these ways is skipped, not retried.
const SKIP_CHILD = ['ROBOTS_DISALLOWED', 'URL_NOT_ALLOWED', 'TOO_LARGE'];

async function discoverIndex(got, text, { url, page, include, exclude }, ctx) {
  const index = sitemapUrls(text, { url: got.url });
  const { child, offset } = sitemapPosition(url);
  const children = index.urls;
  const firstCall = child === 0 && offset === 0;
  if (child >= children.length) return { ok: true, urls: [], skipped: firstCall ? index.skipped : 0, next: null, fetched: fetchedOf(got) };
  const nextChild = child + 1 < children.length ? { page: page + 1, url: withPosition(got.url, child + 1, 0) } : null;
  const skipChild = (fetched) => ({ ok: true, urls: [], skipped: 1 + (firstCall ? index.skipped : 0), next: nextChild, fetched });

  const sub = await politeFetch(children[child], net(ctx, { kind: 'page' }));
  if (!sub.ok) {
    const missing = sub.code === 'UPSTREAM_ERROR' && sub.upstreamStatus >= 400 && sub.upstreamStatus < 500;
    return SKIP_CHILD.includes(sub.code) || missing ? skipChild(fetchedOf(got)) : sub;
  }
  const inflated = await inflate(sub);
  if (!inflated.ok) return inflated.code === 'TOO_LARGE' ? skipChild(fetchedOf(sub)) : inflated;
  const childText = decodeText(inflated.bytes, sub.contentType);
  if (sitemapKind(childText) !== 'urlset') return skipChild(fetchedOf(sub));
  const r = sitemapUrls(childText, { url: sub.url, include, exclude, offset, limit: SITEMAP_PAGE_SIZE });
  const next = offset + SITEMAP_PAGE_SIZE < r.total ? { page: page + 1, url: withPosition(got.url, child, offset + SITEMAP_PAGE_SIZE) } : nextChild;
  return { ok: true, urls: r.urls, skipped: r.skipped + (firstCall ? index.skipped : 0), next, fetched: fetchedOf(sub) };
}

async function discoverJsonld(args, ctx) {
  const { url, page, include, exclude } = args;
  const got = await politeFetch(url, net(ctx, { kind: 'page' }));
  if (!got.ok) return got;
  const inflated = await inflate(got);
  if (!inflated.ok) return inflated;
  const text = decodeText(inflated.bytes, got.contentType);
  const kind = sitemapKind(text);
  if (kind === 'index') return discoverIndex(got, text, args, ctx);
  if (kind === 'urlset') {
    const offset = (page - 1) * SITEMAP_PAGE_SIZE;
    const r = sitemapUrls(text, { url: got.url, include, exclude, offset, limit: SITEMAP_PAGE_SIZE });
    return { ok: true, urls: r.urls, skipped: r.skipped, next: offset + SITEMAP_PAGE_SIZE < r.total ? { page: page + 1 } : null, fetched: fetchedOf(got) };
  }
  const links = listingLinks(text, { url: got.url, include, exclude });
  const nextUrl = nextPageUrl(text, { url: got.url });
  return { ok: true, urls: links.urls, skipped: links.skipped, next: nextUrl ? { page: page + 1, url: nextUrl } : null, fetched: fetchedOf(got) };
}

/**
 * C3 /v1/discover, one shop page per call. Takes validateDiscover()'s output.
 * shopify and woocommerce answer `listings`; jsonld answers `urls`.
 */
export async function discover(args, ctx) {
  if (args.adapter === 'shopify') return discoverShopify(args, ctx);
  if (args.adapter === 'woocommerce') return discoverWoo(args, ctx);
  if (args.adapter === 'jsonld') return discoverJsonld(args, ctx);
  return fail('BAD_REQUEST', '`adapter` has to be shopify, woocommerce or jsonld.');
}

// ── extract ──────────────────────────────────────────────────────────────────

// Any JSON miss falls back to the HTML, a refusal included (a shop may guard
// its .json endpoints and still serve product pages), except a timeout: a
// second 15 s wait would outlast the 30 s Convex gives the whole call
// (convex/lib/proxy.ts), so the timeout is answered as it is.
const STOP_AFTER_JSON = ['UPSTREAM_TIMEOUT', 'URL_NOT_ALLOWED'];

/**
 * C3 /v1/extract. A Shopify-style /products/<handle> path tries <url>.json
 * first; everything else (and a JSON miss) reads the HTML with fromHtml
 * (JSON-LD, then OpenGraph). No product found is NOT_A_PRODUCT.
 */
export async function extract({ url, brand }, ctx) {
  const checked = checkUrl(url, { env: ctx.env });
  if (!checked.ok) return checked;
  const now = clock(ctx);
  if (shopifyHandle(checked.url.pathname)) {
    const got = await politeFetch(shopifyJsonUrl(checked.url.href), net(ctx, { kind: 'json' }));
    if (got.ok) {
      const data = parseJson(got);
      const product = data.ok && data.value && typeof data.value === 'object' ? data.value.product : null;
      if (product && typeof product === 'object') {
        const r = fromShopifyProduct(product, { baseUrl: shopifyBase(checked.url.href), via: ctx.via, now, brand });
        if (r.ok) return { ok: true, listing: r.listing, fetched: fetchedOf(got) };
      }
    } else if (STOP_AFTER_JSON.includes(got.code)) {
      return got;
    }
  }
  const page = await politeFetch(checked.url.href, net(ctx, { kind: 'page' }));
  if (!page.ok) return page;
  const r = fromHtml(decodeText(page.body, page.contentType), { url: page.url, via: ctx.via, now, brand });
  if (!r.ok) {
    return fail('NOT_A_PRODUCT', `${hostOf(page.url)} answered, but the page carries no product data (${r.message})`, {
      hint: 'Mug reads JSON-LD Product and OpenGraph product tags; a page with neither can be pasted by hand.',
    });
  }
  return { ok: true, listing: r.listing, fetched: fetchedOf(page) };
}
