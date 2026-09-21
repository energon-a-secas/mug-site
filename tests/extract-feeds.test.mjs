// Shopify and WooCommerce product shapes into C1 listings, on synthetic
// fixtures, including A6 (a source's own brand outranks the shop's vendor).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromShopifyProduct, shopifyBase, shopifyHandle, shopifyJsonUrl, shopifyProductsUrl,
} from '../shared/extract/shopify.js';
import { fromWooProduct, wooProductsUrl } from '../shared/extract/woocommerce.js';
import { fixture } from './fixtures/fakes.mjs';

const NOW = 1758470400000;
const feed = JSON.parse(fixture('shop/products.json')).products;
const single = JSON.parse(fixture('shop/products/pikachu-3d-mug.json')).product;
const woo = JSON.parse(fixture('woo-products.json'));
const opts = { baseUrl: 'https://www.shop.example', via: 'worker', now: NOW };

test('shopify: a products.json item becomes a listing keyed <host>/products/<handle>', () => {
  const r = fromShopifyProduct(feed[0], opts);
  assert.equal(r.ok, true, r.message);
  const l = r.listing;
  assert.deepEqual(l.source, {
    host: 'shop.example',
    url: 'https://www.shop.example/products/pikachu-3d-mug',
    key: 'shop.example/products/pikachu-3d-mug',
    platform: 'shopify',
    via: 'worker',
    fetchedAt: NOW,
  });
  assert.equal(l.name, 'Pikachu 3D Mug');
  assert.equal(l.brand, 'ABYstyle');
  assert.equal(l.sku, 'FIX-PIKA-001');
  assert.equal(l.price, undefined, 'products.json names no currency, so no price is invented');
  assert.equal(l.available, true);
  assert.equal(l.gtin, undefined, 'products.json carries no barcode');
  assert.deepEqual(l.images, ['https://shop.example/img/pikachu.png']);
  assert.deepEqual(l.tags, ['pokemon', '3d mug']);
  assert.equal(l.productType, 'Mugs');
  assert.equal(l.style, 'sculpted');
  assert.equal(l.capacityMl, 460, 'from the description');
  assert.equal(l.dishwasherSafe, true);
  assert.equal(l.franchise, 'Pokemon');
  assert.equal(l.character, 'Pikachu');
  assert.equal(l.isMug.verdict, 'yes');
});

test('shopify: a currency makes a price only when known honestly', () => {
  const withCurrency = fromShopifyProduct(feed[0], { ...opts, currency: 'EUR' }).listing;
  assert.deepEqual(withCurrency.price, { amount: 18.95, currency: 'EUR' });
  const fromJson = fromShopifyProduct(single, opts).listing;
  assert.deepEqual(fromJson.price, { amount: 18.95, currency: 'EUR' }, 'price_currency on the variant');
  assert.equal(fromJson.gtin, '2000000000015', 'the barcode, check digit valid');
  assert.deepEqual(fromJson.tags, ['3d mug', 'pokemon'], 'tags as a comma string');
  const presented = fromShopifyProduct({ ...feed[0], variants: [{ price: '20.00', available: true, presentment_prices: [{ price: { amount: '20.00', currency_code: 'CAD' } }] }] }, opts).listing;
  assert.deepEqual(presented.price, { amount: 20, currency: 'CAD' });
});

test('shopify: the first available variant is the one read, and a bad barcode is skipped', () => {
  const product = {
    ...feed[0],
    variants: [
      { sku: 'SOLD-OUT', price: '10.00', available: false, barcode: '123' },
      { sku: 'IN-STOCK', price: '12.00', available: true, barcode: '2000000000039' },
    ],
  };
  const l = fromShopifyProduct(product, { ...opts, currency: 'USD' }).listing;
  assert.equal(l.sku, 'IN-STOCK');
  assert.deepEqual(l.price, { amount: 12, currency: 'USD' });
  assert.equal(l.gtin, '2000000000039');
  assert.equal(l.available, true);
  const allOut = fromShopifyProduct({ ...feed[1] }, opts).listing;
  assert.equal(allOut.available, false);
});

