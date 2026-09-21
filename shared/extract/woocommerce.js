// ── WooCommerce: the Store API's product shape ───────────────────────────────
//
// WooCommerce shops answer /wp-json/wc/store/v1/products without a key, with
// prices in minor units beside the currency and its minor-unit count, so a
// Woo price is exact where a Shopify one is often absent (C2). Capacity,
// material, brand and barcode are read from product attributes when the shop
// set them; everything else is left to normalizeListing.

import { detectMaterial, parseCapacityMl } from './facts.js';
import { fold } from './names.js';
import { hostOf, listingKey, normalizeListing } from './normalize.js';
import { brandFields } from './opengraph.js';

/**
 * C3: <origin>/wp-json/wc/store/v1/products?per_page=50&page=N, plus
 * &search=<word> when a search word is given. A URL that already points at
 * the Store API products route keeps its own path.
 */
export function wooProductsUrl(raw, { page = 1, search } = {}) {
  const url = new URL(raw);
  const api = /\/wp-json\/wc\/store(?:\/v1)?\/products\/?$/.test(url.pathname);
  const out = new URL(api ? `${url.origin}${url.pathname.replace(/\/+$/, '')}` : `${url.origin}/wp-json/wc/store/v1/products`);
  out.searchParams.set('per_page', '50');
  out.searchParams.set('page', String(page));
  if (search) out.searchParams.set('search', String(search));
  return out.href;
}

const CAPACITY_ATTR = /capacit|volume|contenance|capacidad|fassungsverm|inhalt/;
const MATERIAL_ATTR = /material|matiere|materiau/;
const BRAND_ATTR = /^(?:brand|marque|marca|marke|hersteller|manufacturer)$/;
const GTIN_ATTR = /^(?:gtin|ean|upc|barcode|ean13|gtin13)$/;

function attributeText(attributes, re) {
  for (const attr of Array.isArray(attributes) ? attributes : []) {
    if (!attr || typeof attr !== 'object' || !re.test(fold(attr.name).trim())) continue;
    const terms = (Array.isArray(attr.terms) ? attr.terms : Array.isArray(attr.options) ? attr.options : [])
      .map((t) => (typeof t === 'string' ? t : t && t.name))
      .filter((t) => typeof t === 'string' && t.trim());
    if (terms.length) return terms.join(', ');
    if (typeof attr.value === 'string' && attr.value.trim()) return attr.value;
  }
  return undefined;
}

function names(list) {
  return (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter((n) => typeof n === 'string' && n.trim());
}

function priceOf(prices) {
  if (!prices || typeof prices !== 'object') return undefined;
  const minor = Number(prices.currency_minor_unit);
  const raw = prices.price !== undefined && prices.price !== '' ? prices.price : prices.price_range && prices.price_range.min_amount;
  const amount = Number(raw);
  if (!Number.isInteger(minor) || minor < 0 || minor > 4 || !Number.isFinite(amount) || amount <= 0) return undefined;
  return { amount: amount / 10 ** minor, currency: prices.currency_code };
}

/**
 * C1.1: one Store API product as a listing. `baseUrl` is the shop's origin;
 * the key is <host>/p/<id> (C1.2). `brand` is A6's source brand.
 */
export function fromWooProduct(product, { baseUrl, via = 'worker', now = Date.now(), brand } = {}) {
  if (!product || typeof product !== 'object') return { ok: false, code: 'bad-source', message: 'A WooCommerce product has to be an object.' };
  const id = product.id;
  if (!(typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))) {
    return { ok: false, code: 'bad-source', message: 'The WooCommerce product has no numeric id.' };
  }
  const base = String(baseUrl || '').replace(/\/+$/, '');
  // A14: the shop's own permalink only when it is on the shop's host. It is
  // the public "buy it here" link (C11), so another host would be the shop's
  // feed choosing where visitors are sent.
  const offered = typeof product.permalink === 'string' && /^https?:\/\//i.test(product.permalink) ? product.permalink : '';
  const permalink = offered && hostOf(offered) && hostOf(offered) === hostOf(base) ? offered : `${base}/?p=${id}`;
  const capacityText = attributeText(product.attributes, CAPACITY_ATTR);
  const materialText = attributeText(product.attributes, MATERIAL_ATTR);
  const shopBrand = names(product.brands)[0] || attributeText(product.attributes, BRAND_ATTR);
  const b = brandFields(shopBrand, brand);
  const categories = names(product.categories);

  const input = {
    source: { url: permalink, key: listingKey({ url: base || permalink, platform: 'woocommerce', id }), platform: 'woocommerce', via, fetchedAt: now },
    name: product.name,
    brand: b.brand,
    franchise: b.franchise,
    vendor: b.vendor,
    sku: typeof product.sku === 'string' ? product.sku : undefined,
    gtin: product.global_unique_id || attributeText(product.attributes, GTIN_ATTR),
    price: priceOf(product.prices),
    available: typeof product.is_in_stock === 'boolean' ? product.is_in_stock : undefined,
    images: (Array.isArray(product.images) ? product.images : []).map((img) => (typeof img === 'string' ? img : img && img.src)).filter(Boolean),
    description: product.description || product.short_description,
    capacityMl: capacityText ? parseCapacityMl(capacityText) : undefined,
    material: materialText ? detectMaterial(materialText) : undefined,
    tags: [...names(product.tags), ...b.tags],
    productType: categories[0],
  };
  return normalizeListing(input, { now });
}
