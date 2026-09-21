// ── Listing pages and sitemaps: where the product URLs are ───────────────────
//
// A jsonld source (C2) has no product feed, so discovery reads what a shop
// publishes for crawlers: an HTML listing page (its product links, and its
// rel="next") or a sitemap (a urlset of pages, or an index of sitemaps). This
// file finds the URLs; the Worker and the runner fetch them. XML is read with
// regexes on purpose: there is no entity expansion to abuse.
//
// Two filters, both from the source's include and exclude words:
//   - on a listing page, a link counts when its path looks like a product page
//     (/products/, /product/, /p/, /shop/) or contains an include word;
//   - in a sitemap, every include word narrows (a brand's product sitemap
//     lists its plush too), and a sitemap whose own name says "product" vouches
//     for every URL in it.
// Exclude words always drop. URLs keep their scheme and stay on the page's
// host (www or not): a listing is never a way to send Mug to another site.

import { fold } from './names.js';
import { hostOf } from './normalize.js';
import { absoluteUrl, baseHref, decodeAttr, findTags } from './opengraph.js';

function words(list) {
  return (Array.isArray(list) ? list : [])
    .filter((w) => typeof w === 'string')
    .map((w) => fold(w).trim())
    .filter(Boolean);
}

/**
 * The include/exclude test on any text (a path, or a product's name, type and
 * tags): "excluded", "not-included" or "keep". Lowercase, accent-folded
 * substring matching; an empty include list includes everything.
 */
export function wordFilter({ include = [], exclude = [] } = {}) {
  const inc = words(include);
  const exc = words(exclude);
  return (text) => {
    const t = fold(text);
    if (exc.some((w) => t.includes(w))) return 'excluded';
    if (inc.length && !inc.some((w) => t.includes(w))) return 'not-included';
    return 'keep';
  };
}

function pathText(url) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

const SHOPIFY_PRODUCT = /^((?:\/[a-z]{2}(?:-[a-z]{2,4})?)?)(?:\/collections\/[^/]+)?(\/products\/[^/]+)\/?$/i;
const PRODUCT_PATH = /\/(?:products?|p|shop)\/(?!page\/)[^/?#]+/i;
const NOT_A_PRODUCT = /\/(?:cart|checkout|account|login|register|wishlist|search|compare|blogs?|pages|policies|tags?|category|categories|collections|page\/\d+)(?:\/|$)/i;

/** true when a path looks like a product page, or contains one of `include`. */
export function looksLikeProduct(pathname, include = []) {
  const path = String(pathname || '');
  if (/\/products\/[^/]+/i.test(path)) return true;
  if (NOT_A_PRODUCT.test(path)) return false;
  if (PRODUCT_PATH.test(path)) return true;
  const t = fold(path);
  return words(include).some((w) => t.includes(w));
}

/**
 * One product URL per product: Shopify's /collections/<c>/products/<h> and
 * ?variant= forms become /products/<h>, and a product path loses its query.
 */
function productForm(url) {
  const m = SHOPIFY_PRODUCT.exec(url.pathname);
  if (m) {
    url.pathname = `${m[1]}${m[2]}`;
    url.search = '';
  } else if (PRODUCT_PATH.test(url.pathname)) {
    url.search = '';
  }
  url.hash = '';
  return url.href;
}

/**
 * C1.1: same-host links on an HTML listing page whose paths look like product
 * pages (or contain an include word), minus exclude words; absolute,
 * deduplicated, in page order.
 */
export function productLinks(html, { url, include = [], exclude = [] } = {}) {
  return listingLinks(html, { url, include, exclude }).urls;
}

/** productLinks, plus how many product-looking links the exclude words dropped. */
export function listingLinks(html, { url, include = [], exclude = [] } = {}) {
  const base = baseHref(html, url);
  const host = hostOf(url);
  const drop = wordFilter({ exclude });
  const self = absoluteUrl(url, url);
  const seen = new Set();
  const urls = [];
  let skipped = 0;
  for (const a of findTags(html, 'a')) {
    const abs = absoluteUrl(a.href, base);
    if (!abs) continue;
    const link = new URL(abs);
    if (hostOf(abs) !== host || !looksLikeProduct(link.pathname, include)) continue;
    const out = productForm(link);
    if (out === self || seen.has(out)) continue;
    seen.add(out);
    if (drop(pathText(link)) === 'excluded') {
      skipped++;
      continue;
    }
    urls.push(out);
  }
  return { urls, skipped };
}

/** A1: the listing's next page from rel="next" (a <link> or an <a>), same host, or null. */
export function nextPageUrl(html, { url } = {}) {
  const base = baseHref(html, url);
  const self = absoluteUrl(url, url);
  for (const tag of ['link', 'a']) {
    for (const attrs of findTags(html, tag)) {
      const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
      if (!rel.includes('next')) continue;
      const abs = absoluteUrl(attrs.href, base);
      if (abs && abs !== self && hostOf(abs) === hostOf(url)) return abs;
    }
  }
  return null;
}

function blocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, 'gi'))].map((m) => m[1]);
}

