import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSubject, subjectOf } from "./lib/access.ts";
import { cardCache, cardFor } from "./lib/cards.ts";
import { imagesBase, imagesEnv } from "./lib/images.ts";
import { profileOf, publishingOpen } from "./lib/profilesCore.ts";
import { setShelfState, updateShelfItem } from "./lib/shelfCore.ts";

// A collector's own shelf. Thin wrappers over convex/lib/shelfCore.ts; the
// caller is always ctx.auth, never an id the browser sends.

const stateArg = v.union(v.literal("owned"), v.literal("wanted"), v.literal("had"), v.null());

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const subject = await subjectOf(ctx);
    if (!subject) return null;
    const profile = await profileOf(ctx.db, subject);
    const base = imagesBase(imagesEnv());
    const cache = cardCache();
    const items = [];
    let totalMl = 0;
    const brands = new Set<string>();
    for (const item of await ctx.db.query("shelfItems").withIndex("by_subject", (q) => q.eq("subject", subject)).take(2000)) {
      const mug = await ctx.db.get(item.mugId);
      if (!mug) continue;
      const card = await cardFor(ctx, mug, cache, base);
      if (item.state === "owned") {
        if (mug.capacityMl) totalMl += mug.capacityMl;
        if (card.brand) brands.add(card.brand.slug);
      }
      items.push({
        state: item.state,
        note: item.note ?? null,
        condition: item.condition ?? null,
        pricePaid: item.pricePaid ?? null,
        currency: item.currency ?? null,
        acquiredOn: item.acquiredOn ?? null,
        addedAt: item.createdAt,
        hidden: mug.status !== "published",
        mug: card,
      });
    }
    items.sort((a, b) => b.addedAt - a.addedAt);
    return {
      profile: profile
        ? {
            handle: profile.handle ?? null,
            displayName: profile.displayName ?? null,
            bio: profile.bio ?? null,
            published: profile.published,
            suspended: profile.suspended,
          }
        : null,
      publishingOpen: publishingOpen({ PUBLISHING: process.env.PUBLISHING }),
      stats: {
        owned: items.filter((i) => i.state === "owned").length,
        wanted: items.filter((i) => i.state === "wanted").length,
        had: items.filter((i) => i.state === "had").length,
        totalMl,
        brands: brands.size,
      },
      items,
    };
  },
});

export const set = mutation({
  args: { slug: v.string(), state: stateArg },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const mug = await ctx.db.query("mugs").withIndex("by_slug", (q) => q.eq("slug", args.slug)).unique();
    if (!mug) return { ok: false, code: "no-mug", message: "That mug is not in the catalogue." };
    return await setShelfState(ctx.db, { subject: who.subject, mugId: mug._id, state: args.state, now: Date.now() });
  },
});

export const update = mutation({
  args: {
    slug: v.string(),
    note: v.optional(v.union(v.string(), v.null())),
    condition: v.optional(v.union(v.string(), v.null())),
    pricePaid: v.optional(v.union(v.number(), v.string(), v.null())),
    currency: v.optional(v.union(v.string(), v.null())),
    acquiredOn: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const mug = await ctx.db.query("mugs").withIndex("by_slug", (q) => q.eq("slug", args.slug)).unique();
    if (!mug) return { ok: false, code: "no-mug", message: "That mug is not in the catalogue." };
    const { slug, ...patch } = args;
    return await updateShelfItem(ctx.db, { subject: who.subject, mugId: mug._id, patch, now: Date.now() });
  },
});
