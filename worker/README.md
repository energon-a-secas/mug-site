# mug-proxy

Mug's Cloudflare Worker. It reads shop pages and images for Convex, politely,
and keeps images in R2. It holds no catalogue state and answers nobody but
Convex, apart from two public reads: `GET /health` and `GET /i/<key>`.

The contract is [`docs/CONTRACTS.md`](../docs/CONTRACTS.md): C3 (routes and
errors), C4 (images), C10 (politeness), A1 and A6. This file is how to run it.

## Routes

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /health` | public | none | `{ ok, version, r2, token, devLoopback }`, booleans only |
| `GET /i/<key>` | public | none | the image; `Cache-Control: public, max-age=31536000, immutable`, `ETag`, `304` on `If-None-Match`, `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin` |
| `POST /v1/probe` | bearer | `{ url }` | `{ ok, robots: { allowed, rule }, platform, status }` |
| `POST /v1/discover` | bearer | `{ adapter, url, page?, include?, exclude?, brand? }` | `{ ok, listings? \| urls?, skipped, next, fetched }` |
| `POST /v1/extract` | bearer | `{ url, brand? }` | `{ ok, listing, fetched }` |
| `POST /v1/images/mirror` | bearer | `{ url }` | `{ ok, key, bytes, contentType, w?, h? }` |
| `PUT /v1/images/put?kind=thumb\|photo\|original` | bearer | raw bytes | same as mirror |
| `DELETE /v1/images/<key>` | bearer | none | `{ ok, deleted }` |

Every failure is `{ ok: false, code, message, hint?, upstreamStatus? }` on the
status C3 gives its code; the thirteen codes are exported as `ERROR_CODES` from
`src/index.js`, and Convex's tests hold `convex/lib/proxy.ts` to the same list.
A bug answers `INTERNAL` as JSON, never the runtime's HTML page.

What each route does, in the order it happens:

- **Every fetch** goes through `shared/net/polite.js`: the SSRF guard, then
  robots.txt (fetched once per host, cached for an hour per isolate), then the
  request as `MugBot/1.0 (+https://mug.neorgon.com/bot/)` with redirects
  followed by hand (at most five, each hop checked again), a 15 s deadline and
  the C10.4 caps enforced while streaming. A 401, 403, 429, 503 or a bot
  challenge page is `UPSTREAM_BLOCKED`, which Convex sends to the runner.
- **probe** answers the robots verdict for the URL's own path, then asks
  `/products.json?limit=1` (Shopify) and `/wp-json/wc/store/v1/products?per_page=1`
  (WooCommerce). `status` is the HTTP status of the last of those answers. A
  shop that refuses both questions is answered as `UPSTREAM_BLOCKED`.
- **discover** reads one shop page per call.
  - `shopify`: `<url>/products.json?limit=50&page=N` (a collection URL gets
    its own feed); `next` is `{ page: N+1 }` when the page held 50 products.
  - `woocommerce`: the Store API at the origin, with `&search=<include[0]>`;
    `next` follows `X-WP-TotalPages`, else a full page of 50.
  - `jsonld`: a sitemap `urlset` is paged 200 entries at a time. An HTML
    listing answers its product links and `next: { page, url }` from
    `rel="next"` (A1).
  - A **sitemap index** is walked here, one level, because Convex stages every
    returned URL as a product page. A call fetches the index and one child
    sitemap (three subrequests with robots.txt) and answers up to 200 of that
    child's URLs; `next.url` is the index URL again with the position in its
    fragment, `#mug-child=1&mug-offset=200`. The fragment is never sent to the
    shop; Convex passes `next.url` back unchanged. A child that robots.txt
    refuses, that is missing, or that is itself an index is skipped and counted
    in `skipped`. Gzipped sitemaps are inflated.
  - Listings with `isMug.verdict === "no"`, and those the source's include and
    exclude words drop, are counted in `skipped`, not returned.
  - `brand` (A6) is the source's own brand: it becomes the listing's brand, and
    the shop's vendor is kept as a tag (and offered as the franchise when it
    names one).
