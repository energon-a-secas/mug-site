// The Worker end to end: its default export's fetch(request, env), with an
// in-memory R2 and a stubbed global fetch serving synthetic shops. Every
// route, every C3 error code, auth, /i/ key validation and 304.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import * as main from '../worker/src/index.js';
import { HTTP_STATUS } from '../worker/src/errors.js';
import { robotsCache } from '../worker/src/runtime.js';
import { FETCH_ERROR_CODES } from '../shared/net/polite.js';
import { FakeR2, fakeWeb, fixture } from './fixtures/fakes.mjs';

const TOKEN = 'test-proxy-token-0123456789abcdef';
const BASE = 'https://mug-proxy.test';
const PNG = fixture('shop/img/pikachu.png', { binary: true });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x10, 0, 0, 0, 0xdf, 0x01, 0x00, 0x67, 0x01, 0x00]);
const ROBOTS = { body: 'User-agent: *\nDisallow: /cart\n\nUser-agent: MugBot\nDisallow: /private/\nAllow: /\n' };
const OPEN = { status: 404 };

let original;
beforeEach(() => {
  robotsCache.clear();
  original = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

function web(routes) {
  const fn = fakeWeb(routes);
  globalThis.fetch = fn;
  return fn;
}

function envWith(extra = {}) {
  return { MUG_PROXY_TOKEN: TOKEN, IMAGES: new FakeR2(), ...extra };
}

async function call(method, path, { body, raw, token = TOKEN, headers = {}, env = envWith() } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (raw !== undefined) {
    init.body = raw;
    if (raw instanceof ReadableStream) init.duplex = 'half';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = null;
  }
  return { res, json, bytes, env };
}

const post = (path, body, opts = {}) => call('POST', path, { body, ...opts });

function feedOf(n) {
  return { products: Array.from({ length: n }, (_, i) => ({ title: `Fixture Mug ${i}`, handle: `fixture-mug-${i}`, product_type: 'Mugs', variants: [{ price: '10.00', available: true }] })) };
}

const shopRoutes = (extra = {}) => ({
  'https://shop.example/robots.txt': ROBOTS,
  'https://shop.example/products.json?limit=50&page=1': { body: fixture('shop/products.json'), headers: { 'content-type': 'application/json' } },
  'https://shop.example/products/pikachu-3d-mug.json': { body: fixture('shop/products/pikachu-3d-mug.json'), headers: { 'content-type': 'application/json' } },
  'https://shop.example/img/pikachu.png': { body: PNG, headers: { 'content-type': 'image/png' } },
  ...extra,
});

const worker = main.default;
const { ERROR_CODES } = main;

// ── The contract's lists ─────────────────────────────────────────────────────

test('the main module exports only what workerd accepts as entrypoints', () => {
  // workerd reads every named export of the main module as an entrypoint and
  // refuses to start on a number or a string (found under wrangler dev, where
  // node --test cannot see it). Anything else a test needs lives in runtime.js.
  assert.deepEqual(Object.keys(main).sort(), ['ERROR_CODES', 'default']);
  for (const [name, value] of Object.entries(main)) {
    assert.ok(typeof value === 'function' || (value !== null && typeof value === 'object'), `${name} is a function or an object`);
  }
  assert.equal(typeof main.default.fetch, 'function');
});

test('ERROR_CODES and their statuses are exactly C3\'s table', () => {
  assert.deepEqual([...ERROR_CODES], [
    'UNAUTHORIZED', 'BAD_REQUEST', 'URL_NOT_ALLOWED', 'ROBOTS_DISALLOWED', 'UPSTREAM_BLOCKED', 'UPSTREAM_ERROR',
    'UPSTREAM_TIMEOUT', 'TOO_LARGE', 'NOT_A_PRODUCT', 'NOT_AN_IMAGE', 'NOT_CONFIGURED', 'NOT_FOUND', 'INTERNAL',
  ]);
  assert.deepEqual({ ...HTTP_STATUS }, {
    UNAUTHORIZED: 401, BAD_REQUEST: 400, URL_NOT_ALLOWED: 400, ROBOTS_DISALLOWED: 403, UPSTREAM_BLOCKED: 502, UPSTREAM_ERROR: 502,
    UPSTREAM_TIMEOUT: 504, TOO_LARGE: 413, NOT_A_PRODUCT: 422, NOT_AN_IMAGE: 422, NOT_CONFIGURED: 501, NOT_FOUND: 404, INTERNAL: 500,
  });
  for (const code of FETCH_ERROR_CODES) assert.ok(ERROR_CODES.includes(code), `${code} is a C3 code`);
});

test('every C3 code can be triggered, on its C3 status, as a JSON envelope', async () => {
  const scenarios = {
    UNAUTHORIZED: () => post('/v1/probe', { url: 'https://shop.example/' }, { token: 'wrong' }),
    BAD_REQUEST: () => post('/v1/probe', { nope: true }),
    URL_NOT_ALLOWED: () => post('/v1/extract', { url: 'http://169.254.169.254/latest/meta-data/' }),
    ROBOTS_DISALLOWED: () => { web(shopRoutes()); return post('/v1/extract', { url: 'https://shop.example/private/deal' }); },
    UPSTREAM_BLOCKED: () => { web(shopRoutes({ 'https://shop.example/product/x': { status: 403, body: fixture('challenge.html'), headers: { 'content-type': 'text/html' } } })); return post('/v1/extract', { url: 'https://shop.example/product/x' }); },
    UPSTREAM_ERROR: () => { web(shopRoutes({ 'https://shop.example/product/x': { status: 500 } })); return post('/v1/extract', { url: 'https://shop.example/product/x' }); },
    UPSTREAM_TIMEOUT: () => { web(shopRoutes({ 'https://shop.example/product/x': () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } })); return post('/v1/extract', { url: 'https://shop.example/product/x' }); },
    TOO_LARGE: () => { web(shopRoutes({ 'https://shop.example/product/x': () => new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }) })); return post('/v1/extract', { url: 'https://shop.example/product/x' }); },
    NOT_A_PRODUCT: () => { web(shopRoutes({ 'https://shop.example/blog/x': { body: fixture('opengraph-article.html'), headers: { 'content-type': 'text/html' } } })); return post('/v1/extract', { url: 'https://shop.example/blog/x' }); },
    NOT_AN_IMAGE: () => { web(shopRoutes({ 'https://shop.example/img/fake.png': { body: '<html>not an image</html>', headers: { 'content-type': 'image/png' } } })); return post('/v1/images/mirror', { url: 'https://shop.example/img/fake.png' }); },
    NOT_CONFIGURED: () => post('/v1/probe', { url: 'https://shop.example/' }, { env: { IMAGES: new FakeR2() } }),
    NOT_FOUND: () => call('GET', `/i/o/${'a'.repeat(64)}.png`, { token: null }),
    INTERNAL: () => call('DELETE', `/v1/images/o/${'a'.repeat(64)}.png`, { env: envWith({ IMAGES: { head: () => { throw new Error('R2 exploded'); } } }) }),
  };
  assert.deepEqual(Object.keys(scenarios).sort(), [...ERROR_CODES].sort());
  for (const [code, run] of Object.entries(scenarios)) {
    robotsCache.clear();
    const { res, json } = await run();
    assert.equal(json && json.code, code, `${code}: got ${JSON.stringify(json)}`);
    assert.equal(res.status, HTTP_STATUS[code], `${code} status`);
    assert.equal(json.ok, false);
    assert.equal(typeof json.message, 'string');
    assert.match(res.headers.get('content-type'), /application\/json/);
  }
});

