import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { LIMITS } from "../shared/contract.js";
import { adminList, requireAdmin } from "./lib/access.ts";
import { isAdminSubject } from "./lib/admin.ts";
import { fetchImageDirect } from "./lib/fallbackFetch.ts";
import { imagesBase, imagesEnv, resolveRef } from "./lib/images.ts";
import { callProxy, proxyConfigured, proxyEnv } from "./lib/proxy.ts";
import { done, fail } from "./lib/result.ts";

// Images (docs/CONTRACTS.md C4, A5). Originals are mirrored by the Worker into
// R2; when the Worker is not configured, this deployment fetches the image
// itself and keeps it in Convex storage, the last resort the brief allowed.
// A mug's imageState says what is left to do, and the admin page works from it.

type Ref = { store: "r2" | "convex"; key: string; w?: number; h?: number; thumb?: string; source?: string };

/** A5: Shopify's CDN serves any width on request, so its 480 px copy is the thumbnail. */
export function shopifyThumbUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const shopify = url.hostname === "cdn.shopify.com" || url.pathname.includes("/cdn/shop/");
  if (!shopify) return null;
  url.searchParams.set("width", "480");
  return url.toString();
}

function stateFor(images: Ref[], pending: string[], blocked: boolean): "none" | "pending" | "blocked" | "failed" | "thumbs" | "ok" {
  if (pending.length) return blocked ? "blocked" : "failed";
  if (!images.length) return "none";
  return images.every((ref) => ref.thumb) ? "ok" : "thumbs";
}

export const mugForImages = internalQuery({
  args: { mugId: v.id("mugs") },
  handler: async (ctx, args) => await ctx.db.get(args.mugId),
});

type MirrorOutcome = { ref: Ref } | { blocked: true } | { failed: string };

/** One remote image into R2 through the Worker, or into Convex storage without it. */
async function mirrorOne(ctx: any, url: string): Promise<MirrorOutcome> {
  const env = proxyEnv();
  const thumbUrl = shopifyThumbUrl(url);
  if (proxyConfigured(env)) {
    const answer = await callProxy(env, "/v1/images/mirror", { json: { url } });
    if (answer.ok) {
      const ref: Ref = { store: "r2", key: answer.key, source: url };
      if (answer.w) ref.w = answer.w;
      if (answer.h) ref.h = answer.h;
      if (thumbUrl) {
        const thumb = await callProxy(env, "/v1/images/mirror", { json: { url: thumbUrl } });
        if (thumb.ok) ref.thumb = thumb.key;
      }
      return { ref };
    }
    if (answer.code === "UPSTREAM_BLOCKED") return { blocked: true };
    if (answer.code !== "NOT_CONFIGURED") return { failed: answer.code };
  }
  // C4.3 fallback: fetched here, stored in Convex.
  const direct = await fetchImageDirect(url);
  if (!direct.ok) return direct.code === "UPSTREAM_BLOCKED" ? { blocked: true } : { failed: direct.code };
  const key = await ctx.storage.store(direct.blob);
  const ref: Ref = { store: "convex", key, source: url };
  if (direct.w) ref.w = direct.w;
  if (direct.h) ref.h = direct.h;
  if (thumbUrl) {
    const thumb = await fetchImageDirect(thumbUrl);
    if (thumb.ok) ref.thumb = await ctx.storage.store(thumb.blob);
  }
  return { ref };
}

/** Every pending image of one mug. Scheduled after approval and by retry. */
export const mirrorMug = internalAction({
  args: { mugId: v.id("mugs") },
  handler: async (ctx, args) => {
    const mug = await ctx.runQuery(internal.images.mugForImages, { mugId: args.mugId });
    if (!mug || !mug.pendingImages.length) return;
    const refs: Ref[] = [];
    const remaining: string[] = [];
    let blocked = false;
    for (const url of mug.pendingImages) {
      const outcome = await mirrorOne(ctx, url);
      if ("ref" in outcome) refs.push(outcome.ref);
      else {
        remaining.push(url);
        if ("blocked" in outcome) blocked = true;
      }
    }
    await ctx.runMutation(internal.images.applyMirror, { mugId: args.mugId, refs, remaining, blocked });
  },
});

