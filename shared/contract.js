// ── The listing contract, as constants ───────────────────────────────────────
//
// docs/CONTRACTS.md C1 is the prose; this is what code imports. The Worker, the
// local runner, Convex and the admin page all read these values, so a style
// added here reaches every one of them in the same commit. Plain ES module, no
// dependencies: it has to load in a Worker, in Node and in a browser unchanged.

export const LISTING_VERSION = 1;

export const STYLES = Object.freeze([
  'sculpted', 'shaped', 'relief', 'printed', 'tiki', 'teapot', 'stein', 'travel', 'other',
]);

export const STYLE_LABELS = Object.freeze({
  sculpted: '3D sculpted',
  shaped: 'Shaped',
  relief: 'Relief',
  printed: 'Printed',
  tiki: 'Tiki',
  teapot: 'Teapot',
  stein: 'Stein',
  travel: 'Travel',
  other: 'Other',
});

export const MATERIALS = Object.freeze([
  'ceramic', 'stoneware', 'porcelain', 'earthenware', 'glass', 'plastic', 'steel', 'other',
]);

export const PLATFORMS = Object.freeze(['shopify', 'woocommerce', 'jsonld', 'opengraph', 'paste', 'manual']);

export const VIAS = Object.freeze(['worker', 'runner', 'browser']);

export const VERDICTS = Object.freeze(['yes', 'maybe', 'no']);

// Every field C1 allows, and nothing else. tests/listing-mirror.test.mjs holds
// convex/lib/listing.ts to this list, so the stored validator and the
// normaliser cannot drift apart.
export const LISTING_FIELDS = Object.freeze([
  'v', 'source', 'name', 'brand', 'franchise', 'character', 'style', 'capacityMl', 'material',
  'hasLid', 'dishwasherSafe', 'microwaveSafe', 'sku', 'gtin', 'price', 'available', 'images',
  'description', 'tags', 'isMug', 'productType', 'vendor',
]);

export const SOURCE_FIELDS = Object.freeze(['host', 'url', 'key', 'platform', 'via', 'fetchedAt']);

export const LIMITS = Object.freeze({
  name: 200,
  brand: 80,
  franchise: 80,
  character: 80,
  sku: 64,
  key: 300,
  url: 2048,
  description: 2000,
  images: 12,
  tags: 30,
  tag: 40,
  productType: 80,
  vendor: 80,
  reason: 120,
  capacityMinMl: 30,
  capacityMaxMl: 5000,
  priceMax: 100000,
});

// C10.1: the Worker and the runner identify themselves the same way, always.
export const USER_AGENT = 'MugBot/1.0 (+https://mug.neorgon.com/bot/)';
export const ROBOTS_TOKEN = 'mugbot';
