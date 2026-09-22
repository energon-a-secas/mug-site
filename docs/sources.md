# Sources: which shops Mug reads, and why

From the brand research of 2026-09-21. The seed (`convex/seed.ts`) carries the
same list; this file says why each shop got the adapter it did. Re-check a shop
before changing its adapter: robots.txt files and bot protection change.

## Read automatically (Shopify)

Each answered its public product JSON with HTTP 200 from both a residential and
a datacenter origin, and allows it in robots.txt.

| Source | Feed | Notes |
|---|---|---|
| ABYstyle US | the whole-store feed, `abystyle.us/products.json` | 410 products, about 72 of them mugs, teapots and mug gift sets. The two mug collections alone held 47 and missed the Luna teapot, so the whole feed is read and non-mugs are dropped. No Pikachu 3D or Joker head mug among the 410 (2026-09-21) |
| Bioworld | `shop.bioworldmerch.com/collections/sculpted-mugs-sippers`, `/collections/mugs` | Carries the former Vandor line, but no longer lists the Ewok bas relief mug (none of its 3,672 products, 2026-09-21). Its `vendor` field is the licence ("Star Wars"), which is why sources carry their own brand (CONTRACTS A6). Prices look wholesale |
| Geeki Tikis (Beeline Creative) | `www.geekitikis.com/collections/shop-mugs` | 29 store-exclusive tiki mugs, no SKUs or barcodes |
| Half Moon Bay | `www.halfmoonbayshop.co.uk/collections/mugs` | 134 mugs, 6 shaped, mostly printed licensed mugs. Product pages carry barcodes |
| Grupo Erik | `erikstore.com/collections/tazas` | Spanish store: 47 tazas, 5 of them 3D |
| Pop Culture Coffee | the whole-store feed, `www.popculturecoffee.com/products.json` | Its own limited-edition licensed mugs (Ghostbusters, ParaNorman and more) beside coffee: 90 products, 37 staged as mugs. robots.txt allows Claude's agents by name and disallows only `/search`. Currency USD, from the shop's own `/meta.json` |

Shopify's public product JSON carries no barcode, and capacity is never a
structured field: it is read from titles and descriptions by
`shared/extract/facts.js`.

## Read by the local runner (JSON-LD pages)

| Source | Pages | Notes |
|---|---|---|
| Paladone (trade site) | the first page of nine `/usa/` categories (drinkware, trending, PlayStation, Super Mario, Star Wars, Harry Potter, Marvel, Disney), links whose address says "mug" | robots.txt disallows every query string, so search (`?q=`) and pagination (`?p=2`) are off limits: a category is read on its first page only. Product pages carry a valid JSON-LD Product (name, SKU, photo; the research's "invalid" no longer held on 2026-09-21), and prices show 0.00 when logged out, so none are kept. From Cloudflare the category pages come back without their product grid (one promoted link on every page), so the source fetches via the runner: 12 mugs from home against 1 from the Worker. A product URL found by browsing imports fine through `/admin/#import` |

## Manual only (paste or type)

| Source | Why |
|---|---|
| BigMouth Inc | A Cloudflare managed challenge answers every page, from any origin. A Shopify catalogue endpoint for agents is advertised at `/.well-known/ucp`; untested, and the lead worth following |
| ABYstyle EU (abystyle.com) | PrestaShop behind a Cloudflare challenge. Product URLs embed the EAN13. Use ABYstyle US, or paste |
| Funko | robots.txt disallows search (`*?q=`); product pages answer a challenge. The product sitemap is readable, so a discovery-only job could list new mug URLs for manual entry |
| Silver Buffalo | Its shop's robots.txt is `User-agent: *` / `Disallow: /`. Never fetched, and neither is its Amazon store (see Amazon below) |
| Just Funky | Same: `Disallow: /` for every agent. Never fetched |
| Surreal Entertainment | A brand site with no catalogue |

## Amazon

Never fetched by anything in this repo: its robots.txt disallows every Claude
agent, and its terms forbid automated reading. The Product Advertising API 5.0
was retired on 2026-05-15 by Amazon's own notices; its replacement (the Creators
API) is gated on an Associates account with recent qualifying sales. An Amazon
product enters by paste (`/admin/#import`): copy the page's URL, title and the
bullet you care about, and the paste parser does the rest.

## Not the same product

The 600 ml Astro Bot item with a lid that appears in marketplace searches is
Paladone's steel Gamer Cup, a travel cup, not the ceramic shaped mug. Check the
material when that paste is approved.
