// Where the product URLs are: product links and rel="next" on a listing page,
// and the two kinds of sitemap, with the include and exclude words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listingLinks, looksLikeProduct, nextPageUrl, productLinks, sitemapKind, sitemapUrls, wordFilter } from '../shared/extract/listing-page.js';
import { fixture } from './fixtures/fakes.mjs';

const LISTING = fixture('shop/collections/mugs.html');
const PAGE_URL = 'http://127.0.0.1:8899/collections/mugs';

test('product links: same host, product-looking paths, one URL per product, page order', () => {
  assert.deepEqual(productLinks(LISTING, { url: PAGE_URL }), [
    'http://127.0.0.1:8899/products/pikachu-3d-mug',
    'http://127.0.0.1:8899/products/ewok-bas-relief-mug',
    'http://127.0.0.1:8899/product/luna-teapot.html',
    'http://127.0.0.1:8899/products/joker-coaster-set',
  ], 'collection-scoped and ?variant forms collapse, #reviews is the same page, other hosts and nav links are dropped');
});

test('product links: exclude words drop and are counted; include words widen', () => {
  const r = listingLinks(LISTING, { url: PAGE_URL, exclude: ['coaster'] });
  assert.equal(r.urls.includes('http://127.0.0.1:8899/products/joker-coaster-set'), false);
  assert.equal(r.skipped, 1);
  const html = '<a href="/mugs/pikachu-3d-mug.html">a</a><a href="/about-us">b</a><a href="/blog/best-mugs">c</a>';
  assert.deepEqual(productLinks(html, { url: 'https://shop.example/mugs/', include: ['mug'] }), ['https://shop.example/mugs/pikachu-3d-mug.html'], 'an include word makes a path a product; a blog post stays out');
  assert.deepEqual(productLinks(html, { url: 'https://shop.example/mugs/' }), []);
  const www = '<a href="https://www.shop.example/products/a">a</a><base href="https://shop.example/"><a href="products/b">b</a>';
  assert.deepEqual(productLinks(www, { url: 'https://shop.example/' }), ['https://www.shop.example/products/a', 'https://shop.example/products/b'], 'www counts as the same host; <base href> is honoured');
});

test('rel="next", from a <link> or an <a>, same host only', () => {
  assert.equal(nextPageUrl(LISTING, { url: PAGE_URL }), 'http://127.0.0.1:8899/collections/mugs?page=2');
  assert.equal(nextPageUrl('<a rel="nofollow next" href="?page=3">Next</a>', { url: 'https://shop.example/c?page=2' }), 'https://shop.example/c?page=3');
  assert.equal(nextPageUrl('<link rel="next" href="https://elsewhere.example/c?page=2">', { url: 'https://shop.example/c' }), null);
  assert.equal(nextPageUrl('<a rel="next" href="#">x</a>', { url: 'https://shop.example/c' }), null, 'a link to itself is no next page');
  assert.equal(nextPageUrl('<p>last page</p>', { url: 'https://shop.example/c' }), null);
});

test('path heuristics', () => {
  assert.equal(looksLikeProduct('/products/x'), true);
  assert.equal(looksLikeProduct('/collections/mugs/products/x'), true);
  assert.equal(looksLikeProduct('/product/x/'), true);
  assert.equal(looksLikeProduct('/p/123'), true);
  assert.equal(looksLikeProduct('/shop/grogu-mug/'), true);
  assert.equal(looksLikeProduct('/shop/'), false);
  assert.equal(looksLikeProduct('/shop/page/2/'), false);
  assert.equal(looksLikeProduct('/collections/mugs'), false);
  assert.equal(looksLikeProduct('/cart'), false);
  assert.equal(looksLikeProduct('/pages/about'), false);
});

test('a urlset: product pages only, <image:loc> ignored, CDATA read, the home page never offered', () => {
  const r = sitemapUrls(fixture('shop/sitemap.xml'), { url: 'http://127.0.0.1:8899/sitemap.xml' });
  assert.equal(r.kind, 'urlset');
  assert.equal(r.total, 5);
  assert.deepEqual(r.urls, ['http://127.0.0.1:8899/product/luna-teapot.html', 'http://127.0.0.1:8899/products/pikachu-3d-mug']);
  assert.equal(r.skipped, 3);
});

