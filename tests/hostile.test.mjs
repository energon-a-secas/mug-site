// Pages built to hurt the extractors, from the 2026-09-21 security review:
// inputs that made them quadratic or made them throw, a canonical URL that
// claimed another shop's listing key, control characters meant for the
// runner's terminal, and links or images pointing somewhere they should not.
// Every input is synthetic; nothing here fetches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromHtml } from '../shared/extract/html.js';
import { listingLinks, sitemapUrls } from '../shared/extract/listing-page.js';
import { normalizeListing, plainText } from '../shared/extract/normalize.js';
import { decodeAttr, findTags } from '../shared/extract/opengraph.js';
import { fromShopifyProduct } from '../shared/extract/shopify.js';
import { fromWooProduct } from '../shared/extract/woocommerce.js';
import { checkUrl } from '../shared/net/guard.js';
import { printable } from '../runner/mug-runner.mjs';
import { fixture } from './fixtures/fakes.mjs';

const NOW = 1758470400000;
const PAGE = { url: 'https://shop.example/products/mug', via: 'worker', now: NOW };
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL = /\p{Cc}/u;

// Before the fix each of these took about 3 s at 100 KB and 4x that per
// doubling. Linear code reads 200 KB in milliseconds; the budget only has to
// tell the two apart on a slow machine.
const SIZE = 200_000;
const BUDGET_MS = 2000;

function timed(label, run) {
  const start = performance.now();
  const out = run();
  const ms = performance.now() - start;
  assert.ok(ms < BUDGET_MS, `${label} took ${Math.round(ms)} ms`);
  return out;
}

const repeat = (unit) => unit.repeat(Math.ceil(SIZE / unit.length));

test('linear time: unclosed tags, quotes and scripts repeated through a page', () => {
  for (const unit of ['<meta ', '<meta content="', "<meta content='", '<script ', '<script>', '<link rel="canonical" ', '<a href="/products/x" ']) {
    const r = timed(`fromHtml on ${JSON.stringify(unit)}`, () => fromHtml(repeat(unit), PAGE));
    assert.equal(typeof r.ok, 'boolean');
  }
  timed('findTags on "<a "', () => findTags(repeat('<a '), 'a'));
  timed('listingLinks on "<a "', () => listingLinks(repeat('<a '), { url: PAGE.url }));
  timed('plainText on "<"', () => plainText(repeat('<')));
  timed('plainText on "<script"', () => plainText(repeat('<script')));
  timed('plainText on carriage returns', () => plainText(`${repeat('\r')}x`));
  timed('decodeAttr on "&aaaa"', () => decodeAttr(repeat('&aaaa')));
});

test('linear time: sitemaps of unclosed <url> and <loc>, and a Shopify body of "<"', () => {
  timed('sitemapUrls on "<url>"', () => sitemapUrls(`<urlset>${repeat('<url>')}`, { url: 'https://shop.example/sitemap.xml' }));
  timed('sitemapUrls on "<loc>"', () => sitemapUrls(`<urlset><url>${repeat('<loc>')}</url></urlset>`, { url: 'https://shop.example/sitemap.xml' }));
  timed('sitemapUrls on "<sitemap>"', () => sitemapUrls(`<sitemapindex>${repeat('<sitemap>')}`, { url: 'https://shop.example/sitemap.xml' }));
  const product = { ...JSON.parse(fixture('shop/products.json')).products[0], body_html: repeat('<') };
  const r = timed('fromShopifyProduct on a body of "<"', () => fromShopifyProduct(product, { baseUrl: 'https://shop.example', via: 'worker', now: NOW }));
  assert.equal(r.ok, true, 'the product is still read; only its description is empty');
});

test('the linear sitemap reader still reads what a real sitemap says', () => {
  const xml = '<?xml version="1.0"?><urlset xmlns:image="x"><url><image:image><image:loc>https://shop.example/i.png</image:loc></image:image><loc>https://shop.example/products/a-mug</loc></url><url><sm:loc><![CDATA[https://shop.example/products/b-mug]]></sm:loc></url></urlset>';
  assert.deepEqual(sitemapUrls(xml, { url: 'https://shop.example/sitemap.xml' }).urls, ['https://shop.example/products/a-mug', 'https://shop.example/products/b-mug']);
});

