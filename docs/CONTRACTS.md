# Mug: frozen contracts

Written 2026-09-21, before any code. Every subsystem is built against this file,
and a change to it is a numbered amendment at the bottom with its reason, never
a silent edit. The graph-vs-direct lesson this follows: the costly failures came
from building against a contract that moved, not from any one subsystem.

## 0. Subsystem map

```
                         ┌─────────────────────────────── GitHub Pages ───────────────────────────────┐
  visitor / collector ──▶│ /  /mug/?slug  /brand/?slug  /community/  /shelf/  /u/?handle  /admin/    │
                         └───────────────┬───────────────────────────────────────────┬───────────────┘
                                         │ ConvexHttpClient (Clerk token via Auth Kit)│ <img src>
                                         ▼                                           ▼
  ┌──────────────────────────── Convex ─────────────────────────────┐   ┌────── Cloudflare Worker ──────┐
  │ catalog, shelf, profiles, community        (public, signed in)  │   │ mug-proxy                      │
  │ sources, runs, staging, importer, mugs,     (ADMIN_SUBJECTS)    │──▶│  POST /v1/probe                │──▶ brand shops
  │ images, moderation, runnerTokens                                │   │  POST /v1/discover             │    (robots.txt first)
  │ scan:* images:* (internal, scheduled)                          │   │  POST /v1/extract              │
  │ http.ts  /runner/*  (runner token)                              │   │  POST /v1/images/mirror|put    │──▶ R2 bucket mug-images
  └───────────────▲─────────────────────────────────────────────────┘   │  GET  /i/<key>   (public)      │
                  │ HTTPS, Bearer mugr_…                                 └────────────────────────────────┘
  ┌───────────────┴──────────────┐        both import shared/ (extract, net, images), so a listing
  │ runner/mug-runner.mjs (Node) │        read by the Worker and one read by the runner cannot differ
  │ owner's workstation          │──▶ brand shops that refuse datacenter IPs (robots.txt still binding)
  └──────────────────────────────┘
```

| Subsystem | Owns | Talks to |
|---|---|---|
| `shared/` | The listing contract (C1), fact parsing, extractors, robots and SSRF guards, image sniffing. Plain ES modules, no dependencies. | Imported by the Worker, the runner, Convex and the admin page. |
| `worker/` | Fetching third-party pages and images, R2. Holds no catalogue state. | Called only by Convex (one shared secret). Serves `/i/` publicly. |
| `convex/` | Every piece of state, all identity checks, orchestration. | The Worker (outbound), browsers, the runner (HTTP actions). |
| `runner/` | Fetching from a residential connection when the Worker is refused. | Convex HTTP actions only. |
| pages (`js/`, `css/`, `_templates/`) | Rendering. Trusts nothing it renders. | Convex, and `/i/` for images. |

## C1. `Listing` v1: one product as read from a shop

The only shape that crosses a subsystem boundary for scraped data. Produced by
every extractor through `normalizeListing()`, carried by the Worker's responses,
posted by the runner, stored in `staging.listing`, and re-validated on ingest by
Convex. **Additive only**: a new optional field is an amendment; renaming,
retyping or tightening a field bumps `v` to 2.

```js
{
  v: 1,
  source: {
    host: "abystyle.com",            // lowercase, no "www."
    url: "https://…",                // the page or endpoint it was read from, absolute https;
                                     // optional for paste and manual, required for every other platform
    key: "abystyle.com/products/…",  // stable identity, see C1.2
    platform: "shopify" | "woocommerce" | "jsonld" | "opengraph" | "paste" | "manual",
    via: "worker" | "runner" | "browser",
    fetchedAt: 1758470400000          // ms epoch
  },
  name: "Pikachu 3D Mug",             // required, 1 to 200 chars, whitespace collapsed
  brand: "ABYstyle",                  // optional, 1 to 80
  franchise: "Pokemon",               // optional suggestion, canonical name from FRANCHISES when matched
  character: "Pikachu",               // optional, 1 to 80
  style: "sculpted",                  // STYLES, always present after normalisation ("other" when unknown)
  capacityMl: 475,                    // optional integer, 30 to 5000
  material: "ceramic",                // optional, MATERIALS
  hasLid: true,                       // optional booleans: only set when the text says so
  dishwasherSafe: false,
  microwaveSafe: false,
  sku: "ABYMUG123",                   // optional, 1 to 64, trimmed
  gtin: "3665361123456",              // optional, digits only, check digit valid, GTIN-13 form (C1.3)
  price: { amount: 19.99, currency: "EUR" },   // optional, amount > 0, ISO 4217
  available: true,                    // optional
  images: ["https://…"],              // 0 to 12 absolute https URLs, deduplicated, order kept
  description: "…",                   // optional plain text, max 2000 chars, ADMIN REFERENCE ONLY (C11)
  tags: ["pokemon", "3d"],            // 0 to 30 lowercase strings, 1 to 40 chars each
  isMug: { verdict: "yes" | "maybe" | "no", reason: "title says mug" },
  productType: "Mugs"                 // optional, the shop's own category string, 1 to 80
}
```

