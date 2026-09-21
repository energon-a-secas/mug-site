import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { LIMITS } from "../shared/contract.js";
import { fold } from "../shared/extract/names.js";
import { requireAdmin } from "./lib/access.ts";
import { imagesBase, imagesEnv, resolveRef } from "./lib/images.ts";
import { applyMugPatch, cleanEdits, saveMugEdits } from "./lib/mugCore.ts";
import { done, fail } from "./lib/result.ts";

// The admin's catalogue editor.

async function summary(ctx: any, mug: any) {
  const brand = mug.brandId ? await ctx.db.get(mug.brandId) : null;
  return {
    id: mug._id,
    slug: mug.slug,
    name: mug.name,
    brand: brand ? brand.name : null,
    style: mug.style,
    status: mug.status,
    imageState: mug.imageState,
    images: mug.images.length,
    pendingImages: mug.pendingImages.length,
    ownedCount: mug.ownedCount,
    wantedCount: mug.wantedCount,
    updatedAt: mug.updatedAt,
  };
}

export const adminList = query({
  args: {
    paginationOpts: paginationOptsValidator,
    q: v.optional(v.string()),
    status: v.optional(v.union(v.literal("published"), v.literal("hidden"))),
    imageState: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return { page: [], isDone: true, continueCursor: "" };
    const text = fold(args.q || "").replace(/[^a-z0-9 ]+/g, " ").trim();
    let result;
    if (text.length >= 2) {
      result = await ctx.db
        .query("mugs")
        .withSearchIndex("search", (s) => (args.status ? s.search("searchText", text).eq("status", args.status) : s.search("searchText", text)))
        .paginate(args.paginationOpts);
    } else if (args.imageState) {
      result = await ctx.db.query("mugs").withIndex("by_imageState", (q) => q.eq("imageState", args.imageState as any)).order("desc").paginate(args.paginationOpts);
    } else {
      result = await ctx.db.query("mugs").withIndex("by_status_published", (q) => q.eq("status", args.status ?? "published")).order("desc").paginate(args.paginationOpts);
    }
    const page = [];
    for (const mug of result.page) page.push(await summary(ctx, mug));
    return { ...result, page };
  },
});

export const adminGet = query({
  args: { id: v.id("mugs") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return null;
    const mug = await ctx.db.get(args.id);
    if (!mug) return null;
    const base = imagesBase(imagesEnv());
    const images = [];
    for (const ref of mug.images) {
      images.push({ store: ref.store, hasThumb: !!ref.thumb, source: ref.source ?? null, w: ref.w ?? null, h: ref.h ?? null, resolved: await resolveRef(ctx.storage, ref, base) });
    }
    const brand = mug.brandId ? await ctx.db.get(mug.brandId) : null;
    const franchise = mug.franchiseId ? await ctx.db.get(mug.franchiseId) : null;
    const sources = (await ctx.db.query("mugSources").withIndex("by_mug", (q) => q.eq("mugId", mug._id)).take(50)).map((s) => ({
      key: s.key,
      url: s.url ?? null,
      lastSeenAt: s.lastSeenAt,
      seen: s.seen,
    }));
    return { ...mug, brand: brand ? brand.name : null, franchise: franchise ? franchise.name : null, images, sources };
  },
});

export const save = mutation({
  args: { id: v.id("mugs"), edits: v.optional(v.any()), imageOrder: v.optional(v.array(v.number())) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const mug = await ctx.db.get(args.id);
    if (!mug) return fail("not-found", "That mug no longer exists.");
    const checked = cleanEdits(args.edits);
    if (!checked.ok) return checked;
    const now = Date.now();
    const { images: addImages, ...edits } = checked.edits;
    let current = await saveMugEdits(ctx.db, mug, edits, now);
    if (args.imageOrder) {
      const order = args.imageOrder;
      if (new Set(order).size !== order.length || order.some((i) => !Number.isInteger(i) || i < 0 || i >= current.images.length)) {
        return fail("bad-order", "The image order does not match the mug's images.");
      }
      const images = order.map((i) => current.images[i]);
      current = await applyMugPatch(ctx.db, current, { images, imageState: images.length ? (images.every((r: any) => r.thumb) ? "ok" : "thumbs") : current.pendingImages.length ? current.imageState : "none" }, now);
    }
    if (addImages && addImages.length) {
      const known = new Set([...current.pendingImages, ...current.images.map((r: any) => r.source)]);
      const fresh = addImages.filter((url) => !known.has(url));
      if (fresh.length) {
        await applyMugPatch(ctx.db, current, { pendingImages: [...current.pendingImages, ...fresh].slice(0, LIMITS.images), imageState: "pending" }, now);
        await ctx.scheduler.runAfter(0, internal.images.mirrorMug, { mugId: mug._id });
      }
    }
    return done({ slug: current.slug });
  },
});

/** The merge picker: a few mugs whose names match what the admin typed. */
export const pick = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return [];
    const text = fold(args.q).replace(/[^a-z0-9 ]+/g, " ").trim();
    if (text.length < 2) return [];
    const out = [];
    for (const mug of await ctx.db.query("mugs").withSearchIndex("search", (s) => s.search("searchText", text)).take(8)) {
      out.push(await summary(ctx, mug));
    }
    return out;
  },
});
