import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireSubject, subjectOf } from "./lib/access.ts";
import { cardCache, cardFor } from "./lib/cards.ts";
import { bump, STAT } from "./lib/counters.ts";
import { imagesBase, imagesEnv, resolveRef } from "./lib/images.ts";
import { claimHandle as claimHandleCore, profileOf, setPublished as setPublishedCore, updateProfile, visibleProfile } from "./lib/profilesCore.ts";
import { done } from "./lib/result.ts";

// Profiles and public shelves, thin wrappers over convex/lib/profilesCore.ts.

const env = () => ({ PUBLISHING: process.env.PUBLISHING });

export const claimHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    return await claimHandleCore(ctx.db, who.subject, args.handle, Date.now());
  },
});

export const update = mutation({
  args: { displayName: v.optional(v.string()), bio: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    return await updateProfile(ctx.db, who.subject, args, Date.now());
  },
});

export const setPublished = mutation({
  args: { published: v.boolean() },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    return await setPublishedCore(ctx.db, who.subject, args.published, Date.now(), env());
  },
});

/** /u/?handle. v.any() so a handle of the wrong type is answered null like every other refusal. */
export const byHandle = query({
  args: { handle: v.any() },
  handler: async (ctx, args) => {
    const seen = await visibleProfile(ctx.db, await subjectOf(ctx), args.handle, env());
    if (!seen) return null;
    const { profile, owner } = seen;
    const base = imagesBase(imagesEnv());
    const cache = cardCache();
    const shelf: Record<string, any[]> = { owned: [], wanted: [], had: [] };
    for (const item of await ctx.db.query("shelfItems").withIndex("by_subject", (q) => q.eq("subject", profile.subject)).take(2000)) {
      const mug = await ctx.db.get(item.mugId);
      if (!mug || mug.status !== "published") continue;
      shelf[item.state].push({ note: owner ? item.note ?? null : null, addedAt: item.createdAt, mug: await cardFor(ctx, mug, cache, base) });
    }
    for (const list of Object.values(shelf)) list.sort((a, b) => b.addedAt - a.addedAt);
    const photos = [];
    for (const photo of await ctx.db.query("photos").withIndex("by_subject", (q) => q.eq("subject", profile.subject)).order("desc").take(40)) {
      if (photo.status !== "visible" && !owner) continue;
      const mug = await ctx.db.get(photo.mugId);
      const image = await resolveRef(ctx.storage, photo.image, base);
      if (mug && image) photos.push({ image, caption: photo.caption ?? null, status: owner ? photo.status : undefined, mug: { slug: mug.slug, name: mug.name } });
    }
    return {
      handle: profile.handle,
      name: profile.displayName ?? profile.handle,
      bio: profile.bio ?? null,
      published: profile.published,
      owner,
      ownedCount: profile.ownedCount,
      wantedCount: profile.wantedCount,
      shelf,
      photos,
    };
  },
});

/**
 * Removes the caller's shelf, photos and profile, putting every counter back.
 * Photo files are deleted by a scheduled action, because storage and R2 are
 * outside the transaction.
 */
export const deleteMyData = mutation({
  args: {},
  handler: async (ctx) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const subject = who.subject;
    let removed = 0;
    for (const item of await ctx.db.query("shelfItems").withIndex("by_subject", (q) => q.eq("subject", subject)).take(4000)) {
      const mug = await ctx.db.get(item.mugId);
      if (mug) {
        await ctx.db.patch(mug._id, {
          ownedCount: Math.max(0, mug.ownedCount - (item.state === "owned" ? 1 : 0)),
          wantedCount: Math.max(0, mug.wantedCount - (item.state === "wanted" ? 1 : 0)),
        });
      }
      if (item.state === "owned") await bump(ctx.db, STAT.owned, -1);
      if (item.state === "wanted") await bump(ctx.db, STAT.wanted, -1);
      await ctx.db.delete(item._id);
      removed++;
    }
    for (const photo of await ctx.db.query("photos").withIndex("by_subject", (q) => q.eq("subject", subject)).take(1000)) {
      await ctx.scheduler.runAfter(0, internal.images.forget, { image: photo.image });
      await ctx.db.delete(photo._id);
    }
    const profile = await profileOf(ctx.db, subject);
    if (profile) {
      if (profile.published) await bump(ctx.db, STAT.collectors, -1);
      await ctx.db.delete(profile._id);
    }
    return done({ removed });
  },
});