`STYLES = ["sculpted", "shaped", "relief", "printed", "tiki", "teapot", "stein", "travel", "other"]`

- `sculpted`: a 3D character head or body ("3D mug", "sculpted mug")
- `shaped`: the vessel is an object's shape ("Astro Bot shaped mug")
- `relief`: raised decoration on a plain body ("bas relief", "embossed")
- `printed`: a print or decal on a standard body
- `tiki`, `teapot`, `stein`, `travel` (travel mugs and tumblers): as named

`MATERIALS = ["ceramic", "stoneware", "porcelain", "earthenware", "glass", "plastic", "steel", "other"]`

### C1.1 The shared module surface (frozen signatures)

`shared/contract.js`: `LISTING_VERSION = 1`, `STYLES`, `MATERIALS`, `PLATFORMS`, `VIAS`, `LIMITS`.

`shared/extract/normalize.js`:
- `normalizeListing(input, { now })` returns `{ ok: true, listing }` or `{ ok: false, code, message }`.
  Codes: `no-name`, `bad-url`, `bad-source`. Never throws on bad input. Fills derived facts
  (style, capacity, material, lid, care, isMug, franchise) from name, tags, productType and
  description when the extractor left them unset, and clamps everything to C1.
- `listingKey({ url, platform, handle?, id? })` returns the C1.2 key string.
- `canonicalUrl(url)` returns an absolute https URL string or `null`.

`shared/extract/facts.js`: `parseCapacityMl(text)`, `detectStyle(text)`, `detectMaterial(text)`,
`detectLid(text)`, `detectCare(text)` returning `{ dishwasherSafe?, microwaveSafe? }`,
`mugVerdict({ name, tags, productType })`, `detectFranchise(text)` returning a canonical name or `null`.

`shared/extract/names.js`: `slugify(text)`, `nameKey(name, brand?)`, `cleanName(name, brand?)`,
`normalizeGtin(raw)` returning GTIN-13 digits or `null`.

Extractors, each returning a `normalizeListing` result:
- `shared/extract/shopify.js`: `fromShopifyProduct(product, { baseUrl, via, now })`
- `shared/extract/woocommerce.js`: `fromWooProduct(product, { baseUrl, via, now })`
- `shared/extract/jsonld.js`: `fromJsonLd(html, { url, via, now })` (`ok: false, code: "no-product"` when none)
- `shared/extract/opengraph.js`: `fromOpenGraph(html, { url, via, now })`
- `shared/extract/html.js`: `fromHtml(html, { url, via, now })`, JSON-LD first, OpenGraph second
- `shared/extract/paste.js`: `fromPaste(text, { url?, knownBrands?, now })`
- `shared/extract/listing-page.js`: `productLinks(html, { url, include, exclude })` and
  `sitemapUrls(xml, { url, include, exclude })`

### C1.2 The listing key

The key is what makes a re-scan update a mug instead of duplicating it.

| Platform | Key |
|---|---|
| shopify | `<host>/products/<handle>` |
| woocommerce | `<host>/p/<id>` (the Store API numeric id) |
| jsonld, opengraph | the canonical URL (`link rel=canonical`, else `og:url`, else the fetched URL) as `<host><path>`, lowercase host without `www.`, no query, no hash, no trailing slash |
| paste | `amazon:<ASIN>` when the URL carries one, else `paste:<nameKey>` |
| manual | `manual:<nameKey>:<brand slug or "-">` |

### C1.3 GTIN