// ── /health and auth ─────────────────────────────────────────────────────────

test('/health answers booleans only, never values', async () => {
  const full = await call('GET', '/health', { token: null, env: envWith({ MUG_DEV_ALLOW_LOOPBACK: '1' }) });
  assert.equal(full.res.status, 200);
  assert.deepEqual(full.json, { ok: true, version: full.json.version, r2: true, token: true, devLoopback: true });
  assert.match(full.json.version, /^\d+\.\d+\.\d+$/);
  assert.equal(new TextDecoder().decode(full.bytes).includes(TOKEN), false);
  const bare = await call('GET', '/health', { token: null, env: {} });
  assert.deepEqual(bare.json, { ok: true, version: bare.json.version, r2: false, token: false, devLoopback: false });
  assert.equal((await call('HEAD', '/health', { token: null })).res.status, 200);
});

test('every POST, PUT and DELETE needs the bearer; a Worker without the secret refuses everything', async () => {
  const fetchLog = web(shopRoutes());
  for (const [method, path] of [['POST', '/v1/probe'], ['POST', '/v1/discover'], ['POST', '/v1/extract'], ['POST', '/v1/images/mirror'], ['PUT', '/v1/images/put?kind=thumb'], ['DELETE', `/v1/images/o/${'a'.repeat(64)}.png`], ['POST', '/v1/no-such-route']]) {
    const missing = await call(method, path, { token: null, body: method === 'DELETE' ? undefined : {} });
    assert.equal(missing.res.status, 401, `${method} ${path} without a token`);
    const wrong = await call(method, path, { token: `${TOKEN}x`, body: method === 'DELETE' ? undefined : {} });
    assert.equal(wrong.json.code, 'UNAUTHORIZED');
  }
  const lower = await call('POST', '/v1/probe', { token: null, headers: { authorization: `bearer ${TOKEN}` }, body: { url: 'https://shop.example/' } });
  assert.equal(lower.json.ok, true, 'the scheme is case-insensitive');
  const unset = await post('/v1/probe', { url: 'https://shop.example/' }, { env: { MUG_PROXY_TOKEN: '' } });
  assert.deepEqual([unset.res.status, unset.json.code], [501, 'NOT_CONFIGURED']);
  assert.match(unset.json.hint, /wrangler secret put MUG_PROXY_TOKEN/);
  fetchLog.calls.length = 0;
  await post('/v1/probe', { url: 'https://shop.example/' }, { token: 'wrong' });
  assert.equal(fetchLog.calls.length, 0, 'nothing is fetched for an unauthorised caller');
});

