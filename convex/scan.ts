import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { callProxy, proxyEnv } from "./lib/proxy.ts";
import { applyExtract, bumpRun, RETRY_CODES, reNormalize, stageListing, stageUrl } from "./lib/stageCore.ts";

// A scan, carried out on the scheduler (docs/CONTRACTS.md C2, C3, C10.5).
// One Worker call per scheduled action, so every invocation stays inside the
// Worker's subrequest budget and requests to one shop are spaced PACE_MS
// apart. A cancelled run stops at its next step, because every step re-reads
// its status first.

const PACE_MS = 1500;
const RETRY_MS = 15000;
const MAX_PAGES = 40;
const FATAL = ["UNAUTHORIZED", "NOT_CONFIGURED", "ROBOTS_DISALLOWED", "URL_NOT_ALLOWED", "BAD_REQUEST"];

export const context = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !run.sourceId) return null;
    const source = await ctx.db.get(run.sourceId);
    if (!source) return null;
    // A6: the source's own brand, because a shop's vendor field is often the licence.
    const brand = source.brandId ? await ctx.db.get(source.brandId) : null;
    return { run, source, brand: brand ? brand.name : null };
  },
});

export const discover = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.scan.context, { runId: args.runId });
    if (!found || found.run.status !== "discovering") return;
    const { run, source, brand } = found;
    const entries = source.entryUrls.length ? source.entryUrls : [source.baseUrl];
    if (run.entryIndex >= entries.length) {
      await ctx.runMutation(internal.scan.finishDiscovery, { runId: args.runId });
      return;
    }
    const answer = await callProxy(proxyEnv(), "/v1/discover", {
      json: {
        adapter: source.adapter,
        url: run.nextUrl || entries[run.entryIndex],
        page: run.page,
        include: source.include,
        exclude: source.exclude,
        ...(brand ? { brand } : {}),
      },
    });
    if (!answer.ok) {
      await ctx.runMutation(internal.scan.discoverFailed, { runId: args.runId, code: answer.code, message: answer.message });
      return;
    }
    await ctx.runMutation(internal.scan.discovered, {
      runId: args.runId,
      listings: answer.listings ?? [],
      urls: answer.urls ?? [],
      skipped: answer.skipped ?? 0,
      next: answer.next ?? null,
    });
  },
});

export const discovered = internalMutation({
  args: { runId: v.id("runs"), listings: v.array(v.any()), urls: v.array(v.string()), skipped: v.number(), next: v.any() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "discovering") return;
    const now = Date.now();
    let bad = 0;
    for (const raw of args.listings) {
      const checked = reNormalize(raw, "worker", now);
      if (!checked.ok) {
        bad++;
        continue;
      }
      await stageListing(ctx.db, { listing: checked.listing, runId: run._id, sourceId: run.sourceId, now });
    }
    for (const url of args.urls) await stageUrl(ctx.db, { url, runId: run._id, sourceId: run.sourceId, now });
    await bumpRun(ctx.db, run._id, { discovered: args.listings.length + args.urls.length, skipped: args.skipped, failed: bad }, now);

    const next = args.next && typeof args.next === "object" ? args.next : null;
    const patch: Record<string, unknown> = { retries: 0, updatedAt: now };
    if (next && run.page < MAX_PAGES) {
      patch.page = run.page + 1;
      patch.nextUrl = typeof next.url === "string" ? next.url : undefined;
    } else {
      patch.entryIndex = run.entryIndex + 1;
      patch.page = 1;
      patch.nextUrl = undefined;
    }
    await ctx.db.patch(run._id, patch);
    await ctx.scheduler.runAfter(PACE_MS, internal.scan.discover, { runId: run._id });
  },
});

export const discoverFailed = internalMutation({
  args: { runId: v.id("runs"), code: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "discovering") return;
    const now = Date.now();
    if (RETRY_CODES.includes(args.code) && run.retries < 2) {
      await ctx.db.patch(run._id, { retries: run.retries + 1, updatedAt: now });
      await ctx.scheduler.runAfter(RETRY_MS, internal.scan.discover, { runId: run._id });
      return;
    }
    const hint =
      args.code === "UPSTREAM_BLOCKED"
        ? " The shop refuses cloud fetching: set the source to fetch via local and run the runner."
        : args.code === "ROBOTS_DISALLOWED"
          ? " The shop's robots.txt refuses MugBot here, so this source is manual only."
          : "";
    if (FATAL.includes(args.code) || run.page === 1) {
      await ctx.db.patch(run._id, { status: "failed", error: `${args.code}: ${args.message}${hint}`.slice(0, 500), updatedAt: now });
      return;
    }
    // A later page failing ends this entry URL, not the whole scan.
    await ctx.db.patch(run._id, { entryIndex: run.entryIndex + 1, page: 1, nextUrl: undefined, retries: 0, error: `${args.code} on page ${run.page}`, updatedAt: now });
    await ctx.scheduler.runAfter(PACE_MS, internal.scan.discover, { runId: run._id });
  },
});

