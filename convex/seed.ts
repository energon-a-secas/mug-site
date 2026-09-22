import { internalMutation } from "./_generated/server";
import { brandVariants, slugify } from "../shared/extract/names.js";
import { fromPaste } from "../shared/extract/paste.js";
import { stageListing } from "./lib/stageCore.ts";

// Starting data, from the brand research of 2026-09-21 (docs/sources.md).
// Idempotent: run either as often as you like.
//
//   npx convex run seed:sources
//   npx convex run seed:pastes

type SeedBrand = { name: string; aliases?: string[]; website?: string; country?: string };

const BRANDS: SeedBrand[] = [
  { name: "ABYstyle", website: "https://www.abystyle.com", country: "FR" },
  { name: "Bioworld", website: "https://www.bioworldmerch.com", country: "US" },
  { name: "Geeki Tikis", aliases: ["Beeline Creative"], website: "https://www.geekitikis.com", country: "US" },
  { name: "Half Moon Bay", website: "https://www.halfmoonbayshop.co.uk", country: "GB" },
  { name: "Grupo Erik", aliases: ["Erik"], website: "https://erikstore.com", country: "ES" },
  { name: "BigMouth Inc", website: "https://bigmouthinc.com", country: "US" },
  { name: "Paladone", website: "https://www.paladone.com", country: "GB" },
  { name: "Funko", website: "https://funko.com", country: "US" },
  { name: "Silver Buffalo", website: "https://www.silver-buffalo.com", country: "US" },
  { name: "Just Funky", website: "https://justfunky.com", country: "US" },
  { name: "Surreal Entertainment", website: "https://www.surrealhq.com", country: "US" },
  { name: "Vandor", country: "US" },
  { name: "Pop Culture Coffee", website: "https://www.popculturecoffee.com", country: "US" },
];

type SeedSource = {
  slug: string;
  currency?: string;
  name: string;
  brand: string;
  adapter: "shopify" | "jsonld" | "manual";
  baseUrl: string;
  entryUrls: string[];
  include?: string[];
  fetchVia?: "cloud" | "local";
  watch: boolean;
  notes: string;
};