test('shopify: verdicts, relief, and a Spanish shop\'s "tazas"', () => {
  assert.equal(fromShopifyProduct(feed[1], opts).listing.style, 'relief');
  const taza = fromShopifyProduct(feed[2], opts).listing;
  assert.equal(taza.isMug.verdict, 'yes');
  assert.equal(taza.character, 'Kenny McCormick');
  assert.deepEqual(taza.tags, ['south park', 'tazas']);
  assert.equal(fromShopifyProduct(feed[3], opts).listing.isMug.verdict, 'no', 'plush');
  assert.equal(fromShopifyProduct(feed[4], opts).listing.isMug.verdict, 'no', 'coasters');
});

test('A6: a source brand outranks the vendor, which becomes the vendor field and the franchise', () => {
  const product = {
    title: 'Star Wars Ewok 16 oz. Bas Relief Ceramic Mug',
    handle: 'ewok-bas-relief-mug',
    vendor: 'Star Wars',
    product_type: 'Mug',
    tags: ['ewok'],
    variants: [{ sku: 'BW-EWOK', price: '18.95', available: true }],
  };
  const l = fromShopifyProduct(product, { ...opts, brand: 'Bioworld' }).listing;
  assert.equal(l.brand, 'Bioworld');
  assert.match(l.name, /Star Wars/, 'cleanName strips only the real brand');
  assert.equal(l.name, 'Star Wars Ewok 16 oz. Bas Relief Ceramic Mug');
  assert.equal(l.franchise, 'Star Wars');
  assert.equal(l.vendor, 'Star Wars', 'A8: the vendor is kept as its own field');
  assert.ok(!l.tags.includes('star wars'), 'A8: and not as a tag, which would feed fact detection');
  assert.equal(l.capacityMl, 473);

  const without = fromShopifyProduct(product, opts).listing;
  assert.equal(without.brand, 'Star Wars', 'no source brand: the vendor is the brand, as before');

  const same = fromShopifyProduct({ ...feed[0], vendor: 'abystyle' }, { ...opts, brand: 'ABYstyle' }).listing;
  assert.equal(same.brand, 'ABYstyle');
  assert.deepEqual(same.tags, ['pokemon', '3d mug'], 'a vendor equal to the brand adds no tag');

  const distributor = fromShopifyProduct({ ...feed[0], vendor: 'Fixture Distribution Ltd' }, { ...opts, brand: 'ABYstyle' }).listing;
  assert.equal(distributor.vendor, 'Fixture Distribution Ltd', 'A8: kept as the vendor');
  assert.ok(!distributor.tags.includes('fixture distribution ltd'), 'A8: not as a tag');
  assert.equal(distributor.franchise, 'Pokemon', 'a vendor that names no franchise is not offered as one');

  const junk = fromShopifyProduct(feed[0], { ...opts, brand: '   ' }).listing;
  assert.equal(junk.brand, 'ABYstyle', 'a blank brand option is ignored');
  assert.equal(fromShopifyProduct(feed[0], { ...opts, brand: 'x'.repeat(81) }).listing.brand, 'ABYstyle', 'over 80 characters is ignored');
});

test('shopify: refusals', () => {
  assert.equal(fromShopifyProduct(null, opts).code, 'bad-source');
  assert.equal(fromShopifyProduct({ title: 'No handle mug' }, opts).code, 'bad-source');
  assert.equal(fromShopifyProduct({ handle: 'x', title: '' }, opts).code, 'no-name');
  assert.equal(fromShopifyProduct({ handle: 'x', title: 'Mug' }, { ...opts, baseUrl: '' }).code, 'bad-url');
});

test('shopify: URLs', () => {
  assert.equal(shopifyBase('https://shop.example/collections/mugs'), 'https://shop.example');
  assert.equal(shopifyBase('https://shop.example/fr/collections/mugs?sort_by=x'), 'https://shop.example/fr');
  assert.equal(shopifyBase('https://shop.example/products.json'), 'https://shop.example');
  assert.equal(shopifyBase('https://shop.example/'), 'https://shop.example');
  assert.equal(shopifyProductsUrl('https://shop.example/', 1), 'https://shop.example/products.json?limit=50&page=1');
  assert.equal(shopifyProductsUrl('https://shop.example/collections/tazas/', 3), 'https://shop.example/collections/tazas/products.json?limit=50&page=3');
  assert.equal(shopifyProductsUrl('https://shop.example/collections/mugs/products.json?limit=10', 2), 'https://shop.example/collections/mugs/products.json?limit=50&page=2');
  assert.equal(shopifyHandle('/products/pikachu-3d-mug'), 'pikachu-3d-mug');
  assert.equal(shopifyHandle('/fr/collections/mugs/products/pikachu'), 'pikachu');
  assert.equal(shopifyHandle('/products/pikachu.json'), null);
  assert.equal(shopifyHandle('/product/luna-teapot.html'), null);
  assert.equal(shopifyJsonUrl('https://shop.example/products/pikachu/?variant=1#x'), 'https://shop.example/products/pikachu.json');
});

