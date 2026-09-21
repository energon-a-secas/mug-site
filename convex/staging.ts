import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./lib/access.ts";
import { approveStaging, mergeStaging, rejectStaging } from "./lib/reviewCore.ts";
import { done, fail } from "./lib/result.ts";

// The review queue (docs/CONTRACTS.md C7). Thin wrappers over
// convex/lib/reviewCore.ts; approving schedules image mirroring when the
// mug gained images to fetch.

const STATUSES = ["queued", "pending", "needsLocal", "approved", "rejected", "failed"] as const;

export const list = query({
  args: { status: v.string(), paginationOpts: paginationOptsValidator, runId: v.optional(v.id("runs")) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    const empty = { page: [], isDone: true, continueCursor: "" };
    if (!who.ok || !STATUSES.includes(args.status as any)) return empty;
    const status = args.status as (typeof STATUSES)[number];
    const result = args.runId
      ? await ctx.db.query("staging").withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", status)).paginate(args.paginationOpts)
      : await ctx.db.query("staging").withIndex("by_status", (q) => q.eq("status", status)).order("desc").paginate(args.paginationOpts);
    const sources = new Map<string, any>();
    const page = [];
    for (const row of result.page) {
      let source = null;
      if (row.sourceId) {
        if (!sources.has(row.sourceId)) sources.set(row.sourceId, await ctx.db.get(row.sourceId));
        const s = sources.get(row.sourceId);
        source = s ? { slug: s.slug, name: s.name } : null;
      }
      const matched = row.match?.mugId ? await ctx.db.get(row.match.mugId) : null;
      const result = row.mugId ? await ctx.db.get(row.mugId) : null;
      page.push({
        id: row._id,
        key: row.key,
        url: row.url ?? null,
        status: row.status,
        listing: row.listing ?? null,
        match: row.match
          ? { ...row.match, mug: matched ? { id: matched._id, slug: matched.slug, name: matched.name } : null }
          : null,
        error: row.error ?? null,
        attempts: row.attempts,
        source,
        mug: result ? { slug: result.slug, name: result.name } : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const approve = mutation({
  args: { id: v.id("staging"), edits: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const result: any = await approveStaging(ctx.db, { stagingId: args.id, edits: args.edits, subject: who.subject, now: Date.now() });
    if (result.ok && result.scheduleImages) await ctx.scheduler.runAfter(0, internal.images.mirrorMug, { mugId: result.mugId });
    return result;
  },
});

export const merge = mutation({
  args: { id: v.id("staging"), mugId: v.id("mugs"), edits: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const result: any = await mergeStaging(ctx.db, { stagingId: args.id, mugId: args.mugId, edits: args.edits, subject: who.subject, now: Date.now() });
    if (result.ok && result.scheduleImages) await ctx.scheduler.runAfter(0, internal.images.mirrorMug, { mugId: result.mugId });
    return result;
  },
});

export const reject = mutation({
  args: { id: v.id("staging") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    return await rejectStaging(ctx.db, { stagingId: args.id, subject: who.subject, now: Date.now() });
  },
});

/**
 * Approve many at once, but only the unambiguous ones: new listings the
 * verdict calls a mug. Anything "similar", "changed" or "maybe" still needs
 * a person to look at it.
 */
export const bulkApprove = mutation({
  args: { ids: v.array(v.id("staging")) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    if (args.ids.length > 25) return fail("too-many", "Approve at most 25 at a time.");
    const now = Date.now();
    let approved = 0;
    const skipped: string[] = [];
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row || row.status !== "pending" || row.match?.kind !== "new" || row.listing?.isMug.verdict !== "yes") {
        skipped.push(id);
        continue;
      }
      const result: any = await approveStaging(ctx.db, { stagingId: id, subject: who.subject, now });
      if (!result.ok) {
        skipped.push(id);
        continue;
      }
      approved++;
      if (result.scheduleImages) await ctx.scheduler.runAfter(approved * 2000, internal.images.mirrorMug, { mugId: result.mugId });
    }
    return done({ approved, skipped });
  },
});

/** Send a failed or blocked page back through the queue once more. */
export const retry = mutation({
  args: { id: v.id("staging") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const row = await ctx.db.get(args.id);
    if (!row || !row.url || !["failed", "needsLocal"].includes(row.status)) return fail("not-retryable", "Only a failed or runner-bound page with a URL can be retried.");
    await ctx.db.patch(row._id, { status: "needsLocal", attempts: 0, error: undefined, updatedAt: Date.now() });
    return done({ status: "needsLocal" });
  },
});