const SOURCES: SeedSource[] = [
  {
    slug: "abystyle-us", currency: "USD", name: "ABYstyle US shop", brand: "ABYstyle", adapter: "shopify", baseUrl: "https://abystyle.us",
    entryUrls: [], watch: true,
    notes: "Shopify, readable from residential and datacenter origins. The whole-store feed (410 products, about 72 mugs, teapots and mug gift sets) is read, not just the 3d-mugs and mugs collections. The EU shop (abystyle.com) is challenged.",
  },
  {
    slug: "bioworld", currency: "USD", name: "Bioworld shop", brand: "Bioworld", adapter: "shopify", baseUrl: "https://shop.bioworldmerch.com",
    entryUrls: ["https://shop.bioworldmerch.com/collections/sculpted-mugs-sippers", "https://shop.bioworldmerch.com/collections/mugs"], watch: true,
    notes: "Carries the former Vandor line; its shop no longer lists the Ewok bas relief mug (none of 3,672 products, 2026-09-21). Vendor field is the licence (A6). Prices look wholesale.",
  },
  {
    slug: "geeki-tikis", currency: "USD", name: "Geeki Tikis shop", brand: "Geeki Tikis", adapter: "shopify", baseUrl: "https://www.geekitikis.com",
    entryUrls: ["https://www.geekitikis.com/collections/shop-mugs"], watch: true,
    notes: "Beeline Creative. 29 store-exclusive tiki mugs, no SKUs or GTINs.",
  },
  {
    slug: "half-moon-bay", currency: "GBP", name: "Half Moon Bay shop", brand: "Half Moon Bay", adapter: "shopify", baseUrl: "https://www.halfmoonbayshop.co.uk",
    entryUrls: ["https://www.halfmoonbayshop.co.uk/collections/mugs"], watch: false,
    notes: "134 mugs, 6 shaped; mostly printed licensed mugs. Product pages carry GTINs.",
  },
  {
    slug: "erikstore", currency: "EUR", name: "Erik store (Grupo Erik)", brand: "Grupo Erik", adapter: "shopify", baseUrl: "https://erikstore.com",
    entryUrls: ["https://erikstore.com/collections/tazas"], watch: false,
    notes: "Spanish consumer store: 47 tazas, 5 of them 3D.",
  },
  {
    slug: "pop-culture-coffee", currency: "USD", name: "Pop Culture Coffee", brand: "Pop Culture Coffee", adapter: "shopify", baseUrl: "https://www.popculturecoffee.com",
    entryUrls: [], watch: true,
    notes: "Shopify, US. Its own limited-edition licensed mugs (Ghostbusters, ParaNorman and more) beside coffee; the whole-store feed is read and non-mugs are dropped. robots.txt allows Claude agents; /search is disallowed.",
  },
  {
    slug: "bigmouth", name: "BigMouth Inc", brand: "BigMouth Inc", adapter: "manual", baseUrl: "https://bigmouthinc.com",
    entryUrls: ["https://bigmouthinc.com/collections/coffee-mugs"], watch: false,
    notes: "Cloudflare managed challenge (403) on every page from both origins. A Shopify UCP catalogue endpoint is advertised at /.well-known/ucp, untested. Paste or type.",
  },
  {
    slug: "abystyle-eu", name: "ABYstyle EU shop", brand: "ABYstyle", adapter: "manual", baseUrl: "https://www.abystyle.com",
    entryUrls: [], watch: false,
    notes: "PrestaShop behind a Cloudflare challenge (403). Product URLs embed the EAN13. Use abystyle-us or paste.",
  },
  {
    slug: "funko", name: "Funko", brand: "Funko", adapter: "manual", baseUrl: "https://funko.com",
    entryUrls: [], watch: false,
    notes: "robots.txt disallows search (*?q=). Product pages answer a Cloudflare challenge. The product sitemap is readable (28 mug URLs) if a discovery-only job is ever wanted.",
  },
  {
    slug: "paladone", name: "Paladone (trade site)", brand: "Paladone", adapter: "jsonld", baseUrl: "https://trade.paladone.com",
    entryUrls: [
      "drinkware", "trending/latest-releases", "trending/best-sellers", "gaming/playstation",
      "gaming/super-mario", "film-tv/big-screen/star-wars", "film-tv/big-screen/harry-potter", "film-tv/big-screen/marvel", "film-tv/big-screen/disney",
    ].map((path) => `https://trade.paladone.com/usa/${path}`),
    include: ["mug"], fetchVia: "local", watch: false,
    notes: "B2B Magento, read by the local runner: from Cloudflare the /usa/ category pages come back without their product grid. robots.txt disallows every query string (search, ?p= pagination) and /catalog/, so each category is read on its first page only. Product pages carry a JSON-LD Product; prices show 0.00 when logged out, so none are kept.",
  },
  {
    slug: "silver-buffalo", name: "Silver Buffalo", brand: "Silver Buffalo", adapter: "manual", baseUrl: "https://shop.silver-buffalo.com",
    entryUrls: [], watch: false,
    notes: "robots.txt: User-agent * Disallow /. Never fetched. Paste or type.",
  },
  {
    slug: "just-funky", name: "Just Funky", brand: "Just Funky", adapter: "manual", baseUrl: "https://justfunky.com",
    entryUrls: [], watch: false,
    notes: "robots.txt: User-agent * Disallow /. Never fetched.",
  },
  {
    slug: "surreal", name: "Surreal Entertainment", brand: "Surreal Entertainment", adapter: "manual", baseUrl: "https://www.surrealhq.com",
    entryUrls: [], watch: false,
    notes: "Brand site only, no catalogue.",
  },
];