function jsonLdPage(json) {
  return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`;
}

test('no throw: deep nesting, huge arrays, huge offers, a 40 KB site name', () => {
  const deep = jsonLdPage(`{"@type":"Product","name":${'['.repeat(5075)}"Deep Mug"${']'.repeat(5075)},"offers":{"price":"9","priceCurrency":"USD"}}`);
  const wide = jsonLdPage(`[${'{},'.repeat(299_999)}{"@type":"Product","name":"Wide Mug"}]`);
  const offers = jsonLdPage(`{"@type":"Product","name":"Offer Mug","offers":[{"offers":[${'{"price":"1"},'.repeat(299_999)}{"price":"1"}]}]}`);
  const site = 'S'.repeat(40_000);
  const og = `<meta property="og:type" content="product"><meta property="og:site_name" content="${site}"><meta property="og:title" content="Title Mug | ${site}"><meta property="product:price:amount" content="5"><meta property="product:price:currency" content="USD">`;
  for (const [label, html] of [['deep', deep], ['wide', wide], ['offers', offers], ['site name', og]]) {
    const r = timed(label, () => fromHtml(html, PAGE));
    assert.equal(typeof r.ok, 'boolean', label);
  }
  assert.equal(fromHtml(og, PAGE).listing.name, 'Title Mug', 'the site name is still stripped');
});

test('A14: a canonical on another host sets neither the link nor the key', () => {
  const body = '<script type="application/ld+json">{"@type":"Product","name":"Pikachu 3D Mug"}</script>';
  const spoof = fromHtml(`<link rel="canonical" href="https://abystyle.com/products/pikachu-3d-mug">${body}`, { ...PAGE, url: 'https://other-shop.example/products/pika' });
  assert.equal(spoof.listing.source.key, 'other-shop.example/products/pika');
  assert.equal(spoof.listing.source.url, 'https://other-shop.example/products/pika');
  const own = fromHtml(`<link rel="canonical" href="https://www.shop.example/products/pika">${body}`, { ...PAGE, url: 'https://shop.example/products/pika?variant=2' });
  assert.equal(own.listing.source.key, 'shop.example/products/pika', 'the same host, with or without www, still names the listing');
});

test('control characters never survive into a listing, and the runner prints none', () => {
  const osc52 = `${ESC}]52;c;aGVsbG8=${BEL}`;
  const r = normalizeListing({
    source: { platform: 'manual', via: 'browser' },
    name: `Evil${osc52} Mug`,
    brand: `Brand${ESC}[2J`,
    description: `Line one &#155;2J${ESC}\nLine two`,
    tags: [`tag${BEL}`],
  }, { now: NOW });
  assert.equal(r.ok, true);
  for (const value of [r.listing.name, r.listing.brand, r.listing.description, ...r.listing.tags]) {
    assert.equal(CONTROL.test(value.replace(/\n/g, '')), false, JSON.stringify(value));
  }
  assert.match(r.listing.description, /Line one .*\nLine two/, 'newlines in a description are kept');
  assert.equal(printable(`a${ESC}b\nc\td${BEL}`), 'a?b\nc\td?');
});

test('A14: a WooCommerce permalink on another host is not the shop link', () => {
  const opts = { baseUrl: 'https://shop.example', via: 'worker', now: NOW };
  assert.equal(fromWooProduct({ id: 7, name: 'Tiki Mug', permalink: 'https://phish.example/login' }, opts).listing.source.url, 'https://shop.example/?p=7');
  assert.equal(fromWooProduct({ id: 7, name: 'Tiki Mug', permalink: 'https://www.shop.example/product/tiki-mug/' }, opts).listing.source.url, 'https://www.shop.example/product/tiki-mug/');
});

test('images the SSRF guard would refuse are dropped from a listing', () => {
  const r = normalizeListing({
    source: { platform: 'manual', via: 'browser' },
    name: 'Mug',
    images: ['https://192.168.1.1/a.png', 'http://10.0.0.1/b.png', 'https://localhost/c.png', 'https://shop.example:8443/d.png', 'https://shop.example/e.png'],
  }, { now: NOW });
  assert.deepEqual(r.listing.images, ['https://shop.example/e.png']);
});

test('inherited names are not entities, and an empty host label is refused', () => {
  const r = normalizeListing({ source: { platform: 'manual', via: 'browser' }, name: 'Mug &constructor; &toString;' }, { now: NOW });
  assert.equal(r.listing.name, 'Mug &constructor; &toString;');
  assert.equal(decodeAttr('&constructor;'), '&constructor;');
  assert.equal(checkUrl('http://localhost../').ok, false);
  assert.equal(checkUrl('https://shop..example/').ok, false);
  assert.equal(checkUrl('https://shop.example./products/mug').ok, true, 'one trailing dot is the DNS root');
});
