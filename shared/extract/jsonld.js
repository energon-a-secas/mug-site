// ── JSON-LD: the product a page describes for search engines ─────────────────
//
// Most shop platforms print a schema.org Product in a
// <script type="application/ld+json"> block, and it is the most honest
// structured source on a product page (C1.1: JSON-LD first, OpenGraph second).
// Shops write it by hand as often as not, so the reader tolerates what real
// pages carry: several blocks, @graph, arrays, ProductGroup with hasVariant,
// AggregateOffer, trailing commas, raw newlines inside strings, CDATA and
// comment wrappers, and JSON that was HTML-escaped a second time.
//
// A page whose only products sit inside an ItemList is a listing, not a
// product page, so the walk never descends into itemListElement.

import { detectMaterial, parseCapacityMl } from './facts.js';
import { collapse } from './names.js';
import { absoluteUrl, baseHref, canonicalOf, cleanAmount, decodeAttr, pageListing } from './opengraph.js';

const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
const PRODUCT_TYPES = new Set(['product', 'productgroup', 'individualproduct', 'productmodel', 'someproducts']);
// Keys that lead to other products (related, similar, reviewed) or to listings.
const SKIP_KEYS = new Set([
  'itemlistelement', 'isrelatedto', 'issimilarto', 'isaccessoryorsparepartfor', 'isconsumablefor',
  'review', 'reviews', 'aggregaterating', 'breadcrumb', 'potentialaction', 'relatedlink', 'significantlink',
]);
const MAX_NODES = 5000;

/** Makes near-JSON parseable: trailing commas dropped, raw control characters in strings escaped. */
export function repairJson(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += c;
      } else if (c === '\\') {
        escaped = true;
        out += c;
      } else if (c === '"') {
        inString = false;
        out += c;
      } else {
        const code = c.charCodeAt(0);
        out += code >= 0x20 ? c : code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : ' ';
      }
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function unwrap(body) {
  return String(body)
    .replace(/^\s*(?:\/\/\s*)?<!\[CDATA\[/, '')
    .replace(/(?:\/\/\s*)?\]\]>\s*$/, '')
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .trim();
}

