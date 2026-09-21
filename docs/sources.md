# Sources: which shops Mug reads, and why

From the brand research of 2026-09-21. The seed (`convex/seed.ts`) carries the
same list; this file says why each shop got the adapter it did. Re-check a shop
before changing its adapter: robots.txt files and bot protection change.

## Read automatically (Shopify)

Each answered its public product JSON with HTTP 200 from both a residential and
a datacenter origin, and allows it in robots.txt.

| Source | Feed | Notes |
|---|---|---|
| ABYstyle US | `abystyle.us/collections/3d-mugs`, `/collections/mugs` | 9 3D mugs, 38 mugs. The Luna teapot is here; the Pikachu 3D and Joker head mugs were not, at the time |
| Bioworld | `shop.bioworldmerch.com/collections/sculpted-mugs-sippers`, `/collections/mugs` | Maker of the Ewok bas relief mug; carries the former Vandor line. Its `vendor` field is the licence ("Star Wars"), which is why sources carry their own brand (CONTRACTS A6). Prices look wholesale |
| Geeki Tikis (Beeline Creative) | `www.geekitikis.com/collections/shop-mugs` | 29 store-exclusive tiki mugs, no SKUs or barcodes |
| Half Moon Bay | `www.halfmoonbayshop.co.uk/collections/mugs` | 134 mugs, 6 shaped, mostly printed licensed mugs. Product pages carry barcodes |
| Grupo Erik | `erikstore.com/collections/tazas` | Spanish store: 47 tazas, 5 of them 3D |

Shopify's public product JSON carries no barcode, and capacity is never a
structured field: it is read from titles and descriptions by
`shared/extract/facts.js`.

## Manual only (paste or type)

| Source | Why |
|---|---|
| BigMouth Inc | A Cloudflare managed challenge answers every page, from any origin. A Shopify catalogue endpoint for agents is advertised at `/.well-known/ucp`; untested, and the lead worth following |
| ABYstyle EU (abystyle.com) | PrestaShop behind a Cloudflare challenge. Product URLs embed the EAN13. Use ABYstyle US, or paste |
| Funko | robots.txt disallows search (`*?q=`); product pages answer a challenge. The product sitemap is readable, so a discovery-only job could list new mug URLs for manual entry |
| Paladone | No consumer shop. The trade site's robots.txt disallows query strings and `/catalog/`, and its product structured data is invalid |
| Silver Buffalo | Its shop's robots.txt is `User-agent: *` / `Disallow: /`. Never fetched |
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
