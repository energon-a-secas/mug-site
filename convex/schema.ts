import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  imageRefValidator, listingValidator, matchValidator, materialValidator, seenValidator, styleValidator,
} from "./lib/listing.ts";

// docs/CONTRACTS.md C5 is the map; this file is canonical. Counters (mugCount,
// ownedCount, wantedCount, stats) are only changed by the core that changes
// the rows they count, inside the same mutation, so they cannot drift.
//
// tests/support/fakedb.mjs parses this file, so keep each validator on the
// v.* forms it knows or a named validator imported from ./lib/listing.ts.

export default defineSchema({
  brands: defineTable({
    slug: v.string(),
    name: v.string(),
    aliases: v.array(v.string()),
    website: v.optional(v.string()),
    country: v.optional(v.string()),
    mugCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_mugCount", ["mugCount"]),

  franchises: defineTable({
    slug: v.string(),
    name: v.string(),
    mugCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_mugCount", ["mugCount"]),

  mugs: defineTable({
    slug: v.string(),
    name: v.string(),
    nameKey: v.string(),
    brandId: v.optional(v.id("brands")),
    franchiseId: v.optional(v.id("franchises")),
    character: v.optional(v.string()),
    style: styleValidator,
    capacityMl: v.optional(v.number()),
    material: v.optional(materialValidator),
    hasLid: v.optional(v.boolean()),
    dishwasherSafe: v.optional(v.boolean()),
    microwaveSafe: v.optional(v.boolean()),
    sku: v.optional(v.string()),
    gtin: v.optional(v.string()),
    releaseYear: v.optional(v.number()),
    blurb: v.optional(v.string()),
    images: v.array(imageRefValidator),
    // Remote URLs from the listing that are not mirrored yet (C4.3).
    pendingImages: v.array(v.string()),
    // URLs the runner could not fetch either (A9); images:retry moves them back.
    failedImages: v.optional(v.array(v.string())),
    // none: no images at all. pending: mirroring is scheduled. blocked: the
    // image host refused the Worker, so the runner fetches them. failed: gave
    // up. thumbs: originals stored, thumbnails missing. ok: nothing to do.
    imageState: v.union(
      v.literal("none"),
      v.literal("pending"),
      v.literal("blocked"),
      v.literal("failed"),
      v.literal("thumbs"),
      v.literal("ok"),
    ),
    links: v.array(v.object({ kind: v.string(), url: v.string(), label: v.optional(v.string()) })),
    lastPrice: v.optional(v.object({ amount: v.number(), currency: v.string(), at: v.number() })),
    status: v.union(v.literal("published"), v.literal("hidden")),
    ownedCount: v.number(),
    wantedCount: v.number(),
    searchText: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status_published", ["status", "publishedAt"])
    .index("by_status_owned", ["status", "ownedCount"])
    .index("by_status_wanted", ["status", "wantedCount"])
    .index("by_status_name", ["status", "nameKey"])
    .index("by_brand", ["brandId", "status", "publishedAt"])
    .index("by_franchise", ["franchiseId", "status", "publishedAt"])
    .index("by_style", ["style", "status", "publishedAt"])
    .index("by_gtin", ["gtin"])
    .index("by_brand_sku", ["brandId", "sku"])
    .index("by_nameKey", ["nameKey"])
    .index("by_imageState", ["imageState", "updatedAt"])
    .searchIndex("search", {
      searchField: "searchText",
      filterFields: ["status", "brandId", "style", "franchiseId"],
    }),

  mugSources: defineTable({
    mugId: v.id("mugs"),
    key: v.string(),
    sourceId: v.optional(v.id("sources")),
    url: v.optional(v.string()),
    // What the shop said the last time this page was read. A re-scan compares
    // against this, not against the curated mug, so an admin's rename is not
    // reported as a change at the shop (C7 rule 1).
    seen: seenValidator,
    lastSeenAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_mug", ["mugId"]),

  sources: defineTable({
    slug: v.string(),
    name: v.string(),
    brandId: v.optional(v.id("brands")),
    adapter: v.union(v.literal("shopify"), v.literal("woocommerce"), v.literal("jsonld"), v.literal("manual")),
    baseUrl: v.string(),
    entryUrls: v.array(v.string()),
    include: v.array(v.string()),
    exclude: v.array(v.string()),
    fetchVia: v.union(v.literal("cloud"), v.literal("local")),
    watch: v.boolean(),
    enabled: v.boolean(),
    notes: v.optional(v.string()),
    lastProbe: v.optional(
      v.object({
        at: v.number(),
        robots: v.string(),
        platform: v.optional(v.string()),
        status: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
    lastRunId: v.optional(v.id("runs")),
    lastRunAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_watch", ["watch", "enabled"]),

  runs: defineTable({
    sourceId: v.optional(v.id("sources")),
    kind: v.union(v.literal("scan"), v.literal("url"), v.literal("paste"), v.literal("manual"), v.literal("runner")),
    target: v.string(),
    trigger: v.union(v.literal("manual"), v.literal("cron"), v.literal("runner")),
    status: v.union(
      v.literal("discovering"),
      v.literal("extracting"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // Where discovery is: which entry URL, which page, and the rel=next URL
    // an HTML listing handed back (CONTRACTS A1).
    entryIndex: v.number(),
    page: v.number(),
    nextUrl: v.optional(v.string()),
    retries: v.number(),
    discovered: v.number(),
    staged: v.number(),
    unchanged: v.number(),
    skipped: v.number(),
    needsLocal: v.number(),
    failed: v.number(),
    error: v.optional(v.string()),
    startedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_source", ["sourceId", "createdAt"]),

  staging: defineTable({
    runId: v.optional(v.id("runs")),
    sourceId: v.optional(v.id("sources")),
    key: v.string(),
    url: v.optional(v.string()),
    listing: v.optional(listingValidator),
    match: v.optional(matchValidator),
    status: v.union(
      v.literal("queued"),
      v.literal("pending"),
      v.literal("needsLocal"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    error: v.optional(v.object({ code: v.string(), message: v.string() })),
    reviewedBy: v.optional(v.string()),
    reviewedAt: v.optional(v.number()),
    mugId: v.optional(v.id("mugs")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_run_status", ["runId", "status"])
    .index("by_key", ["key"]),

  shelfItems: defineTable({
    subject: v.string(),
    mugId: v.id("mugs"),
    state: v.union(v.literal("owned"), v.literal("wanted"), v.literal("had")),
    note: v.optional(v.string()),
    condition: v.optional(v.union(v.literal("mint"), v.literal("boxed"), v.literal("used"), v.literal("chipped"))),
    pricePaid: v.optional(v.number()),
    currency: v.optional(v.string()),
    acquiredOn: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subject", ["subject", "state", "updatedAt"])
    .index("by_subject_mug", ["subject", "mugId"])
    .index("by_mug", ["mugId", "state"])
    .index("by_created", ["createdAt"]),

  profiles: defineTable({
    subject: v.string(),
    handle: v.optional(v.string()),
    displayName: v.optional(v.string()),
    bio: v.optional(v.string()),
    published: v.boolean(),
    publishedAt: v.optional(v.number()),
    suspended: v.boolean(),
    ownedCount: v.number(),
    wantedCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subject", ["subject"])
    .index("by_handle", ["handle"])
    .index("by_published_owned", ["published", "ownedCount"]),

  photos: defineTable({
    subject: v.string(),
    mugId: v.id("mugs"),
    image: imageRefValidator,
    caption: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("visible"), v.literal("rejected")),
    createdAt: v.number(),
    reviewedAt: v.optional(v.number()),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_mug", ["mugId", "status", "createdAt"])
    .index("by_subject", ["subject", "createdAt"]),

  runnerTokens: defineTable({
    label: v.string(),
    hash: v.string(),
    prefix: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_created", ["createdAt"]),

  rateEvents: defineTable({
    bucket: v.string(),
    at: v.number(),
  }).index("by_bucket_at", ["bucket", "at"]),

  stats: defineTable({
    key: v.string(),
    count: v.number(),
  }).index("by_key", ["key"]),
});