export const sources = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const ids = new Map<string, any>();
    let brandsAdded = 0;
    let sourcesAdded = 0;
    for (const brand of BRANDS) {
      // The same slug findOrCreateBrand would give it, so both paths meet.
      const niceSlug = slugify(brand.name);
      const found = await ctx.db.query("brands").withIndex("by_slug", (q) => q.eq("slug", niceSlug)).unique();
      if (found) {
        ids.set(brand.name, found._id);
        continue;
      }
      const aliases = [...new Set([brand.name, ...(brand.aliases ?? [])].flatMap((n) => brandVariants(n)))];
      ids.set(brand.name, await ctx.db.insert("brands", {
        slug: niceSlug, name: brand.name, aliases, website: brand.website, country: brand.country, mugCount: 0, createdAt: now, updatedAt: now,
      }));
      brandsAdded++;
    }
    for (const source of SOURCES) {
      const found = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", source.slug)).unique();
      if (found) {
        // A13 arrived after the first seed: give an existing feed its currency once.
        if (source.currency && !found.currency) await ctx.db.patch(found._id, { currency: source.currency, updatedAt: now });
        continue;
      }
      await ctx.db.insert("sources", {
        slug: source.slug,
        name: source.name,
        brandId: ids.get(source.brand),
        adapter: source.adapter,
        baseUrl: source.baseUrl,
        entryUrls: source.entryUrls,
        include: source.include ?? [],
        exclude: [],
        fetchVia: source.fetchVia ?? "cloud",
        watch: source.watch,
        enabled: source.adapter !== "manual",
        currency: source.currency,
        notes: source.notes,
        createdAt: now,
        updatedAt: now,
      });
      sourcesAdded++;
    }
    return { brandsAdded, sourcesAdded };
  },
});

// The owner's own examples, exactly as copied from Amazon on 2026-09-21.
// Amazon is never fetched (C11): these enter by paste, like any future one.
const PASTES = [
  `https://www.amazon.com/gp/product/B0GR5CDBHZ/ref=ox_sc_saved_title_1?smid=ATVPDKIKX0DER&psc=1
Amazon.com: Paladone Astrobot Shaped Mug - Officially Licensed Astrobot Product | Large 600ml Capacity • Character Shaped Mug • Unique Gaming Design • Durable Build • Astrobot Fan Gift : Home & Kit...
 Versatile lid: Multi-way design for easy drinking on the go`,
  `https://www.amazon.ca/gp/product/B0B4KGF9ZV/ref=ox_sc_saved_image_4?smid=&psc=1
ABYSTYLE - DC Comics Joker Head 3D Mug : Amazon.ca: Home
 100% official`,
  `https://www.amazon.ca/gp/product/B0D7J45CH5/ref=ox_sc_saved_image_2?smid=A3C9554I6S5ZCE&psc=1
ABYSTYLE - Pokemon Pikachu 3D Mug : Amazon.ca: Home
 Capacity: approx. 475 ml.`,
  `Star Wars Ewok 16 oz. Bas Relief Ceramic Mug : Amazon.ca: Home
 CUSTOM DESIGN- The Star Wars Ewok 16 oz. Bas Relief Ceramic Mug features vibrant colors and original sculpted artwork inspired by the cuddliest Star Wars characters in the galaxy`,
  `https://www.amazon.com/gp/product/B0CZ7KWSCD/ref=ox_sc_saved_title_1?smid=A1QZWXTEK2QD0C&psc=1
Amazon.com | ABYstyle Sailor Moon Luna Teapot Anime Manga Magical Girl Collectible Home Decor Kitchenware Merchandise Gift, Black: Teapots
 Capacity: 32.0 fluid_ounces`,
  `https://www.amazon.com/gp/product/B0F77SMSV7/ref=ox_sc_saved_title_6?smid=A2XZ7JICGUQ1CX&th=1
Amazon.com | Silver Buffalo South Park Kenny McCormick, 3D Sculpted Mug, 20oz | Ceramic, 0.59 Liters: Coffee Cups & Mugs
 SOUTH PARK: Themed mug features Kenny in his iconic orange hoodie. Mug is complete with a white interior.`,
];

export const pastes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const knownBrands = (await ctx.db.query("brands").take(1000)).map((b) => b.name);
    const runId = await ctx.db.insert("runs", {
      kind: "paste", target: "the owner's six Amazon examples", trigger: "manual", status: "ready",
      entryIndex: 0, page: 1, retries: 0, discovered: PASTES.length, staged: 0, unchanged: 0, skipped: 0, needsLocal: 0, failed: 0,
      createdAt: now, updatedAt: now,
    });
    const outcomes = [];
    for (const text of PASTES) {
      const url = text.startsWith("https://") ? text.split("\n")[0] : undefined;
      const parsed: any = fromPaste(text, { url, knownBrands, now });
      if (!parsed.ok) {
        outcomes.push({ ok: false, code: parsed.code });
        continue;
      }
      const staged = await stageListing(ctx.db, { listing: parsed.listing, runId, now });
      outcomes.push({ ok: true, name: parsed.listing.name, brand: parsed.listing.brand ?? null, outcome: staged.outcome });
    }
    return outcomes;
  },
});
