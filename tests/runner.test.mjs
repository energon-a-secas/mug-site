// The local runner (C8) against a stubbed Convex and synthetic shops: config,
// drain (pages, images, --dry, pacing), scan (Shopify chunks, jsonld pages,
// failures), the DNS-guarded fetch over a real loopback socket, and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  PACE_MS, convexClient, drain, guardedLookup, loadConfig, main, nodeFetch, paced, parseEnvFile, scan,
} from '../runner/mug-runner.mjs';
import { politeFetch } from '../shared/net/polite.js';
import { USER_AGENT } from '../shared/contract.js';
import { fakeWeb, fixture } from './fixtures/fakes.mjs';

const RUNNER = fileURLToPath(new URL('../runner/mug-runner.mjs', import.meta.url));
const TOKEN = `mugr_${'Ab3dEf6h'.repeat(4)}`;
const SITE = 'https://happy-otter-123.convex.site';
const UPLOAD = 'https://happy-otter-123.convex.cloud/api/storage/upload?token=fixture';
const PNG = fixture('shop/img/pikachu.png', { binary: true });
const ROBOTS = { body: 'User-agent: *\nDisallow: /cart\n\nUser-agent: MugBot\nDisallow: /private/\nAllow: /\n' };

/** A Convex deployment's /runner/ routes, recording every call. */
function fakeConvex({ queue = [], scanAnswer, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ method, path: `${u.pathname}${u.search}`, host: u.host, body, headers: init.headers || {} });
    const json = (data, code = 200) => new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } });
    if (u.href === UPLOAD) return json({ storageId: `kg2storage${calls.length}` });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return json({ ok: false, code: 'unauthorized', message: 'no' }, 401);
    if (status !== 200) return json({ ok: false, code: 'unauthorized', message: 'refused' }, status);
    if (u.pathname === '/runner/queue') return json({ ok: true, items: queue.slice(0, Number(u.searchParams.get('limit'))) });
    if (u.pathname === '/runner/ingest') {
      // As convex/runner.ts does today: only staging ids, so an image id ("<mugId>:<index>") is refused.
      if (String(body.id).includes(':')) return json({ ok: false, code: 'bad-id', message: 'That is not a queue item id.' });
      return json({ ok: true, status: body.listing ? 'pending' : 'failed', ...(body.listing ? { match: { kind: 'new' } } : {}) });
    }
    if (u.pathname === '/runner/upload-url') return json({ ok: true, uploadUrl: UPLOAD });
    if (u.pathname === '/runner/image') return json({ ok: true });
    if (u.pathname === '/runner/scan') return json(scanAnswer);
    if (u.pathname === '/runner/stage') return json({ ok: true, staged: body.listings.length, unchanged: 0, skipped: 0 });
    if (u.pathname === '/runner/finish') return json({ ok: true });
    return json({ ok: false, code: 'not-found', message: u.pathname }, 404);
  };
  fn.calls = calls;
  fn.posts = (path) => calls.filter((c) => c.method === 'POST' && c.path === path);
  return fn;
}

/** A clock the paced wrapper sleeps on, so pacing is measured without waiting. */
function fakeTime() {
  let now = 0;
  const sleeps = [];
  return { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, sleeps, tick: (ms) => { now += ms; } };
}

function deps({ convex, upstream, time = fakeTime(), env = {} }) {
  const lines = [];
  const starts = [];
  const shop = fakeWeb(upstream);
  const timed = async (url, init) => {
    starts.push({ host: new URL(url).host, at: time.now() });
    return shop(url, init);
  };
  return {
    lines,
    starts,
    shop,
    time,
    d: {
      convex: convexClient({ site: SITE, token: TOKEN, fetchImpl: convex }),
      convexFetch: convex,
      upstream: paced(timed, { sleep: time.sleep, now: time.now }),
      robotsCache: new Map(),
      env,
      log: (s) => lines.push(String(s)),
    },
  };
}

const shopRoutes = (extra = {}) => ({
  'https://shop.example/robots.txt': ROBOTS,
  'https://shop.example/products/pikachu-3d-mug.json': { body: fixture('shop/products/pikachu-3d-mug.json') },
  'https://shop.example/blog/best-mugs': { body: fixture('opengraph-article.html'), headers: { 'content-type': 'text/html' } },
  'https://shop.example/img/pikachu.png': { body: PNG },
  'https://shop.example/img/not-an-image.png': { body: '<html>nope</html>' },
  ...extra,
});

