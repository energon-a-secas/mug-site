// politeFetch: identity, robots first and cached, redirects by hand with
// every hop re-checked, caps enforced while streaming, and every failure
// classified into a C3 code rather than thrown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_AGENT } from '../shared/contract.js';
import {
  FETCH_ERROR_CODES, ROBOTS_RETRY_MS, ROBOTS_TTL_MS, decodeText, detectChallenge, politeFetch, robotsCheck,
} from '../shared/net/polite.js';
import { fakeWeb, fixture, hang, streamOf } from './fixtures/fakes.mjs';

const ROBOTS = { body: 'User-agent: *\nDisallow: /cart\n\nUser-agent: MugBot\nDisallow: /private/\n' };
const PAGE = { body: '<html><body>A mug</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } };

function shop(extra = {}) {
  return fakeWeb({ 'https://shop.example/robots.txt': ROBOTS, 'https://shop.example/products/mug': PAGE, ...extra });
}

test('identifies as MugBot, reads robots.txt first, and answers the body', async () => {
  const web = shop();
  const r = await politeFetch('https://shop.example/products/mug', { fetchImpl: web, robotsCache: new Map() });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(new TextDecoder().decode(r.body), PAGE.body);
  assert.equal(r.bytes, PAGE.body.length);
  assert.deepEqual(web.urls(), ['https://shop.example/robots.txt', 'https://shop.example/products/mug']);
  for (const call of web.calls) {
    assert.equal(call.init.headers['user-agent'], USER_AGENT);
    assert.equal(call.init.redirect, 'manual', 'redirects are never left to the runtime');
  }
});

test('robots.txt is fetched once per host and cached for an hour', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const cache = new Map();
  const web = shop({ 'https://other.example/robots.txt': { status: 404 }, 'https://other.example/x': PAGE });
  const opts = { fetchImpl: web, robotsCache: cache, now };
  await politeFetch('https://shop.example/products/mug', opts);
  await politeFetch('https://shop.example/products/mug', opts);
  await politeFetch('https://other.example/x', opts);
  assert.equal(web.urls().filter((u) => u.endsWith('/robots.txt')).length, 2, 'one per host');
  assert.ok(cache.has('https://shop.example'));
  clock += ROBOTS_TTL_MS + 1;
  await politeFetch('https://shop.example/products/mug', opts);
  assert.equal(web.urls().filter((u) => u === 'https://shop.example/robots.txt').length, 2, 'fetched again after an hour');
});

test('concurrent requests to one host share one robots.txt fetch', async () => {
  const web = shop();
  const cache = new Map();
  await Promise.all([1, 2, 3].map(() => politeFetch('https://shop.example/products/mug', { fetchImpl: web, robotsCache: cache })));
  assert.equal(web.urls().filter((u) => u.endsWith('/robots.txt')).length, 1);
});

