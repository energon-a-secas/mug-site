import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin, requireSubject } from "./lib/access.ts";
import { fail } from "./lib/result.ts";
import { createSuggestion, decideSuggestion, pendingSuggestions } from "./lib/suggestionsCore.ts";

// A17: corrections to a mug's labels, proposed by any signed-in collector and
// applied only when an admin approves them. The rules live in
// convex/lib/suggestionsCore.ts, where tests/convex-suggestions.test.mjs runs them.

export const create = mutation({
  args: { slug: v.string(), changes: v.any(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const mug = await ctx.db.query("mugs").withIndex("by_slug", (q) => q.eq("slug", args.slug)).unique();
    if (!mug) return fail("not-found", "That mug is not in the catalogue.");
    return await createSuggestion(ctx.db, { subject: who.subject, mug, changes: args.changes, note: args.note, now: Date.now() });
  },
});

export const pending = query({
  args: {},
  handler: async (ctx) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return null;
    return await pendingSuggestions(ctx.db, 100);
  },
});

export const decide = mutation({
  args: { id: v.id("suggestions"), approve: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    return await decideSuggestion(ctx.db, { id: args.id, approve: args.approve, admin: who.subject, reason: args.reason, now: Date.now() });
  },
});