export const applyMirror = internalMutation({
  args: { mugId: v.id("mugs"), refs: v.array(v.any()), remaining: v.array(v.string()), blocked: v.boolean() },
  handler: async (ctx, args) => {
    const mug = await ctx.db.get(args.mugId);
    if (!mug) return;
    const known = new Set(mug.images.map((ref) => ref.key));
    const images = [...mug.images, ...(args.refs as Ref[]).filter((ref) => !known.has(ref.key))].slice(0, LIMITS.images);
    await ctx.db.patch(mug._id, {
      images,
      pendingImages: args.remaining,
      imageState: stateFor(images, args.remaining, args.blocked),
      updatedAt: Date.now(),
    });
  },
});

export const retry = mutation({
  args: { mugId: v.id("mugs") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const mug = await ctx.db.get(args.mugId);
    if (!mug) return fail("not-found", "That mug no longer exists.");
    if (!mug.pendingImages.length) return fail("nothing-pending", "This mug has no images waiting.");
    await ctx.db.patch(mug._id, { imageState: "pending", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.images.mirrorMug, { mugId: mug._id });
    return done();
  },
});

/** Mugs whose originals are stored but whose thumbnails are not, for the admin page's thumbnail tool. */
export const thumbsQueue = query({
  args: {},
  handler: async (ctx) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return null;
    const base = imagesBase(imagesEnv());
    const out = [];
    for (const mug of await ctx.db.query("mugs").withIndex("by_imageState", (q) => q.eq("imageState", "thumbs")).take(40)) {
      const images = [];
      for (let index = 0; index < mug.images.length; index++) {
        const ref = mug.images[index];
        if (ref.thumb) continue;
        const resolved = await resolveRef(ctx.storage, ref, base);
        if (resolved) images.push({ index, src: resolved.src, store: ref.store });
      }
      if (images.length) out.push({ mugId: mug._id, slug: mug.slug, name: mug.name, images });
    }
    return out;
  },
});

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    return done({ uploadUrl: await ctx.storage.generateUploadUrl() });
  },
});

export const setThumb = internalMutation({
  args: { mugId: v.id("mugs"), index: v.number(), thumb: v.string() },
  handler: async (ctx, args) => {
    const mug = await ctx.db.get(args.mugId);
    if (!mug || !mug.images[args.index]) return false;
    const images = mug.images.map((ref, i) => (i === args.index ? { ...ref, thumb: args.thumb } : ref));
    await ctx.db.patch(mug._id, { images, imageState: stateFor(images as Ref[], mug.pendingImages, mug.imageState === "blocked"), updatedAt: Date.now() });
    return true;
  },
});

/** Move an uploaded blob to R2 when the Worker can take it; otherwise it stays in Convex. */
async function toStore(ctx: any, storageId: string, kind: "thumb" | "photo" | "original", mustBeR2: boolean) {
  const env = proxyEnv();
  if (proxyConfigured(env)) {
    const blob = await ctx.storage.get(storageId);
    if (!blob) return { ok: false as const, code: "no-file", message: "The upload did not arrive." };
    const answer = await callProxy(env, `/v1/images/put?kind=${kind}`, { method: "PUT", body: await blob.arrayBuffer(), contentType: blob.type || "application/octet-stream" });
    if (answer.ok) {
      await ctx.storage.delete(storageId);
      return { ok: true as const, store: "r2" as const, key: answer.key as string, w: answer.w as number | undefined, h: answer.h as number | undefined };
    }
    if (mustBeR2 || answer.code !== "NOT_CONFIGURED") return { ok: false as const, code: answer.code, message: answer.message };
  }
  if (mustBeR2) return { ok: false as const, code: "NOT_CONFIGURED", message: "The original is in R2, so its thumbnail must be too, and the Worker is not configured." };
  return { ok: true as const, store: "convex" as const, key: storageId, w: undefined, h: undefined };
}

/** The admin page made a 480 px WebP of image `index`; store it beside the original (C4.4). */
export const attachThumb = action({
  args: { mugId: v.id("mugs"), index: v.number(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isAdminSubject(identity?.subject, adminList())) return fail("not-admin", "This needs a catalogue maintainer's account.");
    const mug = await ctx.runQuery(internal.images.mugForImages, { mugId: args.mugId });
    const ref = mug?.images[args.index];
    if (!ref) {
      await ctx.storage.delete(args.storageId);
      return fail("not-found", "That image no longer exists.");
    }
    const stored = await toStore(ctx, args.storageId, "thumb", ref.store === "r2");
    if (!stored.ok) {
      await ctx.storage.delete(args.storageId);
      return fail(stored.code, stored.message);
    }
    await ctx.runMutation(internal.images.setThumb, { mugId: args.mugId, index: args.index, thumb: stored.key });
    return done({ store: stored.store });
  },
});

