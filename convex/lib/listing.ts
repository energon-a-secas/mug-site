import { v } from "convex/values";

// The Convex side of docs/CONTRACTS.md C1 and C4.1. shared/contract.js is the
// source of the vocabularies; tests/listing-mirror.test.mjs reads this file
// and fails when a field or a literal here and there disagree, so the stored
// validator cannot drift from the normaliser that fills it.

export const styleValidator = v.union(
  v.literal("sculpted"),
  v.literal("shaped"),
  v.literal("relief"),
  v.literal("printed"),
  v.literal("tiki"),
  v.literal("teapot"),
  v.literal("stein"),
  v.literal("travel"),
  v.literal("other"),
);

export const materialValidator = v.union(
  v.literal("ceramic"),
  v.literal("stoneware"),
  v.literal("porcelain"),
  v.literal("earthenware"),
  v.literal("glass"),
  v.literal("plastic"),
  v.literal("steel"),
  v.literal("other"),
);

export const platformValidator = v.union(
  v.literal("shopify"),
  v.literal("woocommerce"),
  v.literal("jsonld"),
  v.literal("opengraph"),
  v.literal("paste"),
  v.literal("manual"),
);

export const listingValidator = v.object({
  v: v.number(),
  source: v.object({
    host: v.string(),
    url: v.optional(v.string()),
    key: v.string(),
    platform: platformValidator,
    via: v.union(v.literal("worker"), v.literal("runner"), v.literal("browser")),
    fetchedAt: v.number(),
  }),
  name: v.string(),
  brand: v.optional(v.string()),
  franchise: v.optional(v.string()),
  character: v.optional(v.string()),
  style: styleValidator,
  capacityMl: v.optional(v.number()),
  material: v.optional(materialValidator),
  hasLid: v.optional(v.boolean()),
  dishwasherSafe: v.optional(v.boolean()),
  microwaveSafe: v.optional(v.boolean()),
  sku: v.optional(v.string()),
  gtin: v.optional(v.string()),
  price: v.optional(v.object({ amount: v.number(), currency: v.string() })),
  available: v.optional(v.boolean()),
  images: v.array(v.string()),
  description: v.optional(v.string()),
  tags: v.array(v.string()),
  isMug: v.object({
    verdict: v.union(v.literal("yes"), v.literal("maybe"), v.literal("no")),
    reason: v.string(),
  }),
  productType: v.optional(v.string()),
  vendor: v.optional(v.string()),
});

// C4.1. `key` and `thumb` are R2 object keys when store is "r2", and Convex
// _storage ids when it is "convex". Browsers never see this shape.
export const imageRefValidator = v.object({
  store: v.union(v.literal("r2"), v.literal("convex")),
  key: v.string(),
  w: v.optional(v.number()),
  h: v.optional(v.number()),
  thumb: v.optional(v.string()),
  source: v.optional(v.string()),
});

export const matchValidator = v.object({
  kind: v.union(v.literal("new"), v.literal("same"), v.literal("changed"), v.literal("similar")),
  mugId: v.optional(v.id("mugs")),
  fields: v.array(v.string()),
  reason: v.string(),
});

// C7 rule 1's snapshot of a shop page, kept on mugSources.
export const seenValidator = v.object({
  name: v.string(),
  capacityMl: v.optional(v.number()),
  style: v.string(),
  price: v.optional(v.string()),
  images: v.number(),
  gtin: v.optional(v.string()),
  sku: v.optional(v.string()),
});
