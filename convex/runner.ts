import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { imageFailure, pendingIndex } from "./lib/runnerCore.ts";
import { checkRate, recordRate } from "./lib/rate.ts";
import { applyExtract, bumpRun, reNormalize, stageListing } from "./lib/stageCore.ts";

// What the runner's HTTP actions (convex/http.ts) do inside the database.
// Every listing the runner posts is normalised again here with via "runner",
// whatever the payload claims (docs/CONTRACTS.md C8).

export const queue = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit)));
    const items: any[] = [];
    for (const row of await ctx.db.query("staging").withIndex("by_status", (q) => q.eq("status", "needsLocal")).order("asc").take(limit)) {
      if (row.url) items.push({ id: row._id, kind: "page", url: row.url });
    }
    for (const mug of await ctx.db.query("mugs").withIndex("by_imageState", (q) => q.eq("imageState", "blocked")).take(limit)) {
      mug.pendingImages.forEach((url, index) => items.push({ id: `${mug._id}:${index}`, kind: "image", url, mugId: mug._id, index }));
    }
    return items.slice(0, limit);
  },
});

export const touch = internalMutation({
  args: { tokenId: v.id("runnerTokens"), prefix: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const subject = `runner:${args.prefix}`;
    const verdict = await checkRate(ctx.db, subject, "runner.request", now);
    if (!verdict.allowed) return false;
    await recordRate(ctx.db, subject, "runner.request", now);
    const token = await ctx.db.get(args.tokenId);
    if (token && (!token.lastUsedAt || now - token.lastUsedAt > 60000)) await ctx.db.patch(token._id, { lastUsedAt: now });
    return true;
  },
});

export const ingest = internalMutation({
  args: {
    id: v.string(),
    url: v.optional(v.string()),
    listing: v.optional(v.any()),
    error: v.optional(v.object({ code: v.string(), message: v.string(), retryable: v.optional(v.boolean()) })),
  },
  handler: async (ctx, args) => {
    const image = /^([^:]+):(\d+)$/.exec(args.id);
    if (image) return await imageFailure(ctx.db, image[1], Number(image[2]), args.url, args.error, Date.now());
    const stagingId = ctx.db.normalizeId("staging", args.id);
    if (!stagingId) return { ok: false, code: "bad-id", message: "That is not a queue item id." };
    const now = Date.now();
    let listing;
    let error = args.error;
    if (args.listing !== undefined) {
      const checked = reNormalize(args.listing, "runner", now);
      if (checked.ok) listing = checked.listing;
      else error = { code: "NOT_A_PRODUCT", message: checked.message };
    }
    if (!listing && !error) return { ok: false, code: "bad-body", message: "Send a listing or an error." };
    const result = await applyExtract(ctx.db, { stagingId, listing, error, now });
    return { ok: result.outcome !== "not-open", status: result.outcome, match: result.match ?? null };
  },
});

export const startScan = internalMutation({
  args: { sourceSlug: v.string(), prefix: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", args.sourceSlug)).unique();
    if (!source) return { ok: false, code: "not-found", message: `No source ${args.sourceSlug}.` };
    if (!source.enabled) return { ok: false, code: "disabled", message: "That source is disabled." };
    if (source.adapter === "manual") return { ok: false, code: "manual", message: "A manual source has nothing to scan." };
    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      sourceId: source._id, kind: "runner", target: source.entryUrls[0] || source.baseUrl, trigger: "runner", status: "discovering",
      entryIndex: 0, page: 1, retries: 0, discovered: 0, staged: 0, unchanged: 0, skipped: 0, needsLocal: 0, failed: 0,
      startedBy: `runner:${args.prefix}`, createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(source._id, { lastRunId: runId, lastRunAt: now });
    const brand = source.brandId ? await ctx.db.get(source.brandId) : null;
    return {
      ok: true,
      runId,
      source: {
        slug: source.slug,
        name: source.name,
        adapter: source.adapter,
        baseUrl: source.baseUrl,
        entryUrls: source.entryUrls,
        include: source.include,
        exclude: source.exclude,
        brand: brand ? brand.name : null,
        currency: source.currency ?? null,
      },
    };
  },
});

async function runnerRun(ctx: any, raw: string) {
  const runId = ctx.db.normalizeId("runs", raw);
  const run = runId ? await ctx.db.get(runId) : null;
  return run && run.kind === "runner" && run.status === "discovering" ? run : null;
}

export const stage = internalMutation({
  args: { runId: v.string(), listings: v.array(v.any()) },
  handler: async (ctx, args) => {
    const run = await runnerRun(ctx, args.runId);
    if (!run) return { ok: false, code: "bad-run", message: "That run is not an open runner scan." };
    if (args.listings.length > 50) return { ok: false, code: "too-many", message: "Stage at most 50 listings per request." };
    const now = Date.now();
    const counts = { staged: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const raw of args.listings) {
      const checked = reNormalize(raw, "runner", now);
      if (!checked.ok) {
        counts.failed++;
        continue;
      }
      const { outcome } = await stageListing(ctx.db, { listing: checked.listing, runId: run._id, sourceId: run.sourceId, now });
      if (outcome === "staged" || outcome === "updated") counts.staged++;
      else if (outcome === "skipped") counts.skipped++;
      else counts.unchanged++;
    }
    await bumpRun(ctx.db, run._id, { discovered: args.listings.length, failed: counts.failed }, now);
    return { ok: true, ...counts };
  },
});

export const finish = internalMutation({
  args: { runId: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await runnerRun(ctx, args.runId);
    if (!run) return { ok: false, code: "bad-run", message: "That run is not an open runner scan." };
    await ctx.db.patch(run._id, {
      status: args.error ? "failed" : "ready",
      error: args.error ? args.error.slice(0, 500) : undefined,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const imageTarget = internalQuery({
  args: { mugId: v.string(), index: v.number(), url: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const mugId = ctx.db.normalizeId("mugs", args.mugId);
    const mug = mugId ? await ctx.db.get(mugId) : null;
    if (!mug || mug.imageState !== "blocked") return null;
    const index = pendingIndex(mug, args.index, args.url);
    return index >= 0 ? { mugId: mug._id, index } : null;
  },
});