export const appendImage = internalMutation({
  args: { mugId: v.id("mugs"), ref: v.any(), removePending: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const mug = await ctx.db.get(args.mugId);
    if (!mug) return false;
    const images = [...mug.images, args.ref].slice(0, LIMITS.images);
    const pendingImages = args.removePending ? mug.pendingImages.filter((u) => u !== args.removePending) : mug.pendingImages;
    await ctx.db.patch(mug._id, {
      images,
      pendingImages,
      imageState: stateFor(images as Ref[], pendingImages, mug.imageState === "blocked"),
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** An image the admin uploaded for a mug, from their own disk. */
export const addOriginal = action({
  args: { mugId: v.id("mugs"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isAdminSubject(identity?.subject, adminList())) return fail("not-admin", "This needs a catalogue maintainer's account.");
    const stored = await toStore(ctx, args.storageId, "original", false);
    if (!stored.ok) return fail(stored.code, stored.message);
    const ref: Ref = { store: stored.store, key: stored.key };
    if (stored.w) ref.w = stored.w;
    if (stored.h) ref.h = stored.h;
    await ctx.runMutation(internal.images.appendImage, { mugId: args.mugId, ref });
    return done();
  },
});

/** The runner fetched a blocked image from a residential connection (C8 /runner/image). */
export const acceptRunnerImage = internalAction({
  args: { mugId: v.id("mugs"), index: v.number(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const mug = await ctx.runQuery(internal.images.mugForImages, { mugId: args.mugId });
    const url = mug?.pendingImages[args.index];
    if (!url) {
      await ctx.storage.delete(args.storageId);
      return fail("not-pending", "That image is not waiting any more.");
    }
    const stored = await toStore(ctx, args.storageId, "original", false);
    if (!stored.ok) return fail(stored.code, stored.message);
    const ref: Ref = { store: stored.store, key: stored.key, source: url };
    if (stored.w) ref.w = stored.w;
    if (stored.h) ref.h = stored.h;
    await ctx.runMutation(internal.images.appendImage, { mugId: args.mugId, ref, removePending: url });
    return done();
  },
});

export const photoForMove = internalQuery({
  args: { photoId: v.id("photos") },
  handler: async (ctx, args) => await ctx.db.get(args.photoId),
});

export const setPhotoImage = internalMutation({
  args: { photoId: v.id("photos"), image: v.any() },
  handler: async (ctx, args) => {
    const photo = await ctx.db.get(args.photoId);
    if (photo) await ctx.db.patch(photo._id, { image: args.image });
  },
});

/** An approved photo leaves Convex storage for R2 when the Worker is there. */
export const movePhoto = internalAction({
  args: { photoId: v.id("photos") },
  handler: async (ctx, args) => {
    const photo = await ctx.runQuery(internal.images.photoForMove, { photoId: args.photoId });
    if (!photo || photo.status !== "visible" || photo.image.store !== "convex") return;
    const stored = await toStore(ctx, photo.image.key, "photo", false);
    if (stored.ok && stored.store === "r2") {
      const image: Ref = { store: "r2", key: stored.key };
      if (stored.w) image.w = stored.w;
      if (stored.h) image.h = stored.h;
      await ctx.runMutation(internal.images.setPhotoImage, { photoId: args.photoId, image });
    }
  },
});

/**
 * Drop an image that nothing points at any more. Convex files are deleted. R2
 * objects are kept: keys are content addresses, so the same bytes can belong
 * to another mug, and knowing that would take a scan this action cannot afford.
 */
export const forget = internalAction({
  args: { image: v.any() },
  handler: async (ctx, args) => {
    const ref = args.image as Ref;
    if (!ref || ref.store !== "convex") return;
    for (const id of [ref.key, ref.thumb]) {
      if (!id) continue;
      try {
        await ctx.storage.delete(id as any);
      } catch {
        // Already gone.
      }
    }
  },
});
