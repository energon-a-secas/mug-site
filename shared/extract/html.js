// ── fromHtml: one product from one shop page ─────────────────────────────────
//
// C1.1: JSON-LD first, OpenGraph second. When the page has a JSON-LD product,
// OpenGraph only fills what JSON-LD left out (a page that prints its price in
// meta tags but not in its schema still gets a price); the listing's platform
// says which one found the product. This is what /v1/extract and the runner
// run on every HTML page, so both read a page the same way.

import { readJsonLd } from './jsonld.js';
import { canonicalOf, pageListing, readOpenGraph } from './opengraph.js';

// Fields OpenGraph may fill when JSON-LD is silent on them.
const FILLABLE = ['images', 'price', 'brand', 'description', 'available', 'sku', 'gtin', 'productType', 'capacityMl', 'material'];

function missing(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** C1.1: a normalised listing from a product page, or { ok: false, code: "no-product" }. */
export function fromHtml(html, { url, via = 'worker', now = Date.now(), brand } = {}) {
  const jsonld = readJsonLd(html, { url });
  const og = readOpenGraph(html, { url });
  const canonical = canonicalOf(html, url);
  if (jsonld) {
    const fields = { ...jsonld };
    if (og) for (const key of FILLABLE) if (missing(fields[key]) && !missing(og.fields[key])) fields[key] = og.fields[key];
    if (missing(fields.name) && og) fields.name = og.fields.name;
    return pageListing(fields, { url, canonical, platform: 'jsonld', via, now, brand });
  }
  if (og && og.isProduct) return pageListing(og.fields, { url, canonical, platform: 'opengraph', via, now, brand });
  return { ok: false, code: 'no-product', message: 'The page has neither a JSON-LD Product nor OpenGraph product tags.' };
}
