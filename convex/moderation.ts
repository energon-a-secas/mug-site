import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./lib/access.ts";
import { bump, STAT } from "./lib/counters.ts";
import { imagesBase, imagesEnv, resolveRef } from "./lib/images.ts";
import { normalizeHandle } from "./lib/handles.ts";
import { profileOf } from "./lib/profilesCore.ts";
import { done, fail } from "./lib/result.ts";

// Photos wait here before anyone else can see them, and a shelf can be
// suspended (docs/CONTRACTS.md C9).

export const pendingPhotos = query({
  args: {},
  handler: async (ctx) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return null;
    const base = imagesBase(imagesEnv());
    const out = [];
    for (const photo of await ctx.db.query("photos").withIndex("by_status", (q) => q.eq("status", "pending")).order("asc").take(50)) {
      const mug = await ctx.db.get(photo.mugId);
      const owner = await profileOf(ctx.db, photo.subject);
      out.push({
        id: photo._id,
        image: await resolveRef(ctx.storage, photo.image, base),
        caption: photo.caption ?? null,
        createdAt: photo.createdAt,
        mug: mug ? { slug: mug.slug, name: mug.name } : null,
        owner: owner ? { handle: owner.handle ?? null, name: owner.displayName ?? null, published: owner.published } : null,
      });
    }
    return out;
  },
});

export const reviewPhoto = mutation({
  args: { photoId: v.id("photos"), verdict: v.union(v.literal("approve"), v.literal("reject")) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const photo = await ctx.db.get(args.photoId);
    if (!photo || photo.status !== "pending") return fail("not-pending", "That photo is not waiting for review.");
    const now = Date.now();
    if (args.verdict === "approve") {
      await ctx.db.patch(photo._id, { status: "visible", reviewedAt: now });
      await ctx.scheduler.runAfter(0, internal.images.movePhoto, { photoId: photo._id });
    } else {
      await ctx.db.patch(photo._id, { status: "rejected", reviewedAt: now });
      await ctx.scheduler.runAfter(0, internal.images.forget, { image: photo.image });
    }
    return done();
  },
});

export const suspend = mutation({
  args: { handle: v.string(), suspended: v.boolean() },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const handle = normalizeHandle(args.handle);
    const profile = await ctx.db.query("profiles").withIndex("by_handle", (q) => q.eq("handle", handle)).first();
    if (!profile) return fail("not-found", "No shelf has that address.");
    if (profile.suspended === args.suspended) return done();
    await ctx.db.patch(profile._id, { suspended: args.suspended, updatedAt: Date.now() });
    if (profile.published) await bump(ctx.db, STAT.collectors, args.suspended ? -1 : 1);
    return done();
  },
});
