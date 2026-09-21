// fromPaste on the owner's six real pastes, verbatim, plus the rules around
// them. Amazon is never fetched: this is pure text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { amazonProductUrl, cutName, fromPaste } from '../shared/extract/paste.js';

const NOW = 1758470400000;

const EXAMPLES = [
  {
    text: `https://www.amazon.com/gp/product/B0GR5CDBHZ/ref=ox_sc_saved_title_1?smid=ATVPDKIKX0DER&psc=1
Amazon.com: Paladone Astrobot Shaped Mug - Officially Licensed Astrobot Product | Large 600ml Capacity • Character Shaped Mug • Unique Gaming Design • Durable Build • Astrobot Fan Gift : Home & Kit...
 Versatile lid: Multi-way design for easy drinking on the go`,
    want: { brand: 'Paladone', name: 'Astrobot Shaped Mug', capacityMl: 600, style: 'shaped', hasLid: true, franchise: 'Astro Bot', key: 'amazon:B0GR5CDBHZ', url: 'https://www.amazon.com/dp/B0GR5CDBHZ' },
  },
  {
    text: `https://www.amazon.ca/gp/product/B0B4KGF9ZV/ref=ox_sc_saved_image_4?smid=&psc=1
ABYSTYLE - DC Comics Joker Head 3D Mug : Amazon.ca: Home
 100% official`,
    want: { brand: 'ABYstyle', name: 'DC Comics Joker Head 3D Mug', style: 'sculpted', franchise: 'DC Comics', character: 'Joker', key: 'amazon:B0B4KGF9ZV', url: 'https://www.amazon.ca/dp/B0B4KGF9ZV' },
  },
  {
    text: `https://www.amazon.ca/gp/product/B0D7J45CH5/ref=ox_sc_saved_image_2?smid=A3C9554I6S5ZCE&psc=1
ABYSTYLE - Pokemon Pikachu 3D Mug : Amazon.ca: Home
 Capacity: approx. 475 ml.`,
    want: { brand: 'ABYstyle', name: 'Pokemon Pikachu 3D Mug', capacityMl: 475, style: 'sculpted', franchise: 'Pokemon', character: 'Pikachu', key: 'amazon:B0D7J45CH5', url: 'https://www.amazon.ca/dp/B0D7J45CH5' },
  },
  {
    text: `Star Wars Ewok 16 oz. Bas Relief Ceramic Mug : Amazon.ca: Home
 CUSTOM DESIGN- The Star Wars Ewok 16 oz. Bas Relief Ceramic Mug features vibrant colors and original sculpted artwork inspired by the cuddliest Star Wars characters in the galaxy`,
    want: { brand: undefined, name: 'Star Wars Ewok 16 oz. Bas Relief Ceramic Mug', capacityMl: 473, style: 'relief', material: 'ceramic', franchise: 'Star Wars', character: 'Ewok', url: undefined },
  },
  {
    text: `https://www.amazon.com/gp/product/B0CZ7KWSCD/ref=ox_sc_saved_title_1?smid=A1QZWXTEK2QD0C&psc=1
Amazon.com | ABYstyle Sailor Moon Luna Teapot Anime Manga Magical Girl Collectible Home Decor Kitchenware Merchandise Gift, Black: Teapots
 Capacity: 32.0 fluid_ounces`,
    want: { brand: 'ABYstyle', name: 'Sailor Moon Luna Teapot', capacityMl: 946, style: 'teapot', franchise: 'Sailor Moon', key: 'amazon:B0CZ7KWSCD', url: 'https://www.amazon.com/dp/B0CZ7KWSCD' },
  },
  {
    text: `https://www.amazon.com/gp/product/B0F77SMSV7/ref=ox_sc_saved_title_6?smid=A2XZ7JICGUQ1CX&th=1
Amazon.com | Silver Buffalo South Park Kenny McCormick, 3D Sculpted Mug, 20oz | Ceramic, 0.59 Liters: Coffee Cups & Mugs
 SOUTH PARK: Themed mug features Kenny in his iconic orange hoodie. Mug is complete with a white interior.`,
    want: { brand: 'Silver Buffalo', name: 'South Park Kenny McCormick 3D Sculpted Mug', capacityMl: 590, style: 'sculpted', material: 'ceramic', franchise: 'South Park', character: 'Kenny McCormick', key: 'amazon:B0F77SMSV7', url: 'https://www.amazon.com/dp/B0F77SMSV7' },
  },
];

for (const [i, { text, want }] of EXAMPLES.entries()) {
  test(`the owner's paste ${i + 1}: ${want.name}`, () => {
    const r = fromPaste(text, { now: NOW });
    assert.equal(r.ok, true, r.message);
    const l = r.listing;
    assert.equal(l.name, want.name);
    assert.equal(l.brand, want.brand);
    assert.equal(l.style, want.style);
    assert.equal(l.franchise, want.franchise);
    if ('capacityMl' in want) assert.equal(l.capacityMl, want.capacityMl);
    if ('hasLid' in want) assert.equal(l.hasLid, want.hasLid);
    else assert.equal(l.hasLid, undefined, 'no lid is claimed without the words');
    if ('material' in want) assert.equal(l.material, want.material);
    if ('character' in want) assert.equal(l.character, want.character);
    if (want.key) assert.equal(l.source.key, want.key);
    else assert.match(l.source.key, /^paste:/);
    assert.equal(l.source.url, want.url);
    assert.equal(l.source.platform, 'paste');
    assert.equal(l.source.via, 'browser');
    assert.equal(l.source.fetchedAt, NOW);
    assert.equal(l.isMug.verdict, 'yes');
  });
}

