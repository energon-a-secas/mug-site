// JSON-LD, OpenGraph and fromHtml on synthetic pages shaped like what shop
// themes print: @graph, arrays, entities, trailing commas, ProductGroup,
// AggregateOffer, several blocks, and pages that are not products at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromHtml } from '../shared/extract/html.js';
import { fromJsonLd, jsonLdBlocks, repairJson } from '../shared/extract/jsonld.js';
import { canonicalOf, cleanAmount, fromOpenGraph } from '../shared/extract/opengraph.js';
import { fixture } from './fixtures/fakes.mjs';

const NOW = 1758470400000;
const opts = (url) => ({ url, via: 'worker', now: NOW });

test('json-ld: @graph, a Brand object, ImageObject, capacity from additionalProperty', () => {
  const r = fromJsonLd(fixture('shop/product/luna-teapot.html'), opts('http://127.0.0.1:8899/product/luna-teapot.html?ref=x'));
  assert.equal(r.ok, true, r.message);
  const l = r.listing;
  assert.equal(l.source.platform, 'jsonld');
  assert.equal(l.source.key, '127.0.0.1/product/luna-teapot.html', 'the canonical host (no port, C1.2) and path, no query');
  assert.equal(l.name, 'Sailor Moon Luna Teapot');
  assert.equal(l.brand, 'ABYstyle');
  assert.equal(l.sku, 'FIX-LUNA-TP');
  assert.equal(l.gtin, '2000000000022');
  assert.deepEqual(l.price, { amount: 39.9, currency: 'EUR' });
  assert.equal(l.available, true);
  assert.equal(l.capacityMl, 1100, '1.1 LTR');
  assert.equal(l.style, 'teapot');
  assert.equal(l.material, 'stoneware');
  assert.equal(l.dishwasherSafe, false, 'hand wash only');
  assert.equal(l.franchise, 'Sailor Moon');
  assert.equal(l.productType, 'Teapots');
  assert.deepEqual(l.images, ['https://shop.example/img/pikachu.png']);
});

test('json-ld: an array, a nested mainEntity, entities, trailing commas, a raw newline, broken and CDATA blocks', () => {
  const html = fixture('jsonld-awkward.html');
  assert.equal(jsonLdBlocks(html).length, 2, 'the broken block is skipped, the other two parse');
  const l = fromJsonLd(html, opts('https://brand.example/en/grogu-mug/?utm_source=newsletter')).listing;
  assert.equal(l.name, 'Grogu & Mando 3D Mug');
  assert.equal(l.brand, 'Brand Example');
  assert.equal(l.source.key, 'brand.example/en/grogu-mug', 'og:url, without query or trailing slash');
  assert.deepEqual(l.price, { amount: 1299, currency: 'JPY' }, 'priceSpecification, thousands separator');
  assert.equal(l.available, true);
  assert.deepEqual(l.images, ['https://cdn.brand.example/grogu.jpg?w=1200&h=1200', 'https://cdn.brand.example/grogu-back.jpg']);
  assert.equal(l.capacityMl, 450, 'from the description');
  assert.equal(l.microwaveSafe, true);
  assert.equal(l.style, 'sculpted');
  assert.equal(l.character, 'Grogu');
});

test('json-ld: HTML-escaped JSON and a relative canonical', () => {
  const l = fromJsonLd(fixture('jsonld-escaped.html'), opts('https://shop.example/products/luna-teapot?variant=3')).listing;
  assert.equal(l.name, 'Luna Teapot');
  assert.deepEqual(l.price, { amount: 34.5, currency: 'USD' });
  assert.equal(l.source.key, 'shop.example/products/luna-teapot');
  assert.equal(l.source.url, 'https://shop.example/products/luna-teapot', 'the canonical page when it is on the fetched host');
});

test('json-ld: ProductGroup reads offers, SKU and codes from hasVariant[0]', () => {
  const l = fromJsonLd(fixture('jsonld-group.html'), opts('https://www.brand.example/stein/dragon-stein')).listing;
  assert.equal(l.name, 'Dragon Relief Stein');
  assert.equal(l.sku, 'DRG-STEIN-RED');
  assert.equal(l.gtin, '2000000000022');
  assert.deepEqual(l.price, { amount: 42, currency: 'USD' }, 'the variant offer, not the group aggregate');
  assert.equal(l.available, false);
  assert.equal(l.capacityMl, 700, '700 MLT');
  assert.equal(l.material, 'stoneware');
  assert.equal(l.style, 'stein');
  assert.deepEqual(l.images, ['https://www.brand.example/img/stein-red.png']);
  assert.equal(l.source.key, 'brand.example/stein/dragon-stein');
});

test('json-ld: AggregateOffer lowPrice, and a barcode on the nested offer', () => {
  const l = fromJsonLd(fixture('jsonld-aggregate.html'), opts('https://brand.example/totoro-tiki')).listing;
  assert.deepEqual(l.price, { amount: 12.5, currency: 'EUR' });
  assert.equal(l.gtin, '2000000000039', 'offers.gtin13');
  assert.equal(l.available, false, 'SoldOut');
  assert.equal(l.style, 'tiki');
  assert.equal(l.franchise, 'Studio Ghibli');
});

