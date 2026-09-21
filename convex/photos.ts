import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation } from "./_generated/server";
import { isAdmin, requireSubject } from "./lib/access.ts";
import { checkRate, rateFailure, recordRate } from "./lib/rate.ts";
import { done, fail } from "./lib/result.ts";
import { cleanText } from "./lib/util.ts";

// A collector's own photo of a mug they own. The browser resizes it to 1600 px
// before upload (C4.4); it waits as "pending" until an admin approves it, and
// only then moves to R2 (C9).

const MAX_BYTES = 4 * 1024 * 1024;

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const verdict = await checkRate(ctx.db, who.subject, "photo.upload", Date.now());
    if (!verdict.allowed) return rateFailure(verdict, "photo uploads");
    return done({ uploadUrl: await ctx.storage.generateUploadUrl() });
  },
});

export const add = mutation({
  args: { slug: v.string(), storageId: v.id("_storage"), caption: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const now = Date.now();
    const file = await ctx.db.system.get(args.storageId);
    const reject = async (code: string, message: string) => {
      await ctx.storage.delete(args.storageId);
      return fail(code, message);
    };
    if (!file) return fail("no-file", "The upload did not arrive. Try again.");
    if (!/^image\/(jpeg|png|webp)$/.test(file.contentType || "")) return await reject("bad-type", "Photos have to be JPEG, PNG or WebP.");
    if (file.size > MAX_BYTES) return await reject("too-large", "That photo is over 4 MB after resizing.");
    const mug = await ctx.db.query("mugs").withIndex("by_slug", (q) => q.eq("slug", args.slug)).unique();
    if (!mug) return await reject("no-mug", "That mug is not in the catalogue.");
    const item = await ctx.db
      .query("shelfItems")
      .withIndex("by_subject_mug", (q) => q.eq("subject", who.subject).eq("mugId", mug._id))
      .unique();
    if (!item || item.state === "wanted") return await reject("not-owned", "Photos are for mugs you own or have owned.");
    const verdict = await checkRate(ctx.db, who.subject, "photo.upload", now);
    if (!verdict.allowed) return await reject("rate-limited", rateFailure(verdict, "photo uploads").message);
    await ctx.db.insert("photos", {
      subject: who.subject,
      mugId: mug._id,
      image: { store: "convex", key: args.storageId },
      caption: cleanText(args.caption, 140) || undefined,
      status: "pending",
      createdAt: now,
    });
    await recordRate(ctx.db, who.subject, "photo.upload", now);
    return done({ status: "pending" });
  },
});

export const remove = mutation({
  args: { photoId: v.id("photos") },
  handler: async (ctx, args) => {
    const who = await requireSubject(ctx);
    if (!who.ok) return who;
    const photo = await ctx.db.get(args.photoId);
    if (!photo) return fail("not-found", "That photo is already gone.");
    if (photo.subject !== who.subject && !(await isAdmin(ctx))) return fail("not-yours", "That photo is not yours.");
    await ctx.db.delete(photo._id);
    await ctx.scheduler.runAfter(0, internal.images.forget, { image: photo.image });
    return done();
  },
});