test('a disallowed path is ROBOTS_DISALLOWED and is never requested', async () => {
  const web = shop();
  const r = await politeFetch('https://shop.example/private/deal', { fetchImpl: web, robotsCache: new Map() });
  assert.equal(r.code, 'ROBOTS_DISALLOWED');
  assert.match(r.message, /Disallow: \/private\//);
  assert.deepEqual(web.urls(), ['https://shop.example/robots.txt']);
});

test('robots.txt outcomes: 404 allows, 503 and a timeout disallow for now (and are retried sooner)', async () => {
  const missing = fakeWeb({ 'https://a.example/robots.txt': { status: 404 }, 'https://a.example/p': PAGE });
  assert.equal((await politeFetch('https://a.example/p', { fetchImpl: missing })).ok, true);

  let clock = 0;
  const cache = new Map();
  const down = fakeWeb({ 'https://b.example/robots.txt': { status: 503 }, 'https://b.example/p': PAGE });
  const r = await politeFetch('https://b.example/p', { fetchImpl: down, robotsCache: cache, now: () => clock });
  assert.equal(r.code, 'ROBOTS_DISALLOWED');
  assert.equal(r.upstreamStatus, 503);
  assert.match(r.hint, /RFC 9309/);
  assert.equal(down.urls().includes('https://b.example/p'), false);
  clock += ROBOTS_RETRY_MS + 1;
  await politeFetch('https://b.example/p', { fetchImpl: down, robotsCache: cache, now: () => clock });
  assert.equal(down.urls().filter((u) => u.endsWith('robots.txt')).length, 2, 'a 5xx is remembered for less than an hour');

  const slow = fakeWeb({ 'https://c.example/robots.txt': hang, 'https://c.example/p': PAGE });
  const t = await politeFetch('https://c.example/p', { fetchImpl: slow, timeoutMs: 20 });
  assert.equal(t.code, 'ROBOTS_DISALLOWED');
  assert.match(t.message, /timed out/);
});

test('robots.txt redirects are followed, and a redirect into a private range counts as unreadable', async () => {
  const moved = fakeWeb({
    'http://a.example/robots.txt': { status: 301, headers: { location: 'https://a.example/robots.txt' } },
    'https://a.example/robots.txt': { body: 'User-agent: *\nDisallow: /no\n' },
  });
  const verdict = await robotsCheck('http://a.example/no', { fetchImpl: moved });
  assert.deepEqual([verdict.allowed, verdict.rule], [false, 'Disallow: /no']);

  const sneaky = fakeWeb({ 'https://b.example/robots.txt': { status: 302, headers: { location: 'http://10.0.0.1/robots.txt' } } });
  const v2 = await robotsCheck('https://b.example/x', { fetchImpl: sneaky });
  assert.equal(v2.allowed, false);
  assert.match(v2.rule, /refused address/);
  assert.equal(sneaky.urls().includes('http://10.0.0.1/robots.txt'), false);
});

test('redirects are followed by hand, at most five, each hop re-checked', async () => {
  const hops = {};
  for (let i = 0; i < 6; i++) hops[`https://shop.example/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } };
  const web = shop({ ...hops, 'https://shop.example/r6': PAGE, 'https://shop.example/r5x': PAGE });
  const tooMany = await politeFetch('https://shop.example/r0', { fetchImpl: web, robotsCache: new Map() });
  assert.equal(tooMany.code, 'UPSTREAM_ERROR');
  assert.match(tooMany.message, /more than 5/);

  const five = shop({ ...hops, 'https://shop.example/r1': { status: 301, headers: { location: 'https://shop.example/r5x' } }, 'https://shop.example/r5x': PAGE });
  const ok = await politeFetch('https://shop.example/r0', { fetchImpl: five, robotsCache: new Map() });
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'https://shop.example/r5x');
  assert.equal(ok.redirects, 2);

  const toPrivate = shop({ 'https://shop.example/go': { status: 302, headers: { location: 'http://192.168.1.1/admin' } } });
  const p = await politeFetch('https://shop.example/go', { fetchImpl: toPrivate, robotsCache: new Map() });
  assert.equal(p.code, 'URL_NOT_ALLOWED');
  assert.equal(toPrivate.urls().some((u) => u.includes('192.168')), false);

  const crossHost = shop({
    'https://shop.example/go': { status: 301, headers: { location: 'https://cdn.example/secret/page' } },
    'https://cdn.example/robots.txt': { body: 'User-agent: *\nDisallow: /secret/\n' },
  });
  const c = await politeFetch('https://shop.example/go', { fetchImpl: crossHost, robotsCache: new Map() });
  assert.equal(c.code, 'ROBOTS_DISALLOWED', 'the new host has its own robots.txt, read before the hop');
  assert.ok(crossHost.urls().includes('https://cdn.example/robots.txt'));
  assert.equal(crossHost.urls().includes('https://cdn.example/secret/page'), false);
});

test('the guard runs before anything is fetched', async () => {
  const web = fakeWeb({});
  const r = await politeFetch('http://127.0.0.1/products.json', { fetchImpl: web });
  assert.equal(r.code, 'URL_NOT_ALLOWED');
  assert.equal(web.calls.length, 0);
  const dev = fakeWeb({ 'http://127.0.0.1:8899/robots.txt': { status: 404 }, 'http://127.0.0.1:8899/p': PAGE });
  assert.equal((await politeFetch('http://127.0.0.1:8899/p', { fetchImpl: dev, env: { MUG_DEV_ALLOW_LOOPBACK: '1' } })).ok, true);
});

test('refusals and bot challenges are UPSTREAM_BLOCKED', async () => {
  for (const status of [401, 403, 503]) {
    const web = shop({ 'https://shop.example/products/mug': { status, body: 'no' } });
    const r = await politeFetch('https://shop.example/products/mug', { fetchImpl: web, robotsCache: new Map() });
    assert.equal(r.code, 'UPSTREAM_BLOCKED', `status ${status}`);
    assert.equal(r.upstreamStatus, status);
    assert.match(r.hint, /runner/);
  }
  const challenge = fixture('challenge.html');
  const cf = shop({ 'https://shop.example/products/mug': { status: 403, body: challenge, headers: { 'content-type': 'text/html', server: 'cloudflare' } } });
  const r1 = await politeFetch('https://shop.example/products/mug', { fetchImpl: cf, robotsCache: new Map() });
  assert.match(r1.message, /Cloudflare challenge/);

  const disguised = shop({ 'https://shop.example/products/mug': { status: 200, body: challenge, headers: { 'content-type': 'text/html' } } });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: disguised, robotsCache: new Map() })).code, 'UPSTREAM_BLOCKED', 'a 200 challenge page is still a block');

  const mitigated = shop({ 'https://shop.example/products/mug': { status: 200, body: '{}', headers: { 'cf-mitigated': 'challenge' } } });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: mitigated, robotsCache: new Map() })).code, 'UPSTREAM_BLOCKED');

  const px = shop({ 'https://shop.example/products/mug': { status: 403, body: '<div id="px-captcha"></div>', headers: { 'content-type': 'text/html' } } });
  assert.match((await politeFetch('https://shop.example/products/mug', { fetchImpl: px, robotsCache: new Map() })).message, /PerimeterX/);

  const akamai = shop({ 'https://shop.example/products/mug': { status: 403, body: '<html><title>Access Denied</title>Reference #18.abc</html>', headers: { server: 'AkamaiGHost' } } });
  assert.match((await politeFetch('https://shop.example/products/mug', { fetchImpl: akamai, robotsCache: new Map() })).message, /Akamai/);
});

test('A15: a plain 429 is an upstream error retried later, never sent to the runner; with a challenge it is a block', async () => {
  const plain = shop({ 'https://shop.example/products/mug': { status: 429, body: 'slow down' } });
  const r = await politeFetch('https://shop.example/products/mug', { fetchImpl: plain, robotsCache: new Map() });
  assert.equal(r.code, 'UPSTREAM_ERROR');
  assert.equal(r.upstreamStatus, 429);
  assert.match(r.message, /too many requests/);
  assert.equal(r.hint, undefined, 'no hint pointing at the runner');
  const challenged = shop({ 'https://shop.example/products/mug': { status: 429, body: 'x', headers: { 'cf-mitigated': 'challenge' } } });
  const c = await politeFetch('https://shop.example/products/mug', { fetchImpl: challenged, robotsCache: new Map() });
  assert.equal(c.code, 'UPSTREAM_BLOCKED');
  assert.match(c.message, /Cloudflare challenge/);
});

test('an ordinary page that mentions a vendor is not a block', async () => {
  const body = '<html><head><title>Pikachu 3D Mug</title><script src="https://js.datadome.co/tags.js"></script></head><body>Served via Cloudflare. window._pxAppId = "x";</body></html>';
  const web = shop({ 'https://shop.example/products/mug': { body, headers: { 'content-type': 'text/html' } } });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: web, robotsCache: new Map() })).ok, true);
  assert.equal(detectChallenge({ text: body, strict: true }), null);
});

test('other statuses, network failures and timeouts', async () => {
  const gone = shop({ 'https://shop.example/products/mug': { status: 404 } });
  const r404 = await politeFetch('https://shop.example/products/mug', { fetchImpl: gone, robotsCache: new Map() });
  assert.deepEqual([r404.code, r404.upstreamStatus], ['UPSTREAM_ERROR', 404]);
  const broken = shop({ 'https://shop.example/products/mug': { status: 500 } });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: broken, robotsCache: new Map() })).code, 'UPSTREAM_ERROR');

  const refused = shop({ 'https://shop.example/products/mug': () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  const net = await politeFetch('https://shop.example/products/mug', { fetchImpl: refused, robotsCache: new Map() });
  assert.equal(net.code, 'UPSTREAM_ERROR');
  assert.match(net.message, /could not be reached/);

  const slow = shop({ 'https://shop.example/products/mug': hang });
  const t = await politeFetch('https://shop.example/products/mug', { fetchImpl: slow, robotsCache: new Map(), timeoutMs: 25 });
  assert.equal(t.code, 'UPSTREAM_TIMEOUT');

  const slowBody = shop({ 'https://shop.example/products/mug': (url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([60]));
      init.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    },
  })) });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: slowBody, robotsCache: new Map(), timeoutMs: 25 })).code, 'UPSTREAM_TIMEOUT', 'the deadline covers the body too');

  const runtimeTimeout = shop({ 'https://shop.example/products/mug': () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: runtimeTimeout, robotsCache: new Map() })).code, 'UPSTREAM_TIMEOUT');

  const dnsRefusal = shop({ 'https://shop.example/products/mug': () => { throw Object.assign(new Error('shop.example resolves to 10.0.0.5'), { mugCode: 'URL_NOT_ALLOWED' }); } });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: dnsRefusal, robotsCache: new Map() })).code, 'URL_NOT_ALLOWED');

  const refusedFirst = fakeWeb({ 'https://rebind.example/robots.txt': () => { throw Object.assign(new Error('rebind.example resolves to 10.0.0.1'), { mugCode: 'URL_NOT_ALLOWED' }); } });
  const cache = new Map();
  const early = await politeFetch('https://rebind.example/p', { fetchImpl: refusedFirst, robotsCache: cache });
  assert.equal(early.code, 'URL_NOT_ALLOWED', 'refused while reading robots.txt is still the guard speaking, not an unreadable robots.txt');
  assert.equal(cache.has('https://rebind.example'), false, 'and it is not cached as a robots verdict');
});

test('caps: a declared length over the cap, and a streamed body that grows past it', async () => {
  const declared = shop({ 'https://shop.example/products/mug': () => new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }) });
  const r1 = await politeFetch('https://shop.example/products/mug', { fetchImpl: declared, robotsCache: new Map() });
  assert.equal(r1.code, 'TOO_LARGE', '5 MB is the page cap');

  const endless = shop({ 'https://shop.example/products/mug': () => new Response(streamOf(6 * 1024 * 1024)) });
  const r2 = await politeFetch('https://shop.example/products/mug', { fetchImpl: endless, robotsCache: new Map() });
  assert.equal(r2.code, 'TOO_LARGE');

  const image = shop({ 'https://shop.example/img.png': () => new Response(streamOf(6 * 1024 * 1024)) });
  const r3 = await politeFetch('https://shop.example/img.png', { fetchImpl: image, robotsCache: new Map(), kind: 'image' });
  assert.equal(r3.ok, true, '15 MB is the image cap');
  assert.equal(r3.bytes, 6 * 1024 * 1024);

  const small = shop({ 'https://shop.example/products/mug': () => new Response(streamOf(2048)) });
  assert.equal((await politeFetch('https://shop.example/products/mug', { fetchImpl: small, robotsCache: new Map(), maxBytes: 1000 })).code, 'TOO_LARGE');
});

test('a subrequest budget stops a call from fanning out', async () => {
  const web = shop();
  const budget = { left: 1 };
  const r = await politeFetch('https://shop.example/products/mug', { fetchImpl: web, robotsCache: new Map(), budget });
  assert.equal(r.code, 'UPSTREAM_ERROR');
  assert.match(r.message, /budget/);
  assert.deepEqual(web.urls(), ['https://shop.example/robots.txt']);
});

test('every code politeFetch answers is a C3 code, and text decoding honours the charset', () => {
  assert.deepEqual([...FETCH_ERROR_CODES].sort(), ['ROBOTS_DISALLOWED', 'TOO_LARGE', 'UPSTREAM_BLOCKED', 'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT', 'URL_NOT_ALLOWED']);
  const latin = new Uint8Array([0x54, 0x61, 0x73, 0x73, 0x65, 0x20, 0x74, 0x68, 0xe9, 0x69, 0xe8, 0x72, 0x65]);
  assert.equal(decodeText(latin, 'text/html; charset=ISO-8859-1'), `Tasse th${String.fromCharCode(0xe9)}i${String.fromCharCode(0xe8)}re`);
  const meta = new TextEncoder().encode('<meta charset="utf-8"><p>ok</p>');
  assert.equal(decodeText(meta, ''), '<meta charset="utf-8"><p>ok</p>');
  assert.equal(decodeText(new TextEncoder().encode('fine'), 'text/plain; charset=x-no-such-charset'), 'fine');
});
