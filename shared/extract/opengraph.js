// ── OpenGraph, and the tag readers the HTML extractors share ─────────────────
//
// fromOpenGraph reads a product from <meta property="og:..."> and
// "product:..." tags: the fallback when a page has no JSON-LD (C1.1). The
// helpers above it (attributes, meta tags, the canonical URL, prices written
// the way shops write them, and A6's source brand) live here because this is
// the one extractor every other one may import without a cycle.
//
// These are regex readers, not a DOM: they only need to find attributes on
// <meta>, <link> and <a> tags, and they run in a Worker with no DOM at all.

import { detectFranchise, detectMaterial, parseCapacityMl } from './facts.js';
import { collapse, fold } from './names.js';
import { hostOf, listingKey, normalizeListing } from './normalize.js';

const EM_DASH_CODE = 0x2014;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Entities in an attribute value (&amp;, &quot;, &#39;, &#x27;). Unknown names are kept. */
export function decodeAttr(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
      return code === EM_DASH_CODE ? ',' : String.fromCodePoint(code);
    }
    const key = body.toLowerCase();
    return Object.hasOwn(NAMED, key) ? NAMED[key] : whole;
  });
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** { name: value } for the inside of one tag; names lowercased, values entity-decoded. */
export function tagAttributes(inside) {
  const out = {};
  for (const m of String(inside ?? '').matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeAttr(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * The attributes of every <tag ...> in the document, in order. Neither the
 * tag nor a quoted value may run past a "<": without that, each unclosed
 * "<meta " rescanned the rest of the page and a hostile page cost quadratic
 * time. A value with a raw "<" in it loses that one tag, which shops escape
 * anyway.
 */
export function findTags(html, tag) {
  const re = new RegExp(`<${tag}\\b((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>`, 'gi');
  const out = [];
  for (const m of String(html ?? '').matchAll(re)) out.push(tagAttributes(m[1].replace(/\/\s*$/, '')));
  return out;
}

/** [{ key, content }] for every <meta> with a property or name, keys lowercased. */
export function metaTags(html) {
  const out = [];
  for (const attrs of findTags(html, 'meta')) {
    const key = (attrs.property || attrs.name || attrs.itemprop || '').trim().toLowerCase();
    if (key && typeof attrs.content === 'string') out.push({ key, content: attrs.content.trim() });
  }
  return out;
}

/** An absolute http(s) URL resolved against `base`, fragment dropped, scheme kept; or null. */
export function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    const url = base ? new URL(String(href).trim(), base) : new URL(String(href).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** The document's base URL: <base href> when present, else the page URL. */
export function baseHref(html, url) {
  const base = findTags(html, 'base').find((a) => a.href);
  return (base && absoluteUrl(base.href, url)) || url;
}

/** C1.2's canonical page: link rel=canonical, else og:url, else the fetched URL. */
export function canonicalOf(html, url) {
  const base = baseHref(html, url);
  for (const link of findTags(html, 'link')) {
    const rel = String(link.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical')) {
      const abs = absoluteUrl(link.href, base);
      if (abs) return abs;
    }
  }
  const og = metaTags(html).find((m) => m.key === 'og:url');
  return (og && absoluteUrl(og.content, base)) || url;
}

/**
 * A price amount as a plain decimal string. Shops write "1,299.00",
 * "1.299,00", "24,90" and "18.95"; normalizeListing only knows the last two.
 */
export function cleanAmount(value) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').replace(/[^\d.,]/g, '');
  if (!s) return undefined;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return s.replace(/\./g, '').replace(',', '.');
  return s;
}

/** A6: a source brand option is a string of 1 to 80 characters after trimming, or nothing. */
export function sourceBrand(value) {
  if (typeof value !== 'string') return undefined;
  const text = collapse(value);
  return text.length >= 1 && text.length <= 80 ? text : undefined;
}

/**
 * A6 and A8. With no source brand, the shop's own value (vendor, JSON-LD
 * brand) is the brand. With one, the source brand wins; the shop's value,
 * when it differs, is kept as the listing's `vendor` and offered as the
 * franchise if detectFranchise knows it (Bioworld's shop lists its Ewok mug
 * under vendor "Star Wars"). It is not a tag: tags feed fact detection, and a
 * vendor called "Fixture Ceramics" once made a mug ceramic (A8).
 */
export function brandFields(shopValue, sourceBrandOption) {
  const shop = typeof shopValue === 'string' ? collapse(shopValue) : '';
  const own = sourceBrand(sourceBrandOption);
  if (!own) return { brand: shop || undefined, tags: [], franchise: undefined, vendor: undefined };
  const out = { brand: own, tags: [], franchise: undefined, vendor: undefined };
  if (shop && fold(shop) !== fold(own)) {
    out.vendor = shop;
    if (detectFranchise(shop)) out.franchise = shop;
  }
  return out;
}

function tagList(tags) {
  if (typeof tags === 'string') return tags.split(',');
  return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
}

/**
 * The input normalizeListing takes, for a product read from an HTML page.
 * `fields` holds what the page said; the key is the canonical page's
 * <host><path> (C1.2) and source.url is that canonical page when it is on the
 * fetched host, else the fetched URL.
 */
export function pageListing(fields, { url, canonical, platform, via = 'worker', now = Date.now(), brand } = {}) {
  const page = canonical || url;
  // A14: a canonical on another host sets neither the link nor the key. The
  // key is how a listing finds its mug, so a page naming another shop's
  // product page as its canonical would otherwise update that shop's mug.
  const sourceUrl = page && hostOf(page) && hostOf(page) === hostOf(url) ? page : url;
  const b = brandFields(fields.brand, brand);
  const input = {
    source: { url: sourceUrl, key: listingKey({ url: sourceUrl, platform }), platform, via, fetchedAt: now },
    name: fields.name,
    brand: b.brand,
    franchise: b.franchise,
    vendor: b.vendor,
    sku: fields.sku,
    gtin: fields.gtin,
    price: fields.price,
    available: fields.available,
    images: fields.images,
    description: fields.description,
    capacityMl: fields.capacityMl,
    material: fields.material,
    productType: fields.productType,
    tags: [...tagList(fields.tags), ...b.tags],
  };
  return normalizeListing(input, { now });
}

/** A string made safe to embed in a RegExp. */
export function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TITLE_SEPARATORS = new Set(['|', '-', String.fromCharCode(0x2013), ':', ',']);

// "Luna 3D Mug | ABYstyle" is "Luna 3D Mug". Compared as strings, not built
// into a RegExp: a hostile og:site_name of 32 KB made "Regular expression too
// large" and threw out of the extractor. collapse() has already folded every
// whitespace run to one space, so at most one space sits on each side.
function stripSiteName(title, siteName) {
  const t = collapse(title);
  const site = collapse(siteName);
  if (!t || !site || t.length <= site.length + 3) return t;
  if (t.slice(t.length - site.length).toLowerCase() !== site.toLowerCase()) return t;
  const head = t.slice(0, t.length - site.length).trimEnd();
  if (!TITLE_SEPARATORS.has(head.slice(-1))) return t;
  return head.slice(0, -1).trim() || t;
}

function availabilityOf(value) {
  const v = fold(value).replace(/[^a-z]/g, '');
  if (!v) return undefined;
  if (['instock', 'available', 'limitedavailability'].includes(v)) return true;
  if (['oos', 'outofstock', 'soldout', 'discontinued', 'unavailable'].includes(v)) return false;
  return undefined;
}

/**
 * What the page's OpenGraph tags say, or null when it has none. `isProduct`
 * is C1.1's test: og:type is product, or a price is present.
 */
export function readOpenGraph(html, { url } = {}) {
  const metas = metaTags(html);
  if (!metas.some((m) => m.key.startsWith('og:') || m.key.startsWith('product:'))) return null;
  const first = (...keys) => {
    for (const key of keys) {
      const hit = metas.find((m) => m.key === key && m.content);
      if (hit) return hit.content;
    }
    return undefined;
  };
  const all = (...keys) => metas.filter((m) => keys.includes(m.key) && m.content).map((m) => m.content);
  const base = baseHref(html, url);
  const type = String(first('og:type') || '').toLowerCase();
  const amount = first('product:price:amount', 'og:price:amount', 'product:sale_price:amount');
  const currency = first('product:price:currency', 'og:price:currency', 'product:sale_price:currency');
  const capacity = first('product:capacity', 'product:volume');
  const material = first('product:material');
  const fields = {
    name: stripSiteName(first('og:title', 'twitter:title'), first('og:site_name')),
    images: all('og:image', 'og:image:url', 'og:image:secure_url').map((src) => absoluteUrl(src, base)).filter(Boolean),
    description: first('og:description', 'description'),
    price: amount ? { amount: cleanAmount(amount), currency } : undefined,
    available: availabilityOf(first('product:availability', 'og:availability')),
    brand: first('product:brand', 'og:brand'),
    sku: first('product:retailer_item_id', 'product:sku'),
    gtin: first('product:gtin', 'product:ean', 'product:upc', 'product:gtin13'),
    productType: first('product:category'),
    capacityMl: capacity ? parseCapacityMl(capacity) : undefined,
    material: material ? detectMaterial(material) : undefined,
  };
  return { isProduct: type.startsWith('product') || type === 'og:product' || !!amount, fields };
}

/**
 * C1.1: a product from OpenGraph tags, accepted only when og:type is product
 * or a price is present; otherwise { ok: false, code: "no-product" }.
 */
export function fromOpenGraph(html, { url, via = 'worker', now = Date.now(), brand } = {}) {
  const og = readOpenGraph(html, { url });
  if (!og || !og.isProduct) return { ok: false, code: 'no-product', message: 'The page has no OpenGraph product (og:type product or a price).' };
  return pageListing(og.fields, { url, canonical: canonicalOf(html, url), platform: 'opengraph', via, now, brand });
}