// ── Configuration ────────────────────────────────────────────────────────────

test('config: KEY=VALUE files, the environment winning, and messages that never carry the token', () => {
  assert.deepEqual(parseEnvFile('# comment\n\nexport MUG_CONVEX_SITE="https://a.convex.site"\nMUG_RUNNER_TOKEN = \'mugr_x\'\nnot a line\n'), { MUG_CONVEX_SITE: 'https://a.convex.site', MUG_RUNNER_TOKEN: 'mugr_x' });
  const fromFile = loadConfig({ env: {}, readFile: () => `MUG_CONVEX_SITE=${SITE}/\nMUG_RUNNER_TOKEN=${TOKEN}\n` });
  assert.deepEqual(fromFile, { ok: true, config: { site: SITE, token: TOKEN, env: { MUG_DEV_ALLOW_LOOPBACK: undefined } } });
  const envWins = loadConfig({ env: { MUG_CONVEX_SITE: 'http://127.0.0.1:3211' }, readFile: () => `MUG_CONVEX_SITE=${SITE}\nMUG_RUNNER_TOKEN=${TOKEN}` });
  assert.equal(envWins.config.site, 'http://127.0.0.1:3211');
  const secretish = 'mugr_TOO_SHORT_BUT_SECRET_9f8e7d';
  const bad = loadConfig({ env: { MUG_CONVEX_SITE: 'https://evil.example', MUG_RUNNER_TOKEN: secretish }, readFile: () => { throw new Error('no file'); } });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.errors.join(' ').includes(secretish), false);
  const none = loadConfig({ env: {}, readFile: () => { throw new Error('no file'); } });
  assert.deepEqual(none.errors, ['MUG_CONVEX_SITE is not set.', 'MUG_RUNNER_TOKEN is not set.']);
  assert.equal(loadConfig({ env: { MUG_CONVEX_SITE: 'http://10.0.0.5:3211', MUG_RUNNER_TOKEN: TOKEN }, readFile: () => '' }).ok, false, 'plain http only to this machine');
});

// ── drain ────────────────────────────────────────────────────────────────────