test('request shapes: BAD_REQUEST, with an Allow header for a wrong method', async () => {
  const cases = [
    await call('POST', '/v1/probe', { raw: '{not json', headers: { 'content-type': 'application/json' } }),
    await post('/v1/probe', [1, 2]),
    await post('/v1/probe', { url: '/relative/path' }),
    await post('/v1/probe', { url: 42 }),
    await post('/v1/discover', { adapter: 'magento', url: 'https://shop.example/' }),
    await post('/v1/discover', { adapter: 'manual', url: 'https://shop.example/' }),
    await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', page: 0 }),
    await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', page: 1.5 }),
    await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', include: 'mug' }),
    await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', exclude: [1] }),
    await call('PUT', '/v1/images/put?kind=poster', { raw: PNG }),
    // Own keys only: an inherited name once stored an object under a junk key.
    await call('PUT', '/v1/images/put?kind=constructor', { raw: PNG }),
    await call('PUT', '/v1/images/put?kind=__proto__', { raw: PNG }),
    await call('DELETE', '/v1/images/not-a-key'),
  ];
  for (const { res, json } of cases) assert.deepEqual([res.status, json.code], [400, 'BAD_REQUEST'], JSON.stringify(json));
  const wrongMethod = await call('GET', '/v1/probe', { token: null });
  assert.equal(wrongMethod.res.status, 400);
  assert.equal(wrongMethod.res.headers.get('allow'), 'POST');
  const big = await post('/v1/probe', { url: `https://shop.example/?q=${'x'.repeat(70000)}` });
  assert.equal(big.json.code, 'TOO_LARGE');
  const unknown = await call('GET', '/nothing-here', { token: null });
  assert.deepEqual([unknown.res.status, unknown.json.code], [404, 'NOT_FOUND']);
});

// ── probe ────────────────────────────────────────────────────────────────────

