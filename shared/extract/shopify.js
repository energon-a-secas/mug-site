// ── Shopify: products.json and /products/<handle>.json ───────────────────────
//
// Every Shopify shop publishes its catalogue as JSON at /products.json (and a
// collection's at /collections/<handle>/products.json), so a Shopify source
// needs no HTML at all (C2). This file knows that shape and the shop's URL
// layout; the fetching is the Worker's and the runner's.
//
// products.json carries no currency, so a price is only kept when the
// product JSON itself names one (price_currency, presentment_prices) or the
// caller passes a currency it read honestly elsewhere. A guessed currency is
// a wrong fact; a missing one is shown as missing.
//
// A6: a shop's `vendor` is often the licence rather than the maker. When the
// caller passes the source's own brand, that is the brand and the vendor
// becomes a tag (and the franchise, when it names one).

import { normalizeGtin } from './names.js';
import { listingKey, normalizeListing } from './normalize.js';
import { brandFields } from './opengraph.js';

const LOCALE = /^\/[a-z]{2}(?:-[a-z]{2,4})?$/i;

/**
 * The shop's base for product URLs: its origin, plus a market locale prefix
 * when the URL has one ("https://shop.com/fr/collections/mugs" gives
 * "https://shop.com/fr").
 */
export function shopifyBase(raw) {
  const url = new URL(raw);
  let path = url.pathname;
  const collections = path.indexOf('/collections/');
  const products = path.indexOf('/products');
  const cut = [collections, products].filter((i) => i >= 0);
  path = cut.length ? path.slice(0, Math.min(...cut)) : path.replace(/\/+$/, '');
  return LOCALE.test(path) ? `${url.origin}${path}` : url.origin;
}

/** C3: <url without trailing slash>/products.json?limit=50&page=N, or the URL as-is when it already ends so. */
export function shopifyProductsUrl(raw, page = 1) {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/products.json')) path = `${path}/products.json`;
  url.pathname = path;
  url.searchParams.set('limit', '50');
  url.searchParams.set('page', String(page));
  return url.href;
}

const PRODUCT_PATH = /^(?:\/[a-z]{2}(?:-[a-z]{2,4})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+?)\/?$/i;

/** The handle when the path is a Shopify product page (/products/<handle>, optionally under a locale or collection). */
export function shopifyHandle(pathname) {
  const m = PRODUCT_PATH.exec(String(pathname || ''));
  if (!m || m[1].endsWith('.json') || m[1].endsWith('.js')) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The product JSON URL for a Shopify product page: <page without query or slash>.json. */
export function shopifyJsonUrl(raw) {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}.json`;
  return url.href;
}

function currencyOf(variant, fallback) {
  if (!variant) return fallback;
  if (typeof variant.price_currency === 'string' && variant.price_currency) return variant.price_currency;
  const presented = Array.isArray(variant.presentment_prices) ? variant.presentment_prices[0] : null;
  const code = presented && presented.price && presented.price.currency_code;
  return typeof code === 'string' && code ? code : fallback;
}

function tagsOf(tags) {
  if (typeof tags === 'string') return tags.split(',');
  return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
}

function imagesOf(product) {
  const out = [];
  for (const image of Array.isArray(product.images) ? product.images : []) {
    const src = typeof image === 'string' ? image : image && image.src;
    if (typeof src === 'string' && src) out.push(src);
  }
  if (!out.length && product.image && typeof product.image.src === 'string') out.push(product.image.src);
  return out;
}

function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/**
 * C1.1: one item of products.json (or the `product` of /products/<handle>.json)
 * as a listing. `baseUrl` is what shopifyBase() answers for the shop; the key
 * is <host>/products/<handle>. `brand` is A6's source brand, `currency` an
 * honestly known shop currency.
 */
export function fromShopifyProduct(product, { baseUrl, via = 'worker', now = Date.now(), brand, currency } = {}) {
  if (!product || typeof product !== 'object') return { ok: false, code: 'bad-source', message: 'A Shopify product has to be an object.' };
  const handle = firstString(product.handle);
  if (!handle) return { ok: false, code: 'bad-source', message: 'The Shopify product has no handle.' };
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/products/${encodeURIComponent(handle)}`;
  const variants = (Array.isArray(product.variants) ? product.variants : []).filter((v) => v && typeof v === 'object');
  const chosen = variants.find((v) => v.available === true) || variants[0] || null;
  const flags = variants.map((v) => v.available).filter((a) => typeof a === 'boolean');
  const ordered = chosen ? [chosen, ...variants.filter((v) => v !== chosen)] : variants;
  const barcode = ordered.map((v) => v.barcode).find((code) => normalizeGtin(code));
  const cur = currencyOf(chosen, typeof currency === 'string' ? currency : undefined);
  const b = brandFields(product.vendor, brand);

  const input = {
    source: { url, key: listingKey({ url: base || url, platform: 'shopify', handle }), platform: 'shopify', via, fetchedAt: now },
    name: product.title,
    brand: b.brand,
    franchise: b.franchise,
    vendor: b.vendor,
    sku: firstString(...ordered.map((v) => v.sku)),
    gtin: barcode,
    price: chosen && cur && chosen.price !== undefined && chosen.price !== null ? { amount: chosen.price, currency: cur } : undefined,
    available: flags.length ? flags.includes(true) : undefined,
    images: imagesOf(product),
    description: product.body_html,
    tags: [...tagsOf(product.tags), ...b.tags],
    productType: product.product_type,
  };
  return normalizeListing(input, { now });
}