/** Every JSON-LD block in the page that parses (after repair), in order. */
export function jsonLdBlocks(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(SCRIPT)) {
    if (!/\btype\s*=\s*["']?\s*application\/ld\+json/i.test(m[1])) continue;
    const body = unwrap(m[2]);
    if (!body) continue;
    let parsed = tryParse(body);
    if (!parsed.ok) parsed = tryParse(repairJson(body));
    if (!parsed.ok && /&(?:quot|#34|#x22|amp);/i.test(body)) parsed = tryParse(repairJson(decodeAttr(body)));
    if (parsed.ok) out.push(parsed.value);
  }
  return out;
}

/** The local names of a node's @type, lowercased: "schema:Product" and "https://schema.org/Product" are "product". */
export function typesOf(node) {
  if (!node || typeof node !== 'object') return [];
  const raw = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return raw.filter((t) => typeof t === 'string').map((t) => t.split(/[/#:]/).pop().toLowerCase());
}

/** The first Product or ProductGroup, breadth first, so a page's main entity wins over nested ones. */
export function findProduct(values) {
  const queue = [...values];
  for (let seen = 0; queue.length && seen < MAX_NODES; seen++) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (typesOf(node).some((t) => PRODUCT_TYPES.has(t))) return node;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && !SKIP_KEYS.has(key.toLowerCase())) queue.push(value);
    }
  }
  return null;
}

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A plain string from a JSON-LD value: strings, numbers, {@value}, {name}, or the first of an array. */
function text(value) {
  if (typeof value === 'string') return collapse(value) || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = text(v);
      if (t) return t;
    }
    return undefined;
  }
  if (value && typeof value === 'object') return text(value['@value'] ?? value.name);
  return undefined;
}

function brandName(value) {
  for (const b of list(value)) {
    const name = typeof b === 'string' ? collapse(b) : b && typeof b === 'object' ? text(b.name) : undefined;
    if (name) return name;
  }
  return undefined;
}

function imagesOf(value, base) {
  const out = [];
  for (const item of list(value)) {
    const src = typeof item === 'string' ? item : item && typeof item === 'object' ? (item.url ?? item.contentUrl) : undefined;
    for (const s of list(src)) {
      const abs = typeof s === 'string' ? absoluteUrl(decodeAttr(s), base) : null;
      if (abs) out.push(abs);
    }
  }
  return out;
}

const GTIN_KEYS = ['gtin13', 'gtin12', 'gtin14', 'gtin8', 'gtin', 'ean'];

function gtinOf(node) {
  if (!node || typeof node !== 'object') return undefined;
  for (const key of GTIN_KEYS) {
    const t = text(node[key]);
    if (t && /\d{8,14}/.test(t.replace(/\D/g, ''))) return t;
  }
  return undefined;
}

function availableOf(value) {
  const t = text(value);
  if (!t) return undefined;
  const name = t.split(/[/#:]/).pop().toLowerCase();
  return name === 'instock' || name === 'limitedavailability';
}

/** The first offer with a usable price: offers may be an object, an array, or an AggregateOffer. */
function pickOffer(offers) {
  const flat = [];
  for (const o of list(offers)) {
    if (!o || typeof o !== 'object') continue;
    flat.push(o);
    if (o.offers) flat.push(...list(o.offers).filter((x) => x && typeof x === 'object'));
  }
  let chosen = null;
  for (const o of flat) {
    const spec = list(o.priceSpecification).find((s) => s && typeof s === 'object' && (s.price !== undefined || s.minPrice !== undefined));
    const amount = o.price ?? o.lowPrice ?? (spec ? spec.price ?? spec.minPrice : undefined);
    const currency = text(o.priceCurrency) ?? (spec ? text(spec.priceCurrency) : undefined);
    if (amount !== undefined && amount !== null && amount !== '' && currency) {
      chosen = { o, price: { amount: cleanAmount(amount), currency } };
      break;
    }
  }
  const withAvailability = (chosen && chosen.o.availability !== undefined ? chosen.o : flat.find((o) => o.availability !== undefined)) || null;
  return {
    price: chosen ? chosen.price : undefined,
    available: withAvailability ? availableOf(withAvailability.availability) : undefined,
    gtin: gtinOf(chosen && chosen.o) || flat.map(gtinOf).find(Boolean),
    sku: text(chosen ? chosen.o.sku : undefined),
  };
}

const CAPACITY_PROPERTY = /capacit|volume|contenance|capacidad|fassungsverm|inhalt|fill/i;
const UNIT_CODES = { MLT: 'ml', CLT: 'cl', LTR: 'l', OZA: 'fl oz', OZI: 'fl oz' };

function capacityOf(...nodes) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    for (const prop of list(node.additionalProperty)) {
      if (!prop || typeof prop !== 'object' || !CAPACITY_PROPERTY.test(text(prop.name) || '')) continue;
      const unit = text(prop.unitText) || UNIT_CODES[String(prop.unitCode || '').toUpperCase()] || '';
      const ml = parseCapacityMl(`${text(prop.value) ?? ''} ${unit}`);
      if (ml) return ml;
    }
    const size = parseCapacityMl(text(node.size) || '');
    if (size) return size;
  }
  return undefined;
}

/**
 * The raw fields of the page's JSON-LD product, before normalisation, or null
 * when the page has none. For a ProductGroup, offers and SKU come from
 * hasVariant[0] (C1.1).
 */
export function readJsonLd(html, { url } = {}) {
  const node = findProduct(jsonLdBlocks(html));
  if (!node) return null;
  const base = baseHref(html, url);
  const isGroup = typesOf(node).includes('productgroup');
  const variant = isGroup ? list(node.hasVariant).find((v) => v && typeof v === 'object') || null : null;
  const offer = pickOffer((variant && variant.offers) || node.offers);
  const material = text(node.material) || (variant ? text(variant.material) : undefined);
  const images = [...imagesOf(node.image, base), ...(variant ? imagesOf(variant.image, base) : [])];
  return {
    name: text(node.name) || (variant ? text(variant.name) : undefined),
    brand: brandName(node.brand) || (variant ? brandName(variant.brand) : undefined),
    sku: (variant ? text(variant.sku) : undefined) || text(node.sku) || offer.sku,
    gtin: gtinOf(variant) || gtinOf(node) || offer.gtin,
    price: offer.price,
    available: offer.available,
    images,
    description: text(node.description) || (variant ? text(variant.description) : undefined),
    capacityMl: capacityOf(variant, node),
    material: material ? detectMaterial(material) : undefined,
    productType: text(node.category),
  };
}

/** C1.1: the page's JSON-LD product, normalised, or { ok: false, code: "no-product" }. */
export function fromJsonLd(html, { url, via = 'worker', now = Date.now(), brand } = {}) {
  const fields = readJsonLd(html, { url });
  if (!fields) return { ok: false, code: 'no-product', message: 'The page has no JSON-LD Product.' };
  return pageListing(fields, { url, canonical: canonicalOf(html, url), platform: 'jsonld', via, now, brand });
}
