import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { featuredKey } from "./lib/catalogue.ts";

// The longest rate window is 30 days (convex/lib/limits.ts), so nothing older
// than 31 days can matter. Oldest first by creation time, bounded per run.
export const sweepRate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 31 * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const row of await ctx.db.query("rateEvents").order("asc").take(1000)) {
      if (row.at >= cutoff) break;
      await ctx.db.delete(row._id);
      removed++;
    }
    return removed;
  },
});

// A16 arrived after the first mugs: give each mug its "3D and shaped first"
// key. Derived data only, so no counter moves and updatedAt is left alone.
// Idempotent; run it until it reports done.
//   npx convex run --prod maintenance:backfillFeatured
export const backfillFeatured = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("mugs").paginate({ numItems: 200, cursor: args.cursor ?? null });
    let updated = 0;
    for (const mug of page.page) {
      const key = featuredKey(mug.style, mug.publishedAt);
      if (mug.featured === key) continue;
      await ctx.db.patch(mug._id, { featured: key });
      updated++;
    }
    return { updated, done: page.isDone, cursor: page.continueCursor };
  },
});