test('probe: robots verdict for the path, and platform detection', async () => {
  web(shopRoutes({ 'https://shop.example/products.json?limit=1': { body: fixture('shop/products.json') } }));
  const shopify = await post('/v1/probe', { url: 'https://shop.example/collections/mugs' });
  assert.deepEqual(shopify.json, { ok: true, robots: { allowed: true, rule: 'Allow: /' }, platform: 'shopify', status: 200 });
  const refused = await post('/v1/probe', { url: 'https://shop.example/private/sale' });
  assert.deepEqual([refused.json.robots, refused.json.platform], [{ allowed: false, rule: 'Disallow: /private/' }, 'shopify'], 'a refused path is information, not an error');

  const wooLog = web({
    'https://woo.example/robots.txt': OPEN,
    'https://woo.example/wp-json/wc/store/v1/products?per_page=1': { body: JSON.stringify([JSON.parse(fixture('woo-products.json'))[0]]) },
  });
  const woo = await post('/v1/probe', { url: 'https://woo.example/shop/' });
  assert.deepEqual([woo.json.platform, woo.json.status, woo.json.robots.allowed], ['woocommerce', 200, true]);
  assert.match(woo.json.robots.rule, /404/);
  for (const call of wooLog.calls) assert.match(call.init.headers['user-agent'], /^MugBot\//);

  web({ 'https://plain.example/robots.txt': OPEN });
  const unknown = await post('/v1/probe', { url: 'https://plain.example/' });
  assert.deepEqual([unknown.json.platform, unknown.json.status], ['unknown', 404]);

  web({ 'https://walled.example/robots.txt': OPEN, 'https://walled.example/products.json': { status: 403 }, 'https://walled.example/wp-json/wc/store/v1/products': { status: 403 } });
  const walled = await post('/v1/probe', { url: 'https://walled.example/' });
  assert.deepEqual([walled.res.status, walled.json.code, walled.json.upstreamStatus], [502, 'UPSTREAM_BLOCKED', 403]);
});

// ── discover ─────────────────────────────────────────────────────────────────

test('discover shopify: listings filtered, skipped counted, one page per call', async () => {
  const log = web(shopRoutes());
  const r = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/' });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.listings.map((l) => l.source.key), ['shop.example/products/pikachu-3d-mug', 'shop.example/products/ewok-bas-relief-mug', 'shop.example/products/taza-3d-kenny']);
  assert.equal(r.json.skipped, 2, 'the plush and the coasters');
  assert.equal(r.json.next, null);
  assert.equal(r.json.urls, undefined);
  assert.deepEqual(Object.keys(r.json.fetched).sort(), ['bytes', 'ms', 'status', 'url']);
  assert.equal(r.json.fetched.url, 'https://shop.example/products.json?limit=50&page=1');
  assert.equal(r.json.listings[0].source.via, 'worker');
  assert.ok(log.calls.length <= 4, `at most four subrequests, made ${log.calls.length}`);

  const only = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', include: ['taza'] });
  assert.deepEqual([only.json.listings.length, only.json.skipped], [1, 4]);
  const minus = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', exclude: ['Star Wars'] });
  assert.equal(minus.json.listings.some((l) => l.name.includes('Ewok')), false);
});

test('discover shopify: a full page means a next page; a collection URL gets its own feed; A6 brand', async () => {
  const log = web(shopRoutes({ 'https://shop.example/collections/mugs/products.json?limit=50&page=2': { body: JSON.stringify(feedOf(50)) } }));
  const full = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/collections/mugs', page: 2 });
  assert.deepEqual(full.json.next, { page: 3 });
  assert.equal(full.json.listings.length, 50);
  assert.ok(log.urls().includes('https://shop.example/collections/mugs/products.json?limit=50&page=2'));

  const branded = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', brand: 'Bioworld' });
  const ewok = branded.json.listings.find((l) => l.name.includes('Ewok'));
  assert.equal(ewok.brand, 'Bioworld');
  assert.equal(ewok.franchise, 'Star Wars');
  assert.ok(ewok.tags.includes('star wars'));
  const ignored = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', brand: 7 });
  assert.equal(ignored.json.listings[0].brand, 'ABYstyle', 'a brand that is not a string is ignored');

  web(shopRoutes({ 'https://shop.example/products.json?limit=50&page=1': { body: '<html>maintenance</html>' } }));
  assert.equal((await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/' })).json.code, 'UPSTREAM_ERROR');
  web(shopRoutes({ 'https://shop.example/products.json?limit=50&page=1': { body: '{"items": []}' } }));
  assert.match((await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/' })).json.message, /Shopify products feed/);
});

test('discover woocommerce: the Store API, the first include word as search, X-WP-TotalPages', async () => {
  const log = web({
    'https://woo.example/robots.txt': OPEN,
    'https://woo.example/wp-json/wc/store/v1/products?per_page=50&page=1&search=mug': { body: fixture('woo-products.json'), headers: { 'x-wp-totalpages': '2' } },
    'https://woo.example/wp-json/wc/store/v1/products?per_page=50&page=2': { body: '[]', headers: { 'x-wp-totalpages': '2' } },
  });
  const r = await post('/v1/discover', { adapter: 'woocommerce', url: 'https://woo.example/shop/', include: ['mug', 'taza'] });
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.listings.map((l) => l.source.key), ['woo.example/p/42', 'woo.example/p/44']);
  assert.equal(r.json.skipped, 1, 'the keychain');
  assert.deepEqual(r.json.next, { page: 2 });
  assert.ok(log.urls().includes('https://woo.example/wp-json/wc/store/v1/products?per_page=50&page=1&search=mug'));
  const last = await post('/v1/discover', { adapter: 'woocommerce', url: 'https://woo.example/', page: 2 });
  assert.equal(last.json.next, null);
  web({ 'https://woo.example/robots.txt': OPEN, 'https://woo.example/wp-json/wc/store/v1/products': { status: 404, body: '{"code":"rest_no_route"}' } });
  assert.deepEqual((await post('/v1/discover', { adapter: 'woocommerce', url: 'https://woo.example/' })).json.upstreamStatus, 404);
});

test('discover jsonld: an HTML listing answers product URLs and its rel="next" (A1)', async () => {
  web({ 'https://shop.example/robots.txt': ROBOTS, 'https://shop.example/collections/mugs': { body: fixture('shop/collections/mugs.html').replaceAll('http://127.0.0.1:8899', 'https://shop.example'), headers: { 'content-type': 'text/html' } } });
  const r = await post('/v1/discover', { adapter: 'jsonld', url: 'https://shop.example/collections/mugs', exclude: ['coaster'] });
  assert.deepEqual(r.json.urls, ['https://shop.example/products/pikachu-3d-mug', 'https://shop.example/products/ewok-bas-relief-mug', 'https://shop.example/product/luna-teapot.html']);
  assert.equal(r.json.skipped, 1);
  assert.deepEqual(r.json.next, { page: 2, url: 'https://shop.example/collections/mugs?page=2' });
  assert.equal(r.json.listings, undefined);
});

test('discover jsonld: a urlset is paged 200 entries at a time', async () => {
  const locs = Array.from({ length: 450 }, (_, i) => `<url><loc>https://brand.example/product/mug-${i}</loc></url>`).join('');
  web({ 'https://brand.example/robots.txt': OPEN, 'https://brand.example/sitemap.xml': { body: `<?xml version="1.0"?><urlset>${locs}</urlset>`, headers: { 'content-type': 'application/xml' } } });
  const p1 = await post('/v1/discover', { adapter: 'jsonld', url: 'https://brand.example/sitemap.xml' });
  assert.deepEqual([p1.json.urls.length, p1.json.next], [200, { page: 2 }]);
  const p3 = await post('/v1/discover', { adapter: 'jsonld', url: 'https://brand.example/sitemap.xml', page: 3 });
  assert.deepEqual([p3.json.urls.length, p3.json.next, p3.json.urls[0]], [50, null, 'https://brand.example/product/mug-400']);
});

test('discover jsonld: a sitemap index is walked one child at a time, the position carried in next.url', async () => {
  const child1 = `<urlset>${Array.from({ length: 250 }, (_, i) => `<url><loc>https://brand.example/p/${i}</loc></url>`).join('')}</urlset>`;
  const log = web({
    'https://brand.example/robots.txt': { body: 'User-agent: *\nDisallow: /sitemap-products-2.xml\n' },
    'https://brand.example/sitemap.xml': { body: fixture('sitemap-index.xml') },
    'https://brand.example/sitemap-products-1.xml': { body: child1 },
  });
  const first = await post('/v1/discover', { adapter: 'jsonld', url: 'https://brand.example/sitemap.xml' });
  assert.equal(first.json.urls.length, 200);
  assert.equal(first.json.skipped, 2, 'the pages sitemap and the other host, counted once');
  assert.deepEqual(first.json.next, { page: 2, url: 'https://brand.example/sitemap.xml#mug-child=0&mug-offset=200' });
  assert.equal(first.json.fetched.url, 'https://brand.example/sitemap-products-1.xml');
  assert.equal(log.calls.length, 3, 'robots, the index, one child');

  const second = await post('/v1/discover', { adapter: 'jsonld', url: first.json.next.url, page: 2 });
  assert.deepEqual([second.json.urls.length, second.json.urls[0], second.json.skipped], [50, 'https://brand.example/p/200', 0]);
  assert.deepEqual(second.json.next, { page: 3, url: 'https://brand.example/sitemap.xml#mug-child=1&mug-offset=0' });
  assert.equal(log.urls().some((u) => u.includes('#')), false, 'the fragment is never sent to the shop');

  const third = await post('/v1/discover', { adapter: 'jsonld', url: second.json.next.url, page: 3 });
  assert.deepEqual([third.res.status, third.json.urls, third.json.skipped, third.json.next], [200, [], 1, null], 'a child robots.txt refuses is skipped, not fatal');
});

test('discover jsonld: a gzipped sitemap is inflated', async () => {
  const xml = '<urlset><url><loc>https://brand.example/product/a</loc></url><url><loc>https://brand.example/product/b</loc></url></urlset>';
  web({ 'https://brand.example/robots.txt': OPEN, 'https://brand.example/sitemap-products.xml.gz': { body: new Uint8Array(gzipSync(xml)), headers: { 'content-type': 'application/gzip' } } });
  const r = await post('/v1/discover', { adapter: 'jsonld', url: 'https://brand.example/sitemap-products.xml.gz' });
  assert.deepEqual(r.json.urls, ['https://brand.example/product/a', 'https://brand.example/product/b']);
});

// ── extract ──────────────────────────────────────────────────────────────────

test('extract: a Shopify product path reads <url>.json first and never the HTML', async () => {
  const log = web(shopRoutes());
  const r = await post('/v1/extract', { url: 'https://shop.example/products/pikachu-3d-mug?variant=1' });
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.listing.source.platform, 'shopify');
  assert.deepEqual(r.json.listing.price, { amount: 18.95, currency: 'EUR' });
  assert.equal(r.json.listing.gtin, '2000000000015');
  assert.equal(r.json.fetched.url, 'https://shop.example/products/pikachu-3d-mug.json');
  assert.deepEqual(log.urls(), ['https://shop.example/robots.txt', 'https://shop.example/products/pikachu-3d-mug.json']);
});

test('extract: a JSON miss or refusal falls back to the HTML; a JSON timeout is answered as it is', async () => {
  const page = { body: fixture('shop/product/luna-teapot.html').replaceAll('http://127.0.0.1:8899', 'https://shop.example'), headers: { 'content-type': 'text/html' } };
  web(shopRoutes({ 'https://shop.example/products/luna-teapot': page }));
  const r = await post('/v1/extract', { url: 'https://shop.example/products/luna-teapot' });
  assert.equal(r.json.listing.source.platform, 'jsonld');
  assert.equal(r.json.listing.name, 'Sailor Moon Luna Teapot');

  const guarded = web(shopRoutes({ 'https://shop.example/products/luna-teapot.json': { status: 403 }, 'https://shop.example/products/luna-teapot': page }));
  const fallback = await post('/v1/extract', { url: 'https://shop.example/products/luna-teapot' });
  assert.equal(fallback.json.listing.name, 'Sailor Moon Luna Teapot', 'a shop may guard its .json and still serve the page');
  assert.deepEqual(guarded.urls(), ['https://shop.example/products/luna-teapot.json', 'https://shop.example/products/luna-teapot'], 'the refused JSON, then the page (robots.txt is cached from the first call)');

  const both = web(shopRoutes({ 'https://shop.example/products/walled.json': { status: 403 }, 'https://shop.example/products/walled': { status: 403, body: fixture('challenge.html') } }));
  const walled = await post('/v1/extract', { url: 'https://shop.example/products/walled' });
  assert.deepEqual([walled.json.code, walled.json.upstreamStatus], ['UPSTREAM_BLOCKED', 403]);
  assert.ok(both.urls().includes('https://shop.example/products/walled'));

  const slow = web(shopRoutes({ 'https://shop.example/products/slow.json': () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 'https://shop.example/products/slow': page }));
  const timeout = await post('/v1/extract', { url: 'https://shop.example/products/slow' });
  assert.equal(timeout.json.code, 'UPSTREAM_TIMEOUT');
  assert.equal(slow.urls().includes('https://shop.example/products/slow'), false, 'no second 15 s wait inside Convex\'s 30 s');
});

test('extract: JSON-LD pages, A6 brand, and pages with no product', async () => {
  web({ 'https://www.brand.example/robots.txt': OPEN, 'https://www.brand.example/stein/dragon-stein': { body: fixture('jsonld-group.html'), headers: { 'content-type': 'text/html; charset=utf-8' } } });
  const r = await post('/v1/extract', { url: 'https://www.brand.example/stein/dragon-stein', brand: 'Fixture Maker' });
  assert.equal(r.json.listing.sku, 'DRG-STEIN-RED');
  assert.equal(r.json.listing.brand, 'Fixture Maker');
  assert.match(r.json.listing.vendor, /brand example/i, 'A8: the page brand is the vendor');

  web({ 'https://shop.example/robots.txt': OPEN, 'https://shop.example/collections/mugs': { body: fixture('itemlist.html') } });
  const listing = await post('/v1/extract', { url: 'https://shop.example/collections/mugs' });
  assert.deepEqual([listing.res.status, listing.json.code], [422, 'NOT_A_PRODUCT']);
  assert.match(listing.json.hint, /pasted by hand/);
});

// ── images ───────────────────────────────────────────────────────────────────

test('mirror: sniffed, hashed, stored once, with the source kept', async () => {
  const log = web(shopRoutes({ 'https://shop.example/img/really-a-jpeg.png': { body: JPEG, headers: { 'content-type': 'text/plain' } } }));
  const env = envWith();
  const r = await post('/v1/images/mirror', { url: 'https://shop.example/img/pikachu.png' }, { env });
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  assert.match(r.json.key, /^o\/[0-9a-f]{64}\.png$/);
  assert.deepEqual({ ...r.json, key: 'k' }, { ok: true, key: 'k', bytes: PNG.length, contentType: 'image/png', w: 6, h: 4 });
  const stored = env.IMAGES.objects.get(r.json.key);
  assert.deepEqual(stored.httpMetadata, { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' });
  assert.deepEqual(stored.customMetadata, { source: 'https://shop.example/img/pikachu.png' });
  assert.equal(env.IMAGES.count('put'), 1);

  const again = await post('/v1/images/mirror', { url: 'https://shop.example/img/pikachu.png' }, { env });
  assert.equal(again.json.key, r.json.key);
  assert.equal(env.IMAGES.count('put'), 1, 'the same bytes are not written twice');

  const disguised = await post('/v1/images/mirror', { url: 'https://shop.example/img/really-a-jpeg.png' }, { env });
  assert.match(disguised.json.key, /\.jpg$/, 'the extension comes from the bytes, never the URL or Content-Type');
  assert.deepEqual([disguised.json.contentType, disguised.json.w, disguised.json.h], ['image/jpeg', 400, 300]);

  const before = log.calls.length;
  const unbound = await post('/v1/images/mirror', { url: 'https://shop.example/img/pikachu.png' }, { env: { MUG_PROXY_TOKEN: TOKEN } });
  assert.deepEqual([unbound.res.status, unbound.json.code], [501, 'NOT_CONFIGURED']);
  assert.equal(log.calls.length, before, 'no R2, no fetch');
});

test('put: raw bytes by kind; refusals for non-images, empty and oversized bodies', async () => {
  const env = envWith();
  const thumb = await call('PUT', '/v1/images/put?kind=thumb', { raw: WEBP, headers: { 'content-type': 'image/png' }, env });
  assert.match(thumb.json.key, /^t\/[0-9a-f]{64}\.webp$/);
  assert.deepEqual([thumb.json.w, thumb.json.h], [480, 360]);
  assert.equal(env.IMAGES.objects.get(thumb.json.key).customMetadata.source, undefined, 'only mirrored images carry a source');
  assert.match((await call('PUT', '/v1/images/put?kind=photo', { raw: JPEG, env })).json.key, /^p\/[0-9a-f]{64}\.jpg$/);
  assert.match((await call('PUT', '/v1/images/put?kind=original', { raw: PNG, env })).json.key, /^o\/[0-9a-f]{64}\.png$/);
  assert.equal((await call('PUT', '/v1/images/put?kind=thumb', { raw: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), env })).json.code, 'NOT_AN_IMAGE');
  assert.equal((await call('PUT', '/v1/images/put?kind=thumb', { raw: new Uint8Array(0), env })).json.code, 'BAD_REQUEST');
  const declared = await call('PUT', '/v1/images/put?kind=photo', { raw: new Uint8Array(16), headers: { 'content-length': String(16 * 1024 * 1024) }, env });
  assert.deepEqual([declared.res.status, declared.json.code], [413, 'TOO_LARGE']);
  let sent = 0;
  const endless = new ReadableStream({ pull(c) { if (sent > 16 * 1024 * 1024) return c.close(); sent += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); } });
  assert.equal((await call('PUT', '/v1/images/put?kind=photo', { raw: endless, env })).json.code, 'TOO_LARGE');
  assert.equal((await call('PUT', '/v1/images/put?kind=thumb', { raw: PNG, env: { MUG_PROXY_TOKEN: TOKEN } })).json.code, 'NOT_CONFIGURED');
});

test('delete: says whether the object existed', async () => {
  const env = envWith();
  const put = await call('PUT', '/v1/images/put?kind=original', { raw: PNG, env });
  const first = await call('DELETE', `/v1/images/${put.json.key}`, { env });
  assert.deepEqual(first.json, { ok: true, deleted: true });
  assert.equal(env.IMAGES.objects.has(put.json.key), false);
  const second = await call('DELETE', `/v1/images/${put.json.key}`, { env });
  assert.deepEqual(second.json, { ok: true, deleted: false });
  assert.equal((await call('DELETE', `/v1/images/${put.json.key}`, { env: { MUG_PROXY_TOKEN: TOKEN } })).json.code, 'NOT_CONFIGURED');
});

test('/i/<key>: public, immutable, CORS-open, with ETag and 304', async () => {
  const env = envWith();
  const { json } = await call('PUT', '/v1/images/put?kind=original', { raw: PNG, env });
  const got = await call('GET', `/i/${json.key}`, { token: null, env });
  assert.equal(got.res.status, 200);
  assert.deepEqual(got.bytes, PNG);
  const h = got.res.headers;
  assert.equal(h.get('content-type'), 'image/png');
  assert.equal(h.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(h.get('access-control-allow-origin'), '*');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('cross-origin-resource-policy'), 'cross-origin');
  const etag = h.get('etag');
  assert.match(etag, /^"[0-9a-f]{32}"$/);

  const getsBefore = env.IMAGES.count('get');
  const cached = await call('GET', `/i/${json.key}`, { token: null, env, headers: { 'if-none-match': etag } });
  assert.equal(cached.res.status, 304);
  assert.equal(cached.bytes.length, 0);
  assert.equal(cached.res.headers.get('etag'), etag);
  assert.equal(env.IMAGES.count('get'), getsBefore, 'a 304 never reads the object body');
  assert.equal((await call('GET', `/i/${json.key}`, { token: null, env, headers: { 'if-none-match': `"other", W/${etag}` } })).res.status, 304, 'a list, and a weak validator');
  assert.equal((await call('GET', `/i/${json.key}`, { token: null, env, headers: { 'if-none-match': '"stale"' } })).res.status, 200);

  const head = await call('HEAD', `/i/${json.key}`, { token: null, env });
  assert.deepEqual([head.res.status, head.bytes.length, head.res.headers.get('content-length')], [200, 0, String(PNG.length)]);
  const options = await call('OPTIONS', `/i/${json.key}`, { token: null, env });
  assert.deepEqual([options.res.status, options.res.headers.get('access-control-allow-origin')], [204, '*']);
  const missing = await call('GET', `/i/o/${'b'.repeat(64)}.png`, { token: null, env });
  assert.deepEqual([missing.res.status, missing.json.code], [404, 'NOT_FOUND']);
  assert.equal((await call('GET', `/i/${json.key}`, { token: null, env: {} })).json.code, 'NOT_CONFIGURED');
});

test('/i/ answers 404 for every other key shape without asking R2', async () => {
  const env = envWith();
  const hex = 'c'.repeat(64);
  for (const key of ['o/abc.png', `x/${hex}.png`, `o/${hex}.svg`, `o/${hex.toUpperCase()}.png`, `o/${hex}.PNG`, `o/${hex}`, `o/${hex}.png.png`, `o/${'c'.repeat(63)}.png`, `o/sub/${hex}.png`, `%2e%2e/${hex}.png`, '', `o/${hex}.png%00`]) {
    const r = await call('GET', `/i/${key}`, { token: null, env });
    assert.equal(r.res.status, 404, key);
  }
  assert.equal(env.IMAGES.calls.length, 0, 'the bucket was never asked');
});

test('a thrown error inside a route answers INTERNAL as JSON, not an HTML 500 page', async () => {
  const exploding = { head: async () => { throw new Error('boom'); }, get: async () => { throw new Error('boom'); } };
  const r = await call('GET', `/i/o/${'d'.repeat(64)}.png`, { token: null, env: { IMAGES: exploding }, headers: { 'if-none-match': '"x"' } });
  assert.deepEqual([r.res.status, r.json.code, r.json.ok], [500, 'INTERNAL', false]);
  assert.equal(JSON.stringify(r.json).includes('boom'), false, 'the internal error is logged, not answered');
});

test('A13: a declared shop currency turns bare feed prices into prices; nothing is guessed', async () => {
  web(shopRoutes());
  const bare = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/' });
  assert.ok(bare.json.listings.every((l) => l.price === undefined), 'no currency: no price');
  const usd = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', currency: 'usd' });
  const priced = usd.json.listings.filter((l) => l.price);
  assert.ok(priced.length > 0, 'the declared currency makes prices');
  assert.ok(priced.every((l) => l.price.currency === 'USD' && l.price.amount > 0));
  const junk = await post('/v1/discover', { adapter: 'shopify', url: 'https://shop.example/', currency: 'dollars' });
  assert.ok(junk.json.listings.every((l) => l.price === undefined), 'a malformed currency is ignored, not guessed at');
});
