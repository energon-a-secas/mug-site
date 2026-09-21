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

const SCRIPT_OPEN = /<script\b((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/gi;
const SCRIPT_CLOSE = /<\/script\s*>/gi;
const PRODUCT_TYPES = new Set(['product', 'productgroup', 'individualproduct', 'productmodel', 'someproducts']);
// Keys that lead to other products (related, similar, reviewed) or to listings.
const SKIP_KEYS = new Set([
  'itemlistelement', 'isrelatedto', 'issimilarto', 'isaccessoryorsparepartfor', 'isconsumablefor',
  'review', 'reviews', 'aggregaterating', 'breadcrumb', 'potentialaction', 'relatedlink', 'significantlink',
]);
const MAX_NODES = 5000;
// A name is a string, an array of them, or {@value}/{name}: a few levels at
// most. Deeper is a hostile page, and recursing 5,000 arrays deep overflowed
// the stack.
const MAX_TEXT_DEPTH = 8;
const MAX_OFFERS = 200;

/**
 * [attributes, body] for each <script> element, found with forward searches
 * only. A lazy [\s\S]*? up to </script> rescanned the rest of the page for
 * every unclosed <script>, which made a hostile page quadratic. With no
 * </script> left, no later script can close either, so the scan stops.
 */
function scriptElements(html) {
  const out = [];
  SCRIPT_OPEN.lastIndex = 0;
  for (let open = SCRIPT_OPEN.exec(html); open; open = SCRIPT_OPEN.exec(html)) {
    SCRIPT_CLOSE.lastIndex = SCRIPT_OPEN.lastIndex;
    const close = SCRIPT_CLOSE.exec(html);
    if (!close) break;
    out.push([open[1], html.slice(SCRIPT_OPEN.lastIndex, close.index)]);
    SCRIPT_OPEN.lastIndex = SCRIPT_CLOSE.lastIndex;
  }
  return out;
}

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
  for (const [attributes, raw] of scriptElements(String(html ?? ''))) {
    if (!/\btype\s*=\s*["']?\s*application\/ld\+json/i.test(attributes)) continue;
    const body = unwrap(raw);
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

/**
 * The first Product or ProductGroup, breadth first, so a page's main entity
 * wins over nested ones. At most MAX_NODES nodes are ever queued, and the
 * queue is read by index: push(...array) threw on an array of 300,000 items,
 * and shift() is a copy of the whole queue on each call.
 */
export function findProduct(values) {
  const queue = [];
  const add = (value) => {
    if (queue.length >= MAX_NODES) return false;
    queue.push(value);
    return true;
  };
  for (const value of values) if (!add(value)) break;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (Array.isArray(node)) {
      for (const item of node) if (!add(item)) break;
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (typesOf(node).some((t) => PRODUCT_TYPES.has(t))) return node;
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      const value = node[key];
      if (value && typeof value === 'object' && !SKIP_KEYS.has(key.toLowerCase()) && !add(value)) break;
    }
  }
  return null;
}

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A plain string from a JSON-LD value: strings, numbers, {@value}, {name}, or the first of an array. */
function text(value, depth = 0) {
  if (typeof value === 'string') return collapse(value) || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (depth >= MAX_TEXT_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = text(v, depth + 1);
      if (t) return t;
    }
    return undefined;
  }
  if (value && typeof value === 'object') return text(value['@value'] ?? value.name, depth + 1);
  return undefined;
}

function brandName(value) {
  for (const b of list(value)) {
    const name = typeof b === 'string' ? collapse(b) : b && typeof b === 'object' ? text(b.name) : undefined;
    if (name) return name;
  }
  return undefined;
}

// normalizeListing keeps 12; collecting a few more leaves room for duplicates
// without parsing every URL in a hostile list of thousands.
const MAX_IMAGES_READ = 48;

function imagesOf(value, base) {
  const out = [];
  for (const item of list(value)) {
    if (out.length >= MAX_IMAGES_READ) break;
    const src = typeof item === 'string' ? item : item && typeof item === 'object' ? (item.url ?? item.contentUrl) : undefined;
    for (const s of list(src)) {
      if (out.length >= MAX_IMAGES_READ) break;
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
  // A loop with a ceiling, not push(...list): a nested offers array of
  // 300,000 items overflowed the call stack as spread arguments.
  const flat = [];
  const add = (o) => {
    if (o && typeof o === 'object' && flat.length < MAX_OFFERS) flat.push(o);
  };
  for (const o of list(offers)) {
    if (flat.length >= MAX_OFFERS) break;
    if (!o || typeof o !== 'object') continue;
    add(o);
    if (!o.offers) continue;
    for (const inner of list(o.offers)) {
      if (flat.length >= MAX_OFFERS) break;
      add(inner);
    }
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