test('json-ld: a listing page (ItemList) is not a product page', () => {
  const r = fromJsonLd(fixture('itemlist.html'), opts('https://shop.example/collections/mugs'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-product');
  assert.equal(fromJsonLd('<html></html>', opts('https://shop.example/x')).code, 'no-product');
});

test('json-ld: A6 source brand', () => {
  const l = fromJsonLd(fixture('shop/product/luna-teapot.html'), { ...opts('http://127.0.0.1:8899/product/luna-teapot.html'), brand: 'Fixture Maker' }).listing;
  assert.equal(l.brand, 'Fixture Maker');
  assert.match(l.vendor, /abystyle/i, 'A8: the page brand is kept as the vendor, not a tag');
  assert.ok(!l.tags.includes('abystyle'));
});

test('json repair only touches what is outside and inside strings as it should', () => {
  assert.deepEqual(JSON.parse(repairJson('{"a": [1, 2, ], "b": "x, ]", }')), { a: [1, 2], b: 'x, ]' });
  assert.deepEqual(JSON.parse(repairJson(`{"a": "line one${String.fromCharCode(10)}line two"}`)), { a: 'line one\nline two' });
  assert.deepEqual(JSON.parse(repairJson('{"a": "quote \\" and comma ,}"}')), { a: 'quote " and comma ,}' });
});

test('opengraph: a product page with no JSON-LD', () => {
  const r = fromOpenGraph(fixture('opengraph-product.html'), opts('https://brand.example/grogu-sculpted-mug?ref=home'));
  assert.equal(r.ok, true, r.message);
  const l = r.listing;
  assert.equal(l.source.platform, 'opengraph');
  assert.equal(l.name, 'Grogu Sculpted Mug', 'the site name is stripped');
  assert.deepEqual(l.price, { amount: 24.9, currency: 'EUR' });
  assert.deepEqual(l.images, ['https://cdn.brand.example/grogu-front.jpg', 'https://cdn.brand.example/grogu-side.jpg']);
  assert.equal(l.available, true);
  assert.equal(l.brand, 'Brand Example');
  assert.equal(l.source.key, 'brand.example/grogu-sculpted-mug', 'link rel=canonical beats og:url');
  assert.equal(l.style, 'sculpted');
  assert.equal(l.material, 'ceramic');
});

test('opengraph: an article is no product, but a price makes one', () => {
  assert.equal(fromOpenGraph(fixture('opengraph-article.html'), opts('https://brand.example/blog/ten-mugs')).code, 'no-product');
  const priced = '<meta property="og:type" content="website"><meta property="og:title" content="Kirby Mug"><meta property="product:price:amount" content="15"><meta property="product:price:currency" content="GBP">';
  const l = fromOpenGraph(priced, opts('https://shop.example/kirby')).listing;
  assert.deepEqual(l.price, { amount: 15, currency: 'GBP' });
  assert.equal(fromOpenGraph('<p>nothing</p>', opts('https://shop.example/x')).code, 'no-product');
});

test('fromHtml: JSON-LD first, OpenGraph filling what it left out, OpenGraph alone, or no product', () => {
  const filled = fromHtml(fixture('jsonld-with-og-price.html'), opts('https://shop.example/products/pikachu-3d-mug')).listing;
  assert.equal(filled.source.platform, 'jsonld');
  assert.deepEqual(filled.price, { amount: 18.95, currency: 'USD' }, 'from og:price:*');
  assert.deepEqual(filled.images, ['https://shop.example/cdn/pikachu.jpg']);
  assert.equal(filled.brand, 'ABYstyle');

  const ogOnly = fromHtml(fixture('opengraph-product.html'), opts('https://brand.example/grogu-sculpted-mug'));
  assert.equal(ogOnly.listing.source.platform, 'opengraph');

  const none = fromHtml(fixture('opengraph-article.html'), opts('https://brand.example/blog'));
  assert.deepEqual([none.ok, none.code], [false, 'no-product']);
  assert.equal(fromHtml(fixture('itemlist.html'), opts('https://shop.example/collections/mugs')).code, 'no-product');
});

test('helpers: canonical resolution and shop-written amounts', () => {
  assert.equal(canonicalOf('<base href="https://cdn.example/en/"><link rel="canonical" href="mug">', 'https://shop.example/x'), 'https://cdn.example/en/mug');
  assert.equal(canonicalOf('<link rel="alternate canonical" href="/y#top">', 'https://shop.example/x'), 'https://shop.example/y');
  assert.equal(canonicalOf('<p>none</p>', 'https://shop.example/x'), 'https://shop.example/x');
  assert.equal(cleanAmount('1,299.00'), '1299.00');
  assert.equal(cleanAmount('1.299,00'), '1299.00');
  assert.equal(cleanAmount('24,90'), '24,90');
  assert.equal(cleanAmount('EUR 18.95'), '18.95');
  assert.equal(cleanAmount(12), 12);
});