test('drain: pages are extracted and ingested, images uploaded and attached, failures reported', async () => {
  const convex = fakeConvex({
    queue: [
      { id: 'q1', kind: 'page', url: 'https://shop.example/products/pikachu-3d-mug' },
      { id: 'q2', kind: 'page', url: 'https://shop.example/private/secret-sale' },
      { id: 'q3', kind: 'page', url: 'https://shop.example/blog/best-mugs' },
      { id: 'mug1:0', kind: 'image', url: 'https://shop.example/img/pikachu.png', mugId: 'mug1', index: 0 },
      { id: 'mug1:1', kind: 'image', url: 'https://shop.example/img/not-an-image.png', mugId: 'mug1', index: 1 },
      { id: 'q6', kind: 'page', url: 'http://192.168.1.1/admin' },
    ],
  });
  const { d, starts, lines } = deps({ convex, upstream: shopRoutes() });
  const summary = await drain({ limit: 10 }, d);
  assert.deepEqual(summary.pages, { ok: 1, failed: 3 });
  assert.deepEqual(summary.images, { ok: 1, failed: 1 });
  assert.deepEqual(summary.codes, { ROBOTS_DISALLOWED: 1, NOT_A_PRODUCT: 1, NOT_AN_IMAGE: 1, URL_NOT_ALLOWED: 1 });

  const ingests = convex.posts('/runner/ingest');
  const byId = Object.fromEntries(ingests.map((c) => [c.body.id, c.body]));
  assert.equal(byId.q1.listing.source.via, 'runner');
  assert.equal(byId.q1.listing.source.platform, 'shopify');
  assert.equal(byId.q2.error.code, 'ROBOTS_DISALLOWED', 'reported, never worked around');
  assert.equal(byId.q3.error.code, 'NOT_A_PRODUCT');
  assert.equal(byId['mug1:1'].error.code, 'NOT_AN_IMAGE', 'an image failure is reported with its queue id');
  assert.match(lines.join('\n'), /Convex did not record the failure \(bad-id/, 'and a refusal of that report is said, not hidden');
  assert.equal(byId.q6.error.code, 'URL_NOT_ALLOWED');
  assert.equal(byId['mug1:0'], undefined, 'a stored image is attached with /runner/image, not ingested');

  const upload = convex.calls.find((c) => c.path.startsWith('/api/storage/upload'));
  assert.equal(upload.headers['content-type'], 'image/png');
  assert.equal(upload.body.length, PNG.length);
  const attach = convex.posts('/runner/image');
  assert.deepEqual(attach.map((c) => c.body), [{ mugId: 'mug1', index: 0, url: 'https://shop.example/img/pikachu.png', storageId: attach[0].body.storageId }], 'A9: the URL names the image');
  assert.match(attach[0].body.storageId, /^kg2storage/);

  const shopStarts = starts.filter((s) => s.host === 'shop.example').map((s) => s.at);
  for (let i = 1; i < shopStarts.length; i++) assert.ok(shopStarts[i] - shopStarts[i - 1] >= PACE_MS, `request ${i} came ${shopStarts[i] - shopStarts[i - 1]} ms after the last`);
  assert.equal(starts.some((s) => s.host.startsWith('192.168')), false);
  assert.equal(lines.join('\n').includes(TOKEN), false);
});

test('drain --dry reads everything and posts nothing', async () => {
  const convex = fakeConvex({ queue: [{ id: 'q1', kind: 'page', url: 'https://shop.example/products/pikachu-3d-mug' }, { id: 'q2', kind: 'image', url: 'https://shop.example/img/pikachu.png', mugId: 'm', index: 0 }, { id: 'q3', kind: 'page', url: 'https://shop.example/private/x' }] });
  const { d, lines, shop } = deps({ convex, upstream: shopRoutes() });
  const summary = await drain({ limit: 5, dry: true }, d);
  assert.deepEqual([summary.pages, summary.images], [{ ok: 1, failed: 1 }, { ok: 1, failed: 0 }]);
  assert.deepEqual(convex.calls.map((c) => `${c.method} ${c.path}`), ['GET /runner/queue?limit=5']);
  assert.ok(shop.urls().includes('https://shop.example/img/pikachu.png'), 'the image is still fetched and sniffed');
  assert.match(lines.join('\n'), /read: Pikachu 3D Mug/);
  assert.match(lines.join('\n'), /read: 121 bytes, png, 6x4/);
});

// ── scan ─────────────────────────────────────────────────────────────────────

function feedOf(n, from = 0) {
  return JSON.stringify({ products: Array.from({ length: n }, (_, i) => ({ title: `Fixture Mug ${from + i}`, handle: `fixture-mug-${from + i}`, vendor: 'Star Wars', product_type: 'Mugs', variants: [{ price: '10.00', available: true }] })) });
}

test('scan shopify: discovered as the Worker would, staged in chunks of at most 50, then finished', async () => {
  const convex = fakeConvex({ scanAnswer: { ok: true, runId: 'run1', source: { slug: 'fixture', adapter: 'shopify', baseUrl: 'https://shop.example', entryUrls: [], include: [], exclude: [], brand: 'Bioworld', fetchVia: 'local' } } });
  const { d } = deps({ convex, upstream: shopRoutes({
    'https://shop.example/products.json?limit=50&page=1': { body: feedOf(50) },
    'https://shop.example/products.json?limit=50&page=2': { body: feedOf(30, 50) },
  }) });
  const summary = await scan('fixture', {}, d);
  assert.equal(summary.pages, 2);
  assert.equal(summary.listings, 80);
  assert.deepEqual(convex.posts('/runner/stage').map((c) => c.body.listings.length), [50, 30]);
  const first = convex.posts('/runner/stage')[0].body.listings[0];
  assert.equal(first.brand, 'Bioworld', 'the source brand from /runner/scan (A6)');
  assert.match(first.vendor, /star wars/i, 'A8: the licence is the vendor, not a tag');
  assert.equal(first.source.via, 'runner');
  assert.deepEqual(convex.posts('/runner/finish').map((c) => c.body), [{ runId: 'run1' }]);
  assert.deepEqual(convex.posts('/runner/scan').map((c) => c.body), [{ sourceSlug: 'fixture' }]);
});

test('scan jsonld: sitemap URLs extracted one by one; a failing page is counted, not fatal', async () => {
  const sitemap = '<urlset><url><loc>https://brand.example/product/luna-teapot</loc></url><url><loc>https://brand.example/product/gone</loc></url><url><loc>https://brand.example/product/stein</loc></url></urlset>';
  const convex = fakeConvex({ scanAnswer: { ok: true, runId: 'run2', source: { slug: 'brand', adapter: 'jsonld', baseUrl: 'https://brand.example', entryUrls: ['https://brand.example/sitemap-products.xml.gz'], include: [], exclude: [], brand: null } } });
  const { d } = deps({ convex, upstream: {
    'https://brand.example/robots.txt': { status: 404 },
    'https://brand.example/sitemap-products.xml.gz': { body: new Uint8Array(gzipSync(sitemap)) },
    'https://brand.example/product/luna-teapot': { body: fixture('shop/product/luna-teapot.html'), headers: { 'content-type': 'text/html' } },
    'https://brand.example/product/stein': { body: fixture('jsonld-group.html'), headers: { 'content-type': 'text/html' } },
  } });
  const summary = await scan('brand', {}, d);
  assert.deepEqual([summary.urls, summary.extracted, summary.failed], [3, 2, 1]);
  assert.deepEqual(summary.codes, { UPSTREAM_ERROR: 1 });
  const staged = convex.posts('/runner/stage').flatMap((c) => c.body.listings);
  assert.deepEqual(staged.map((l) => l.name), ['Sailor Moon Luna Teapot', 'Dragon Relief Stein']);
  assert.deepEqual(convex.posts('/runner/finish').map((c) => c.body), [{ runId: 'run2' }]);
});

/** A robots cache whose chosen lookup throws: a stand-in for any bug a hostile page reaches. */
class ThrowingCache extends Map {
  constructor(shouldThrow) {
    super();
    this.calls = 0;
    this.shouldThrow = shouldThrow;
  }

  get(key) {
    this.calls++;
    if (this.shouldThrow(String(key), this.calls)) throw new TypeError('boom from a hostile page');
    return super.get(key);
  }
}

test('drain: an item that throws is reported INTERNAL and the drain goes on to the next', async () => {
  const convex = fakeConvex({ queue: [
    { id: 'q1', kind: 'page', url: 'https://hostile.example/products/x' },
    { id: 'q2', kind: 'page', url: 'https://shop.example/products/pikachu-3d-mug' },
  ] });
  const { d } = deps({ convex, upstream: shopRoutes() });
  d.robotsCache = new ThrowingCache((key) => key.includes('hostile'));
  const summary = await drain({}, d);
  assert.deepEqual([summary.pages.ok, summary.pages.failed], [1, 1]);
  assert.deepEqual(summary.codes, { INTERNAL: 1 });
  const [first, second] = convex.posts('/runner/ingest').map((c) => c.body);
  assert.deepEqual([first.id, first.error.code], ['q1', 'INTERNAL']);
  assert.match(first.error.message, /boom/);
  assert.equal(second.id, 'q2');
  assert.equal(second.listing.name, 'Pikachu 3D Mug', 'the item after the hostile one is still read');
});

test('scan: a URL that throws is counted, the scan reads the rest and stages everything it read', async () => {
  const sitemap = '<urlset><url><loc>https://brand.example/product/luna-teapot</loc></url><url><loc>https://brand.example/product/hostile</loc></url><url><loc>https://brand.example/product/stein</loc></url></urlset>';
  const convex = fakeConvex({ scanAnswer: { ok: true, runId: 'run9', source: { slug: 'brand', adapter: 'jsonld', baseUrl: 'https://brand.example', entryUrls: ['https://brand.example/sitemap.xml'], include: [], exclude: [], brand: null } } });
  const { d } = deps({ convex, upstream: {
    'https://brand.example/robots.txt': { status: 404 },
    'https://brand.example/sitemap.xml': { body: sitemap },
    'https://brand.example/product/luna-teapot': { body: fixture('shop/product/luna-teapot.html'), headers: { 'content-type': 'text/html' } },
    'https://brand.example/product/stein': { body: fixture('jsonld-group.html'), headers: { 'content-type': 'text/html' } },
  } });
  // Lookups: the sitemap, then one per product page; the third is the hostile page.
  d.robotsCache = new ThrowingCache((key, call) => call === 3);
  const summary = await scan('brand', {}, d);
  assert.deepEqual([summary.urls, summary.extracted, summary.failed], [3, 2, 1]);
  assert.deepEqual(summary.codes, { INTERNAL: 1 });
  const staged = convex.posts('/runner/stage').flatMap((c) => c.body.listings);
  assert.deepEqual(staged.map((l) => l.name), ['Sailor Moon Luna Teapot', 'Dragon Relief Stein']);
  assert.deepEqual(convex.posts('/runner/finish').map((c) => c.body), [{ runId: 'run9' }]);
});

test('scan: a refused entry, a manual source and the page cap end the run with an error or a stop', async () => {
  const refused = fakeConvex({ scanAnswer: { ok: true, runId: 'run3', source: { slug: 's', adapter: 'shopify', baseUrl: 'https://shop.example', entryUrls: ['https://shop.example/private/collection'], include: [], exclude: [] } } });
  const a = deps({ convex: refused, upstream: shopRoutes() });
  const s1 = await scan('s', {}, a.d);
  assert.match(s1.error, /^ROBOTS_DISALLOWED on https:\/\/shop\.example\/private\/collection/);
  assert.deepEqual(refused.posts('/runner/finish')[0].body.runId, 'run3');
  assert.match(refused.posts('/runner/finish')[0].body.error, /ROBOTS_DISALLOWED/);

  const manual = fakeConvex({ scanAnswer: { ok: true, runId: 'run4', source: { slug: 'm', adapter: 'manual', baseUrl: 'https://shop.example', entryUrls: [] } } });
  const s2 = await scan('m', {}, deps({ convex: manual, upstream: {} }).d);
  assert.match(s2.error, /manual source/);
  assert.equal(manual.posts('/runner/finish').length, 1);

  const endless = fakeConvex({ scanAnswer: { ok: true, runId: 'run5', source: { slug: 'e', adapter: 'shopify', baseUrl: 'https://shop.example', entryUrls: [], include: [], exclude: [] } } });
  const routes = shopRoutes();
  for (let p = 1; p <= 5; p++) routes[`https://shop.example/products.json?limit=50&page=${p}`] = { body: feedOf(50, p * 100) };
  const s3 = await scan('e', { maxPages: 2 }, deps({ convex: endless, upstream: routes }).d);
  assert.deepEqual([s3.pages, s3.listings, s3.error], [2, 100, undefined]);

  const notStarted = fakeConvex({ scanAnswer: { ok: false, code: 'not-found', message: 'No source with that slug.' } });
  await assert.rejects(scan('nope', {}, deps({ convex: notStarted, upstream: {} }).d), /No source with that slug/);
});

// ── The runner's own fetch ───────────────────────────────────────────────────

function resolver(table) {
  return (hostname, options, callback) => {
    const addresses = table[hostname];
    if (!addresses) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    return callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
}

test('the guarded lookup refuses a public name that points into a private network', async () => {
  const lookup = guardedLookup({}, resolver({ 'shop.example': ['93.184.215.14'], 'rebind.example': ['10.0.0.1'], 'mixed.example': ['8.8.8.8', '127.0.0.1'] }));
  const ask = (host, opts = {}) => new Promise((resolve) => lookup(host, opts, (err, address, family) => resolve({ err, address, family })));
  const ok = await ask('shop.example');
  assert.deepEqual([ok.err, ok.address, ok.family], [null, '93.184.215.14', 4]);
  const all = await ask('shop.example', { all: true });
  assert.deepEqual(all.address, [{ address: '93.184.215.14', family: 4 }]);
  const rebind = await ask('rebind.example');
  assert.equal(rebind.err.mugCode, 'URL_NOT_ALLOWED');
  assert.match(rebind.err.message, /10\.0\.0\.1/);
  assert.equal((await ask('mixed.example')).err.mugCode, 'URL_NOT_ALLOWED', 'one bad address refuses the name');
  const dev = guardedLookup({ MUG_DEV_ALLOW_LOOPBACK: '1' }, resolver({ localhost: ['127.0.0.1'], 'shop.example': ['127.0.0.1'] }));
  const devAsk = (host) => new Promise((resolve) => dev(host, {}, (err, address) => resolve({ err, address })));
  assert.equal((await devAsk('localhost')).address, '127.0.0.1');
  assert.equal((await devAsk('shop.example')).err.mugCode, 'URL_NOT_ALLOWED', 'the switch never covers a public name');
});

test('nodeFetch over a real loopback socket: headers, gzip, redirects left alone, and the lookup guard', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'], host: req.headers.host });
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private/\n');
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      return res.end(gzipSync('inflated text'));
    }
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/products.json' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(fixture('shop/products.json'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const dev = { MUG_DEV_ALLOW_LOOPBACK: '1' };
    const fetchImpl = nodeFetch({ env: dev, lookup: guardedLookup(dev, resolver({ localhost: ['127.0.0.1'], 'rebind.example': ['127.0.0.1'] })) });
    const gz = await fetchImpl(`http://localhost:${port}/gz`, { headers: { 'user-agent': USER_AGENT } });
    assert.deepEqual([gz.status, await gz.text(), gz.headers.get('content-encoding')], [200, 'inflated text', null]);
    const moved = await fetchImpl(`http://localhost:${port}/moved`, {});
    assert.deepEqual([moved.status, moved.headers.get('location')], [302, '/products.json'], 'redirects are politeFetch\'s to follow');

    const r = await politeFetch(`http://localhost:${port}/moved`, { fetchImpl, env: dev, kind: 'json', robotsCache: new Map() });
    assert.equal(r.ok, true, r.message);
    assert.equal(JSON.parse(new TextDecoder().decode(r.body)).products.length, 5);
    assert.deepEqual(seen.map((s) => s.url), ['/gz', '/moved', '/robots.txt', '/moved', '/products.json']);
    assert.ok(seen.slice(2).every((s) => s.ua === USER_AGENT));

    const refused = await politeFetch(`http://localhost:${port}/private/x`, { fetchImpl, env: dev, robotsCache: new Map() });
    assert.equal(refused.code, 'ROBOTS_DISALLOWED');

    const before = seen.length;
    const rebinding = await politeFetch(`http://rebind.example/products.json`, { fetchImpl, env: {}, robotsCache: new Map() });
    assert.equal(rebinding.code, 'URL_NOT_ALLOWED', 'refused at connect time, before any byte is sent');
    assert.equal(seen.length, before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── The CLI ──────────────────────────────────────────────────────────────────

test('main: exit codes, no token in any output, and a summary line', async () => {
  const run = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env: { MUG_CONVEX_SITE: SITE, MUG_RUNNER_TOKEN: TOKEN }, envFile: '/nonexistent/mug-runner.env', out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const convex = fakeConvex({ queue: [{ id: 'q1', kind: 'page', url: 'https://shop.example/products/pikachu-3d-mug' }] });
  const shop = fakeWeb(shopRoutes());
  const ok = await run(['drain', '--limit', '3'], { convexFetch: convex, upstream: shop });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /done: 1 item\(s\); pages 1 ok, 0 failed/);
  assert.equal(`${ok.out}${ok.err}`.includes(TOKEN), false);
  assert.deepEqual(convex.calls[0].path, '/runner/queue?limit=3');

  const refused = await run(['drain'], { convexFetch: fakeConvex({ status: 401 }), upstream: shop });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /refused the runner token/);

  const down = await run(['drain'], { convexFetch: async () => { throw new Error(`connect ECONNREFUSED (token ${TOKEN})`); }, upstream: shop });
  assert.equal(down.code, 1);
  assert.equal(down.err.includes(TOKEN), false, 'redacted even when an error message would echo it');
  assert.match(down.err, /mugr_\[redacted\]/);

  const unconfigured = await main(['drain'], { env: {}, envFile: '/nonexistent/mug-runner.env', out: () => {}, err: () => {} });
  assert.equal(unconfigured, 2);
  assert.equal((await run(['scan'])).code, 2, 'scan needs a slug');
  assert.equal((await run(['drain', '--limit', 'lots'])).code, 2);
  assert.equal((await run(['drain', '--pretend-to-be-a-browser'])).code, 2, 'there is no such option');
});

test('the CLI as a process: help, a bad command, and bad configuration exit non-zero without the token', () => {
  const help = execFileSync(process.execPath, [RUNNER, 'help'], { encoding: 'utf8' });
  assert.match(help, /drain \[--limit N\] \[--dry\]/);
  const bogus = spawnSync(process.execPath, [RUNNER, 'bogus'], { encoding: 'utf8' });
  assert.equal(bogus.status, 2);
  const secret = 'mugr_not-a-valid-token-but-secret';
  const bad = spawnSync(process.execPath, [RUNNER, 'drain'], { encoding: 'utf8', env: { PATH: process.env.PATH, MUG_CONVEX_SITE: 'https://evil.example', MUG_RUNNER_TOKEN: secret } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /MUG_CONVEX_SITE has to be/);
  assert.equal(`${bad.stdout}${bad.stderr}`.includes(secret), false);
});
