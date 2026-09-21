import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./lib/access.ts";
import { proxyConfigured, proxyEnv } from "./lib/proxy.ts";
import { done, fail } from "./lib/result.ts";

// Scans: started here, carried out by convex/scan.ts on the scheduler.

const ACTIVE = ["discovering", "extracting"];

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db.query("runs").withIndex("by_created").order("desc").paginate(args.paginationOpts);
    const page = [];
    for (const run of result.page) {
      const source = run.sourceId ? await ctx.db.get(run.sourceId) : null;
      page.push({ ...run, source: source ? { slug: source.slug, name: source.name } : null });
    }
    return { ...result, page };
  },
});

export const start = mutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const source = await ctx.db.get(args.sourceId);
    if (!source) return fail("not-found", "That source no longer exists.");
    if (!source.enabled) return fail("disabled", "Enable the source first.");
    if (source.adapter === "manual") return fail("manual", "A manual source has nothing to scan: paste or type its mugs instead.");
    if (source.fetchVia === "local") {
      return fail("use-runner", `This shop refuses cloud fetching. On your workstation run: node runner/mug-runner.mjs scan ${source.slug}`);
    }
    if (!proxyConfigured(proxyEnv())) return fail("proxy-not-configured", "MUG_PROXY_URL and MUG_PROXY_TOKEN are not set, so the cloud cannot fetch. Use the runner.");
    if (source.lastRunId) {
      const last = await ctx.db.get(source.lastRunId);
      if (last && ACTIVE.includes(last.status)) return fail("run-active", "A scan of this source is already running.");
    }
    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      sourceId: source._id,
      kind: "scan",
      target: source.entryUrls[0] || source.baseUrl,
      trigger: "manual",
      status: "discovering",
      entryIndex: 0,
      page: 1,
      retries: 0,
      discovered: 0,
      staged: 0,
      unchanged: 0,
      skipped: 0,
      needsLocal: 0,
      failed: 0,
      startedBy: who.subject,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(source._id, { lastRunId: runId, lastRunAt: now });
    await ctx.scheduler.runAfter(0, internal.scan.discover, { runId });
    return done({ runId });
  },
});

export const cancel = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const run = await ctx.db.get(args.runId);
    if (!run || !ACTIVE.includes(run.status)) return fail("not-active", "That scan is not running.");
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "cancelled", updatedAt: now });
    for (const row of await ctx.db.query("staging").withIndex("by_run_status", (q) => q.eq("runId", run._id).eq("status", "queued")).take(1000)) {
      await ctx.db.patch(row._id, { status: "failed", error: { code: "cancelled", message: "The scan was cancelled." }, updatedAt: now });
    }
    return done();
  },
});
