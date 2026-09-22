// A single URL import borrows the brand and currency of the source that owns
// the URL's host (A6, A13), as a scan does. Plain node: the lookup is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceForHost } from '../convex/lib/sourceHost.ts';

const SOURCES = [
  { slug: 'abystyle-eu', baseUrl: 'https://www.abystyle.com', entryUrls: [], enabled: true },
  { slug: 'abystyle-us-old', baseUrl: 'https://abystyle.us', entryUrls: [], enabled: false },
  { slug: 'abystyle-us', baseUrl: 'https://abystyle.us', entryUrls: ['https://abystyle.us/collections/3d-mugs'], enabled: true },
  { slug: 'paladone', baseUrl: 'https://trade.paladone.com', entryUrls: ['https://trade.paladone.com/usa/drinkware'], enabled: true },
  { slug: 'feed-elsewhere', baseUrl: 'https://brand.example', entryUrls: ['https://shop.brand.example/collections/mugs'], enabled: true },
];

test('the source on the same host wins, an enabled one before a disabled one', () => {
  assert.equal(sourceForHost(SOURCES, 'abystyle.us').slug, 'abystyle-us');
  assert.equal(sourceForHost(SOURCES, 'trade.paladone.com').slug, 'paladone');
});

test('hosts compare without "www.", and an entry URL on another host counts', () => {
  assert.equal(sourceForHost(SOURCES, 'www.abystyle.com').slug, 'abystyle-eu');
  assert.equal(sourceForHost(SOURCES, 'abystyle.com').slug, 'abystyle-eu');
  assert.equal(sourceForHost(SOURCES, 'shop.brand.example').slug, 'feed-elsewhere');
});

test('no source for the host, or no host at all, is null', () => {
  assert.equal(sourceForHost(SOURCES, 'paladone.com'), null, 'a sibling host is not the same shop');
  assert.equal(sourceForHost(SOURCES, ''), null);
  assert.equal(sourceForHost([], 'abystyle.us'), null);
});