export const finishDiscovery = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "discovering") return;
    const queued = await ctx.db.query("staging").withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "queued")).first();
    await ctx.db.patch(run._id, { status: queued ? "extracting" : "ready", updatedAt: Date.now() });
    if (queued) await ctx.scheduler.runAfter(0, internal.scan.extractNext, { runId: run._id });
  },
});

export const nextQueued = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const row = await ctx.db.query("staging").withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "queued")).first();
    return { status: run.status, row: row ? { id: row._id, url: row.url } : null };
  },
});

export const extractNext = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const next = await ctx.runQuery(internal.scan.nextQueued, { runId: args.runId });
    if (!next || next.status !== "extracting") return;
    const found = await ctx.runQuery(internal.scan.context, { runId: args.runId });
    const brand = found?.brand;
    if (!next.row || !next.row.url) {
      await ctx.runMutation(internal.scan.finishExtract, { runId: args.runId });
      return;
    }
    const answer = await callProxy(proxyEnv(), "/v1/extract", { json: { url: next.row.url, ...(brand ? { brand } : {}) } });
    await ctx.runMutation(internal.scan.extracted, {
      runId: args.runId,
      stagingId: next.row.id,
      listing: answer.ok ? answer.listing : undefined,
      error: answer.ok ? undefined : { code: answer.code, message: answer.message },
    });
  },
});

export const extracted = internalMutation({
  args: { runId: v.id("runs"), stagingId: v.id("staging"), listing: v.optional(v.any()), error: v.optional(v.object({ code: v.string(), message: v.string() })) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "extracting") return;
    const now = Date.now();
    if (args.error && ["UNAUTHORIZED", "NOT_CONFIGURED"].includes(args.error.code)) {
      await ctx.db.patch(run._id, { status: "failed", error: `${args.error.code}: ${args.error.message}`.slice(0, 500), updatedAt: now });
      return;
    }
    let listing;
    let error = args.error;
    if (args.listing !== undefined) {
      const checked = reNormalize(args.listing, "worker", now);
      if (checked.ok) listing = checked.listing;
      else error = { code: "NOT_A_PRODUCT", message: checked.message };
    }
    const result = await applyExtract(ctx.db, { stagingId: args.stagingId, listing, error, now });
    await ctx.scheduler.runAfter(result.outcome === "retry" ? RETRY_MS : PACE_MS, internal.scan.extractNext, { runId: run._id });
  },
});

export const finishExtract = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run && run.status === "extracting") await ctx.db.patch(run._id, { status: "ready", updatedAt: Date.now() });
  },
});

/** Weekly: re-scan every watched cloud source that is not already running. */
export const cronWatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!process.env.MUG_PROXY_URL || !process.env.MUG_PROXY_TOKEN) return;
    const now = Date.now();
    for (const source of await ctx.db.query("sources").withIndex("by_watch", (q) => q.eq("watch", true).eq("enabled", true)).take(100)) {
      if (source.adapter === "manual" || source.fetchVia !== "cloud") continue;
      const last = source.lastRunId ? await ctx.db.get(source.lastRunId) : null;
      if (last && (last.status === "discovering" || last.status === "extracting")) continue;
      const runId = await ctx.db.insert("runs", {
        sourceId: source._id, kind: "scan", target: source.entryUrls[0] || source.baseUrl, trigger: "cron", status: "discovering",
        entryIndex: 0, page: 1, retries: 0, discovered: 0, staged: 0, unchanged: 0, skipped: 0, needsLocal: 0, failed: 0,
        createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(source._id, { lastRunId: runId, lastRunAt: now });
      // Stagger watched shops so the cron does not start them all at once.
      await ctx.scheduler.runAfter(0, internal.scan.discover, { runId });
    }
  },
});
