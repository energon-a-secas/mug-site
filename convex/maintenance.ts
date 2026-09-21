import { internalMutation } from "./_generated/server";

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