// <loc>, or a prefixed <sm:loc>, but never <image:loc> or <video:loc>.
const LOC = /<(?:(?!image:|video:|news:|xhtml:)[\w-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?loc\s*>/i;

function locOf(block) {
  const m = LOC.exec(block);
  if (!m) return null;
  const raw = m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
  return raw ? decodeAttr(raw) : null;
}

/** "index", "urlset" or null: what kind of sitemap a document is. */
export function sitemapKind(xml) {
  const head = String(xml ?? '').slice(0, 4096);
  if (/<(?:[\w-]+:)?sitemapindex\b/i.test(head)) return 'index';
  if (/<(?:[\w-]+:)?urlset\b/i.test(head)) return 'urlset';
  return null;
}

/**
 * C1.1: the URLs a sitemap lists.
 *   index:  { kind: "index", urls: child sitemaps, skipped, total }. When any
 *           child's name says "product", only those are kept.
 *   urlset: { kind: "urlset", urls: product pages, skipped, total }, with
 *           `offset` and `limit` paging over the raw entries (the Worker pages
 *           200 at a time) and the filters applied within the page.
 *   neither: { kind: null, urls: [], skipped: 0, total: 0 }.
 */
export function sitemapUrls(xml, { url, include = [], exclude = [], offset = 0, limit = Infinity } = {}) {
  const kind = sitemapKind(xml);
  const host = hostOf(url);
  if (kind === 'index') {
    const all = blocks(xml, 'sitemap').map(locOf).map((loc) => absoluteUrl(loc, url)).filter(Boolean);
    const same = all.filter((u) => hostOf(u) === host);
    const products = same.filter((u) => /product/i.test(new URL(u).pathname));
    const urls = [...new Set(products.length ? products : same)];
    return { kind, urls, skipped: all.length - urls.length, total: all.length };
  }
  if (kind === 'urlset') {
    const entries = blocks(xml, 'url').map(locOf);
    const start = Math.max(0, Math.floor(offset) || 0);
    const slice = entries.slice(start, start + limit);
    let vouched = false;
    try {
      vouched = /product/i.test(new URL(url).pathname);
    } catch {
      vouched = false;
    }
    const filter = wordFilter({ include, exclude });
    const seen = new Set();
    const urls = [];
    let skipped = 0;
    for (const loc of slice) {
      const abs = absoluteUrl(loc, url);
      const link = abs ? new URL(abs) : null;
      if (!link || hostOf(abs) !== host || link.pathname === '/' || !(vouched || looksLikeProduct(link.pathname, include)) || filter(pathText(link)) !== 'keep') {
        skipped++;
        continue;
      }
      const out = productForm(link);
      if (seen.has(out)) continue;
      seen.add(out);
      urls.push(out);
    }
    return { kind, urls, skipped, total: entries.length };
  }
  return { kind: null, urls: [], skipped: 0, total: 0 };
}