Digits only. Lengths 8, 12, 13 and 14 are accepted when the check digit is valid.
A 12-digit UPC-A is stored with a leading `0` (GTIN-13); a 14-digit value with a
leading `0` drops it; GTIN-8 is stored as is. Anything else is dropped, not
guessed.

## C2. Sources

A source is one shop feed the admin can scan. Stored in `sources`; configured in
the admin page; read by the Worker call Convex makes, or by the runner.

```js
{
  slug: "abystyle-eu",
  name: "ABYstyle (EU shop)",
  brandId?: Id<"brands">,
  adapter: "shopify" | "woocommerce" | "jsonld" | "manual",
  baseUrl: "https://abystyle.com",
  entryUrls: ["https://abystyle.com/collections/mugs"],  // collection, search or sitemap URLs
  include: ["mug", "tasse", "teapot"],                    // lowercase words; empty = mugVerdict decides
  exclude: ["coaster", "keychain"],
  fetchVia: "cloud" | "local",
  watch: false,                                           // weekly cron re-scan
  enabled: true
}
```

| adapter | discover | per product |
|---|---|---|
| shopify | `/products.json?limit=50&page=N`, or `<collection>/products.json` for each entry URL | none needed, the JSON is the product |
| woocommerce | `/wp-json/wc/store/v1/products?per_page=50&page=N&search=<first include word>` | none needed |
| jsonld | entry URLs: a sitemap (`.xml`) yields URLs, an HTML listing yields same-host product links | `/v1/extract` per URL |
| manual | nothing: the admin pastes or types | none |

## C3. Worker HTTP API (`worker/`, name `mug-proxy`)

Base URL is `MUG_PROXY_URL` in Convex (`http://127.0.0.1:8787` under `wrangler dev`).

**Auth.** Every `POST`, `PUT` and `DELETE` needs `Authorization: Bearer <MUG_PROXY_TOKEN>`,
compared in constant time. No browser ever holds it. `GET /health` and `GET /i/<key>` are
public.

**Envelope.** Success is `{ ok: true, … }` with HTTP 200. Failure is always JSON:

```js
{ ok: false, code: "UPSTREAM_BLOCKED", message: "…", hint?: "…", upstreamStatus?: 403 }
```

The router is wrapped so that a Worker bug still answers `INTERNAL` as JSON, never the
runtime's HTML 500 page.

| code | HTTP | meaning | Convex reaction |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | missing or wrong bearer | configuration fault, stop the run |
| `BAD_REQUEST` | 400 | body shape wrong | bug, mark the item failed |
| `URL_NOT_ALLOWED` | 400 | failed the SSRF guard (C10.3) | mark failed |
| `ROBOTS_DISALLOWED` | 403 | the shop's robots.txt refuses MugBot for that path | mark failed with reason `robots`, never retried, never sent to the runner |
| `UPSTREAM_BLOCKED` | 502 | shop answered 401, 403, 429, 503, or a bot challenge page | send to the runner queue (`needsLocal`) |
| `UPSTREAM_ERROR` | 502 | any other non-2xx, or unparseable body | retry once later, then failed |
| `UPSTREAM_TIMEOUT` | 504 | no answer in 15 s | retry once later, then failed |
| `TOO_LARGE` | 413 | body over the cap (C10.4) | failed |
| `NOT_A_PRODUCT` | 422 | page read, no product data in it | failed with reason `no-product` |
| `NOT_AN_IMAGE` | 422 | image URL did not return an image type | drop that image |
| `NOT_CONFIGURED` | 501 | R2 binding or token secret absent | fall back (C4.3) |
| `NOT_FOUND` | 404 | `/i/<key>` has no object | none |
| `INTERNAL` | 500 | Worker bug | retry once later |

**Routes.**