- **extract** tries `<url>.json` first for a Shopify-style `/products/<handle>`
  path, then reads the HTML: JSON-LD first, OpenGraph filling gaps. Any JSON
  miss falls back to the HTML, a refusal included (a shop may guard its `.json`
  endpoints and still serve pages), except a timeout: a second 15 s wait would
  outlast the 30 s Convex gives the whole call. No product data is
  `NOT_A_PRODUCT`.
- **mirror** and **put** sniff the bytes (jpg, png, gif, webp, avif; never the
  URL's extension or the Content-Type), hash them with SHA-256, and store
  `o/`, `t/` or `p/` + hex + extension. An existing key is not written again.
  A mirrored object keeps its source URL in `customMetadata.source`.
  Thumbnails are stored with the extension their bytes have: a browser that
  cannot encode WebP (older Safari) sends PNG, and the key says `.png`.
- **`/i/<key>`** only asks R2 for a key matching
  `^[otp]/[0-9a-f]{64}\.(jpg|png|gif|webp|avif)$`; anything else is a 404
  before the bucket is touched.

### Limits

One shop page per call, and at most 12 fetches per invocation
(`src/runtime.js`); a normal call makes two to four. Measured in Node, reading a
50-product Shopify page costs about 2 ms of CPU warm and about 8 ms on a cold
first call for the extraction itself (Node's own web streams add more, which
workerd implements natively), so a cold isolate can come close to the free
plan's 10 ms. A call the runtime cuts off reaches Convex as a non-JSON answer,
which `convex/lib/proxy.ts` turns into `INTERNAL`, retried once.

`src/index.js` exports only its handler and `ERROR_CODES`: workerd reads every
named export of the main module as an entrypoint and refuses to start on a
number or a string. Anything else lives in `src/runtime.js`.

## Secrets and bindings

| Name | Kind | Set with |
|---|---|---|
| `MUG_PROXY_TOKEN` | secret, the same value as Convex's | `npx wrangler secret put MUG_PROXY_TOKEN` |
| `IMAGES` | R2 binding to `mug-images` (preview `mug-images-dev`) | `wrangler.toml` |
| `MUG_DEV_ALLOW_LOOPBACK` | local development only | `worker/.dev.vars` |

Without `MUG_PROXY_TOKEN` every POST, PUT and DELETE answers `501
NOT_CONFIGURED`; without `IMAGES` the image routes do. Neither is ever read out:
`/health` reports only whether they are present.

## Local development

This folder is not an npm workspace member of the monorepo, so `npm install`
here is local (`npm prefix` prints this folder).

```bash
cd worker
npm install
cat > .dev.vars <<'EOF'
MUG_PROXY_TOKEN=any-throwaway-value
MUG_DEV_ALLOW_LOOPBACK=1
EOF
npx wrangler dev --port 8787        # local runtime, local R2 under .wrangler/
```

`.dev.vars` and `.wrangler/` are gitignored. `MUG_DEV_ALLOW_LOOPBACK=1` lets the
SSRF guard reach `127.0.0.1` and `localhost` (any port, nothing else), so the
fixture shop can be scanned:

```bash
cd tests/fixtures/shop && python3 -m http.server 8899 --bind 127.0.0.1
curl -s -X POST http://127.0.0.1:8787/v1/discover \
  -H "authorization: Bearer any-throwaway-value" -H 'content-type: application/json' \
  -d '{"adapter":"shopify","url":"http://127.0.0.1:8899/"}'
```

Stop both afterwards. `lsof -ti :8787 -ti :8899 | xargs kill` frees the ports,
but wrangler's own process tree may outlive it; `pkill -f "wrangler dev"` ends it.

Tests run without any install: `node --test 'tests/*.test.mjs'` from the site
root. `tests/worker.test.mjs` calls this Worker's `fetch(request, env)` with an
in-memory R2 and a stubbed `fetch`.

To check the bundle builds without deploying:

```bash
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

## Deploying (the owner's step)

```bash
cd worker
npx wrangler r2 bucket create mug-images
npx wrangler secret put MUG_PROXY_TOKEN
npx wrangler deploy
```

Then set `MUG_PROXY_URL` (the Worker's URL) and the same `MUG_PROXY_TOKEN` on
the Convex deployment. The root README's "Going live" has the whole order.