test('the Ewok paste keys on its name, not a URL', () => {
  const l = fromPaste(EXAMPLES[3].text, { now: NOW }).listing;
  assert.equal(l.source.key, 'paste:bas ewok relief');
  assert.equal(l.source.host, '');
  assert.match(l.description, /sculpted artwork/, 'kept for the admin, but it did not decide the style');
});

test('an explicit url option wins over a URL line, and a non-Amazon URL keys on the name', () => {
  const l = fromPaste(`https://www.amazon.com/dp/B000000000\nPaladone Pac-Man Mug`, { url: 'https://www.amazon.co.uk/dp/B0TESTTEST', now: NOW }).listing;
  assert.equal(l.source.key, 'amazon:B0TESTTEST');
  assert.equal(l.source.url, 'https://www.amazon.co.uk/dp/B0TESTTEST');
  const shop = fromPaste('https://shop.example/products/pac-man-mug?ref=1#x\nPac-Man Arcade Mug', { now: NOW }).listing;
  assert.equal(shop.source.url, 'https://shop.example/products/pac-man-mug?ref=1');
  assert.match(shop.source.key, /^paste:/);
});

test('brands: knownBrands, a Brand: line, "Visit the X Store", a trailing brand', () => {
  assert.equal(fromPaste('Fixture Works Totoro Mug', { knownBrands: ['Fixture Works'], now: NOW }).listing.brand, 'Fixture Works');
  const byLine = fromPaste('Gengar Head Mug\nBrand: Spooky Ceramics', { now: NOW }).listing;
  assert.equal(byLine.brand, 'Spooky Ceramics');
  assert.equal(byLine.name, 'Gengar Head Mug');
  const store = fromPaste('Visit the Numskull Store\nNumskull Official Gengar Mug', { now: NOW }).listing;
  assert.deepEqual([store.brand, store.name], ['Numskull', 'Official Gengar Mug']);
  const trailing = fromPaste('Snorlax Sleepy Mug - Pyramid International', { now: NOW }).listing;
  assert.deepEqual([trailing.brand, trailing.name], ['Pyramid International', 'Snorlax Sleepy Mug']);
  const variant = fromPaste('BIG MOUTH INC. Grogu Mug', { now: NOW }).listing;
  assert.deepEqual([variant.brand, variant.name], ['BigMouth Inc', 'Grogu Mug'], 'brand variants match');
});

test('the name ends after the product noun, unless the words continue the product', () => {
  assert.equal(cutName('Hedwig Mug and Coaster Set - Gift Box'), 'Hedwig Mug and Coaster Set');
  assert.equal(cutName('Grogu Travel Mug with Lid, 16oz'), 'Grogu Travel Mug with Lid');
  assert.equal(cutName('Tea for One Teapot Mug | Blue'), 'Tea for One Teapot Mug');
  assert.equal(cutName('FIFA World Cup Trophy Mug - Official'), 'FIFA World Cup Trophy Mug', 'cup only counts when no strong noun appears');
  assert.equal(cutName('Espresso Cup and Saucer Set, White'), 'Espresso Cup and Saucer Set');
  assert.equal(cutName('Mug 3D Pikachu - Pokemon | 475 ml'), 'Mug 3D Pikachu', 'a leading noun cuts at the first separator');
  assert.equal(cutName('Frankenstein Stein, 1 L'), 'Frankenstein Stein');
});

test('lids are never claimed from a denial, and Amazon URLs are rebuilt', () => {
  const l = fromPaste('Grogu Travel Mug\nLid not included. Hand wash only.', { now: NOW }).listing;
  assert.equal(l.hasLid, undefined);
  assert.equal(l.dishwasherSafe, false);
  assert.equal(amazonProductUrl('https://smile.amazon.com/Some-Title/dp/B0ABCDEFGH/ref=x'), 'https://www.amazon.com/dp/B0ABCDEFGH');
  assert.equal(amazonProductUrl('https://www.amazon.co.uk/gp/product/b0abcdefgh'), 'https://www.amazon.co.uk/dp/B0ABCDEFGH');
  assert.equal(amazonProductUrl('https://shop.example/dp/B0ABCDEFGH'), null);
  assert.equal(amazonProductUrl('not a url'), null);
});

test('nothing to name is refused, as normalizeListing refuses it', () => {
  assert.equal(fromPaste('https://www.amazon.com/dp/B0GR5CDBHZ', { now: NOW }).code, 'no-name');
  assert.equal(fromPaste('', { now: NOW }).code, 'no-name');
});