test('a urlset: paging over raw entries, include narrowing, exclude dropping, a product sitemap vouching', () => {
  const locs = Array.from({ length: 450 }, (_, i) => `<url><loc>https://shop.example/products/item-${i}${i % 3 === 0 ? '-mug' : ''}</loc></url>`).join('');
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`;
  const page2 = sitemapUrls(xml, { url: 'https://shop.example/sitemap.xml', offset: 200, limit: 200 });
  assert.equal(page2.total, 450);
  assert.equal(page2.urls.length, 200);
  assert.equal(page2.urls[0], 'https://shop.example/products/item-200');
  const mugs = sitemapUrls(xml, { url: 'https://shop.example/sitemap.xml', include: ['mug'], offset: 0, limit: 200 });
  assert.equal(mugs.urls.length, 67);
  assert.equal(mugs.skipped, 133);
  const flat = '<urlset><url><loc>https://shop.example/pikachu-3d-mug.html</loc></url><url><loc>https://shop.example/about</loc></url><url><loc>https://other.example/products/x</loc></url></urlset>';
  assert.deepEqual(sitemapUrls(flat, { url: 'https://shop.example/sitemap.xml' }).urls, [], 'nothing looks like a product');
  assert.deepEqual(sitemapUrls(flat, { url: 'https://shop.example/product-sitemap.xml' }).urls, ['https://shop.example/pikachu-3d-mug.html', 'https://shop.example/about'], 'a product sitemap vouches for its entries, but never for another host');
  assert.deepEqual(sitemapUrls(flat, { url: 'https://shop.example/product-sitemap.xml', exclude: ['about'] }).urls, ['https://shop.example/pikachu-3d-mug.html']);
  const escaped = '<urlset><url><loc>https://shop.example/products/a?x=1&amp;y=2</loc></url><url><sm:loc>https://shop.example/products/b</sm:loc></url></urlset>';
  assert.deepEqual(sitemapUrls(escaped, { url: 'https://shop.example/s.xml' }).urls, ['https://shop.example/products/a', 'https://shop.example/products/b']);
});

test('a sitemap index: product sitemaps first, other hosts dropped', () => {
  const r = sitemapUrls(fixture('sitemap-index.xml'), { url: 'https://brand.example/sitemap.xml' });
  assert.equal(r.kind, 'index');
  assert.deepEqual(r.urls, ['https://brand.example/sitemap-products-1.xml', 'https://brand.example/sitemap-products-2.xml']);
  assert.equal(r.skipped, 2);
  assert.equal(r.total, 4);
  const plain = '<sitemapindex><sitemap><loc>https://brand.example/a.xml</loc></sitemap><sitemap><loc>https://brand.example/b.xml</loc></sitemap></sitemapindex>';
  assert.deepEqual(sitemapUrls(plain, { url: 'https://brand.example/sitemap.xml' }).urls, ['https://brand.example/a.xml', 'https://brand.example/b.xml'], 'with no product sitemap named, every child is kept');
  assert.equal(sitemapKind('<html></html>'), null);
  assert.deepEqual(sitemapUrls('<html></html>', { url: 'https://brand.example/' }), { kind: null, urls: [], skipped: 0, total: 0 });
});

test('the word filter', () => {
  const f = wordFilter({ include: ['Mug', 'tasse', ' '], exclude: ['coaster'] });
  assert.equal(f('Pikachu 3D Mug'), 'keep');
  assert.equal(f('Tasse Pikachu'), 'keep');
  assert.equal(f('Pikachu Plush'), 'not-included');
  assert.equal(f('Mug and Coaster Set'), 'excluded');
  assert.equal(wordFilter({})('anything'), 'keep');
  assert.equal(wordFilter({ include: ['theiere'] })(`Th${String.fromCharCode(0xe9)}i${String.fromCharCode(0xe8)}re Luna`), 'keep', 'accents fold');
});