| Route | Body | Answer |
|---|---|---|
| `GET /health` | none | `{ ok, version, r2: bool, token: bool }` (booleans only, never values) |
| `POST /v1/probe` | `{ url }` | `{ ok, robots: { allowed, rule }, platform: "shopify"\|"woocommerce"\|"unknown", status }` |
| `POST /v1/discover` | `{ adapter, url, page?, include?, exclude? }` | `{ ok, listings?: Listing[], urls?: string[], skipped: number, next: { page } \| null, fetched: { url, status, bytes, ms } }` |
| `POST /v1/extract` | `{ url }` | `{ ok, listing: Listing, fetched }` |
| `POST /v1/images/mirror` | `{ url }` | `{ ok, key, bytes, contentType, w?, h? }` (C4) |
| `PUT /v1/images/put?kind=thumb\|photo\|original` | raw bytes, `Content-Type` set | same as mirror |
| `DELETE /v1/images/<key>` | none | `{ ok, deleted: bool }` |
| `GET /i/<key>` | none | the object, `Cache-Control: public, max-age=31536000, immutable`, `ETag`, `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `304` on `If-None-Match` |

`discover` on `shopify` and `woocommerce` returns `listings` (already filtered by
`include`/`exclude` and `isMug.verdict !== "no"`, with the drop count in `skipped`); on
`jsonld` it returns `urls`. One shop page per call: Convex paginates by calling again with
`next.page`, so a Worker invocation makes at most four subrequests (robots, page, one
redirect hop each).

## C4. Images

### C4.1 Stored reference (`imageRef`, in Convex)

```js
{ store: "r2" | "convex", key: string, w?: number, h?: number, thumb?: string, source?: string }
```

- `store: "r2"`: `key` and `thumb` are R2 object keys.
- `store: "convex"`: `key` and `thumb` are Convex `_storage` ids. The fallback store.
- `source` is the remote URL it was mirrored from, kept for attribution and takedowns.

### C4.2 R2 keys

| Prefix | What | Written by |
|---|---|---|
| `o/<sha256>.<ext>` | an original, mirrored from a shop or uploaded by the admin | `/v1/images/mirror`, `/v1/images/put?kind=original` |
| `t/<sha256>.webp` | a 480 px wide thumbnail, made in the admin's browser (C4.4) | `/v1/images/put?kind=thumb` |
| `p/<sha256>.<ext>` | a collector's photo, 1600 px max, made in their browser | `/v1/images/put?kind=photo` |

`sha256` is of the stored bytes, lowercase hex, so the same bytes are stored once and a
key never changes meaning. `ext` is from the sniffed type (`jpg`, `png`, `webp`, `gif`,
`avif`), never from the URL. Width and height are read from the file header, not decoded.

### C4.3 Resolution and fallback

Browsers never see an `imageRef`. Public queries return `{ src, thumb, w?, h? }` with
absolute URLs: `r2` resolves to `<MUG_IMAGES_BASE>/<key>` (default `<MUG_PROXY_URL>/i`),
`convex` to `ctx.storage.getUrl(key)`. `thumb` falls back to `src`.

Mirroring order: the Worker (`/v1/images/mirror`); on `NOT_CONFIGURED` or no
`MUG_PROXY_URL`, a Convex action fetches the image itself and stores it with
`ctx.storage.store` (the last resort the brief asked for); on `UPSTREAM_BLOCKED` the mug
goes to the runner queue with `imageState: "blocked"`.

### C4.4 Thumbnails

Free-plan Workers cannot decode images inside their CPU budget, so thumbnails are made
where CPU is free: the admin's browser (`createImageBitmap`, a canvas 480 px wide, WebP at
0.8). The admin page uploads the bytes to Convex storage, and `images:attachThumb` moves
them to R2 through `PUT /v1/images/put?kind=thumb`, deleting the Convex copy. A collector's
photo takes the same path at 1600 px.

## C5. Convex data model

`convex/schema.ts` is canonical; this is the map. Every write goes through a core in
`convex/lib/*Core.ts` that takes `(db, …, now, env)` and never reads `process.env`, so
`tests/` can run it against `tests/support/fakedb.mjs`.

| Table | Purpose | Key indexes |
|---|---|---|
| `brands`, `franchises` | Names, aliases, published mug count | `by_slug` |
| `mugs` | The public catalogue | `by_slug`, `by_status_published`, `by_status_owned`, `by_status_wanted`, `by_brand`, `by_franchise`, `by_style`, `by_gtin`, `by_brand_sku`, `by_nameKey`, `by_imageState`, search `search` |
| `mugSources` | Listing key to mug, one row per shop page | `by_key`, `by_mug` |
| `sources` | C2 | `by_slug`, `by_watch` |
| `runs` | One scan, URL import or paste | `by_created`, `by_status`, `by_source` |
| `staging` | The review queue, one listing per row | `by_status`, `by_run_status`, `by_key` |
| `shelfItems` | A collector's owned, wanted and once-owned mugs | `by_subject`, `by_subject_mug`, `by_mug`, `by_created` |
| `profiles` | Handle, display name, publish flag, counts | `by_subject`, `by_handle`, `by_published_owned` |
| `photos` | A collector's own photo of a mug they own, moderated | `by_status`, `by_mug`, `by_subject` |
| `runnerTokens` | Hashed tokens for the local runner | `by_hash` |
| `rateEvents` | Sliding-window rate limits (vitrina's pattern) | `by_bucket_at` |
| `stats` | Counters the community page shows | `by_key` |

`status` of a mug is `published` or `hidden`. Denormalised counters (`mugs.ownedCount`,
`mugs.wantedCount`, `profiles.ownedCount`, `brands.mugCount`, `stats`) are only ever
changed by the core that changes the rows they count, in the same mutation.

## C6. Convex function surface

Browsers call functions by string name. `js/backend.js` exports every name a page may
call as `FN`, and `tests/backend-contract.test.mjs` fails when `FN` and the exports in
`convex/*.ts` disagree. Expected failures are **returned** as `{ ok: false, code, message }`
(vitrina's `result.ts`), because a thrown error reaches the browser with its code stripped.

| Access | Modules |
|---|---|
| anyone | `catalog:list`, `catalog:get`, `catalog:facets`, `catalog:brand`, `community:overview`, `profiles:byHandle` |
| signed in | `shelf:*`, `profiles:mine/claimHandle/update/setPublished/deleteMyData`, `photos:uploadUrl/add/remove` |
| admin (`ADMIN_SUBJECTS`) | `admin:*`, `sources:*`, `runs:*`, `staging:*`, `importer:*`, `mugs:*`, `images:uploadUrl/attachThumb/retry`, `moderation:*`, `runnerTokens:*` |
| internal only | `scan:*`, `images:mirrorMug/mirrorPhoto`, cron entries |
| runner token | HTTP actions under `/runner/` (C8) |

`admin:whoami` answers every caller (`{ signedIn, isAdmin }`) so the admin page can say
why it is empty; every other admin function refuses non-admins with `not-admin`.

## C7. Matching a listing to the catalogue

Run by `convex/lib/matchCore.ts` on every staged listing, strongest rule first:

1. `mugSources.by_key` has the listing key: **same** when name, capacity, style, price and
   image count are unchanged, else **changed** with the list of fields that differ.
2. `mugs.by_gtin` has its GTIN: **same** or **changed**, as above.
3. `mugs.by_brand_sku` has its brand and SKU: **same** or **changed**.
4. `mugs.by_nameKey` has `nameKey(name, brand)`: **similar**. Never merged automatically.
5. Otherwise **new**.

`same` rows are not staged as pending; the run counts them as `unchanged` and bumps
`mugSources.lastSeenAt`. `changed` and `similar` wait for the admin, who approves (update
or create), merges into a chosen mug, or rejects.

## C8. Runner protocol

Token format: `mugr_` followed by 32 base62 characters. Created in the admin page, shown
once, stored as its SHA-256 hex with an 8-character display prefix. Sent as
`Authorization: Bearer mugr_…` to `<CONVEX_SITE_URL>/runner/…`.

| Route | Body | Answer |
|---|---|---|
| `GET /runner/queue?limit=N` | none | `{ ok, items: [{ id, kind: "page" \| "image", url, mugId?, index? }] }` |
| `POST /runner/ingest` | `{ id, listing }` or `{ id, error: { code, message } }` | `{ ok, status, match? }` |
| `POST /runner/scan` | `{ sourceSlug }` | `{ ok, runId, source }` (the C2 record) |
| `POST /runner/stage` | `{ runId, listings: Listing[] }` (at most 50) | `{ ok, staged, unchanged, skipped }` |
| `POST /runner/finish` | `{ runId, error? }` | `{ ok }` |
| `POST /runner/upload-url` | none | `{ ok, uploadUrl }` |
| `POST /runner/image` | `{ mugId, index, storageId }` | `{ ok }` |

Convex re-runs `normalizeListing` on everything the runner posts; the runner's say-so
is never enough.

## C9. Identity, roles and gates

- **Sign-in** is the fleet's Clerk instance through the Auth Kit; Convex reads
  `ctx.auth.getUserIdentity()` and never trusts a user id from the client.
- **Admin** is membership of `ADMIN_SUBJECTS` (comma-separated Clerk subjects). Unset means
  nobody, never everybody.
- **Publishing a shelf** is closed until `PUBLISHING=open` is set on the deployment, as in
  vitrina: a handle can be claimed, but `profiles:byHandle` answers `null` to everyone but
  the owner, and the community page lists nobody.
- **Photos** are `pending` until an admin approves them, and only appear on published
  shelves.
- **Rate limits** (per subject, sliding window): shelf writes 240 per hour, profile edits
  30 per hour, photo uploads 20 per day, handle changes 3 per 30 days.
- **Dev sign-in**, for local verification only: when the deployment has
  `MUG_DEV_JWKS_URL`, `auth.config.ts` also trusts a local issuer whose keys never leave the
  developer's machine. Production never has it, so production never accepts those tokens.

## C10. Politeness (binding for the Worker and the runner)

1. **User-Agent** `MugBot/1.0 (+https://mug.neorgon.com/bot/)`, always. Neither the Worker
   nor the runner ever presents itself as a browser.
2. **robots.txt** is read before the first fetch on a host, cached for an hour, and obeyed
   for the `mugbot` group, else `*`. A 4xx robots file means allowed; 5xx or a timeout
   means disallowed for now (RFC 9309). A disallowed path is `ROBOTS_DISALLOWED` everywhere,
   including the runner.
3. **SSRF guard**: `https` or `http` only, default ports only, no IP literals in private,
   loopback, link-local or CGNAT ranges, no `localhost`, `*.local`, `*.internal`,
   `metadata*`. Redirects are followed by hand, at most 5, each hop re-checked (guard and
   robots).
4. **Caps**: 15 s per request; 5 MB for HTML, JSON and XML; 15 MB for images.
5. **Pacing** lives in the caller: Convex spaces requests to one host at least 1.5 s apart,
   the runner waits 1.5 s between requests. A scan reads at most 40 discover pages.

## C11. What is shown publicly

- Facts are shown (name, brand, franchise, style, capacity, material, care, codes, price
  seen and when). The shop's own marketing copy is kept in staging for the admin's
  reference and is **not** published; a mug's public `blurb` is written by the admin.
- Every mirrored image keeps its `source`, and every mug links to the shop page it came
  from. Removing a mug or an image on request is an admin action (`mugs:setStatus`,
  `images` delete), and the bot page says how to ask.
- Amazon is never fetched by anything in this repo. An Amazon product enters by paste
  (C1 `paste`), and its link is kept as a shop link.

## Environment and secrets (names only)

| Where | Name | Notes |
|---|---|---|
| Convex | `ADMIN_SUBJECTS` | comma-separated Clerk subjects |
| Convex | `PUBLISHING` | `open` to allow public shelves; unset is closed |
| Convex | `MUG_PROXY_URL` | Worker base URL; unset sends every fetch to the runner queue and stores images in Convex |
| Convex | `MUG_PROXY_TOKEN` | secret, same value as the Worker's |
| Convex | `MUG_IMAGES_BASE` | optional, defaults to `<MUG_PROXY_URL>/i` |
| Convex | `MUG_DEV_JWKS_URL` | local deployments only, never production |
| Worker | `MUG_PROXY_TOKEN` | secret, `wrangler secret put` |
| Worker | `IMAGES` | R2 binding to bucket `mug-images` |
| runner | `MUG_CONVEX_SITE`, `MUG_RUNNER_TOKEN` | in `runner/.env`, gitignored |

## Amendments

**A1 (2026-09-21, before any consumer existed).** `/v1/discover`'s `next` is
`{ page, url? } | null`. An HTML listing paginates by its own `rel="next"` link, not
by a page number, so the Worker hands that URL back and Convex passes it as `url` on
the next call. Additive: a caller that reads only `page` is unaffected.

**A2 (2026-09-21, before any consumer existed).** C1 `source.url` is optional for
`paste` and `manual` listings, which may have no page to point at. Every other
platform still requires it.

**A3 (2026-09-21, before any consumer existed).** C7 rule 1 compares the listing with
what the same shop page said last time (`mugSources.seen`), not with the curated mug:
otherwise every admin rename reads as a change at the shop. Rules 2 and 3 (same GTIN,
same brand and SKU) from a shop page the mug does not know yet are **linked**: a
`mugSources` row is added and nothing is staged, because a barcode match is not a
question worth an admin's time.