test('woocommerce: a Store API product becomes a listing keyed <host>/p/<id>', () => {
  const r = fromWooProduct(woo[0], { baseUrl: 'https://woo.example', via: 'runner', now: NOW });
  assert.equal(r.ok, true, r.message);
  const l = r.listing;
  assert.equal(l.source.key, 'woo.example/p/42');
  assert.equal(l.source.url, 'https://woo.example/product/hedwig-3d-mug/');
  assert.equal(l.source.via, 'runner');
  assert.equal(l.name, `Hedwig 3D Mug ${String.fromCharCode(0x2013)} Ceramic`, 'the entity decodes to an en dash');
  assert.deepEqual(l.price, { amount: 18.95, currency: 'EUR' }, 'minor units');
  assert.equal(l.brand, 'Wizarding World');
  assert.equal(l.capacityMl, 500);
  assert.equal(l.material, 'porcelain', 'from a French attribute name, folded');
  assert.equal(l.gtin, '0200000000004', 'a UPC-A gains its leading zero');
  assert.equal(l.dishwasherSafe, false);
  assert.equal(l.available, true);
  assert.equal(l.productType, 'Mugs');
  assert.deepEqual(l.tags, ['harry potter']);
  assert.equal(l.franchise, 'Harry Potter');
  assert.equal(l.character, 'Hedwig');
  assert.equal(fromWooProduct(woo[1], { baseUrl: 'https://woo.example', now: NOW }).listing.isMug.verdict, 'no');
  assert.equal(fromWooProduct(woo[2], { baseUrl: 'https://woo.example', now: NOW }).listing.isMug.verdict, 'maybe', 'mug and coaster set');
  assert.equal(fromWooProduct({ name: 'No id' }, { baseUrl: 'https://woo.example' }).code, 'bad-source');
});

test('woocommerce: A6 source brand, and the Store API URL', () => {
  const l = fromWooProduct(woo[0], { baseUrl: 'https://woo.example', now: NOW, brand: 'Fixture Maker' }).listing;
  assert.equal(l.brand, 'Fixture Maker');
  assert.equal(l.vendor, 'Wizarding World', 'A8: the shop brand taxonomy is the vendor');
  assert.equal(l.franchise, 'Harry Potter', 'from the title: the brand taxonomy names no franchise detectFranchise knows');
  assert.equal(wooProductsUrl('https://woo.example/shop/', { page: 2, search: 'mug' }), 'https://woo.example/wp-json/wc/store/v1/products?per_page=50&page=2&search=mug');
  assert.equal(wooProductsUrl('https://woo.example/wp-json/wc/store/v1/products', { page: 1 }), 'https://woo.example/wp-json/wc/store/v1/products?per_page=50&page=1');
});

test('A8: a vendor never decides a fact, only offers a franchise', () => {
  const product = {
    title: 'Taza 3D Kenny McCormick',
    handle: 'taza-3d-kenny',
    vendor: 'Fixture Ceramics',
    product_type: 'Tazas',
    tags: ['south park'],
    variants: [{ sku: 'FIX-KENNY-3D', price: '18,95', available: true }],
  };
  const l = fromShopifyProduct(product, { ...opts, brand: 'Grupo Erik' }).listing;
  assert.equal(l.brand, 'Grupo Erik');
  assert.equal(l.vendor, 'Fixture Ceramics');
  assert.equal(l.material, undefined, 'a vendor called "Ceramics" must not make the mug ceramic');
  assert.equal(l.franchise, 'South Park', 'the franchise still comes from the tags');
});
