import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { STYLES } from "../shared/contract.js";
import { fold } from "../shared/extract/names.js";
import { isAdmin, subjectOf } from "./lib/access.ts";
import { cardCache, cardFor } from "./lib/cards.ts";
import { readStat, STAT } from "./lib/counters.ts";
import { imagesBase, imagesEnv, resolveRef } from "./lib/images.ts";
import { isListed, profileOf } from "./lib/profilesCore.ts";

// The public catalogue: anyone may call these (docs/CONTRACTS.md C6). Every
// list reads through the index that matches its first filter, then narrows
// in memory, so no query scans the whole table.

const SORTS = ["new", "owned", "wanted", "name"] as const;

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    q: v.optional(v.string()),
    brand: v.optional(v.string()),
    franchise: v.optional(v.string()),
    style: v.optional(v.string()),
    sort: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const empty = { page: [], isDone: true, continueCursor: "" };
    const brand = args.brand
      ? await ctx.db.query("brands").withIndex("by_slug", (q) => q.eq("slug", args.brand!)).unique()
      : null;
    if (args.brand && !brand) return empty;
    const franchise = args.franchise
      ? await ctx.db.query("franchises").withIndex("by_slug", (q) => q.eq("slug", args.franchise!)).unique()
      : null;
    if (args.franchise && !franchise) return empty;
    const style = args.style && STYLES.includes(args.style) ? (args.style as any) : undefined;
    if (args.style && !style) return empty;
    const sort = SORTS.includes(args.sort as any) ? args.sort : "new";
    const text = fold(args.q || "").replace(/[^a-z0-9 ]+/g, " ").trim();

    let result;
    if (text.length >= 2) {
      result = await ctx.db
        .query("mugs")
        .withSearchIndex("search", (s) => {
          let b = s.search("searchText", text).eq("status", "published");
          if (brand) b = b.eq("brandId", brand._id);
          if (franchise) b = b.eq("franchiseId", franchise._id);
          if (style) b = b.eq("style", style);
          return b;
        })
        .paginate(args.paginationOpts);
    } else if (brand) {
      let q = ctx.db.query("mugs").withIndex("by_brand", (i) => i.eq("brandId", brand._id).eq("status", "published")).order("desc");
      if (franchise) q = q.filter((f) => f.eq(f.field("franchiseId"), franchise._id));
      if (style) q = q.filter((f) => f.eq(f.field("style"), style));
      result = await q.paginate(args.paginationOpts);
    } else if (franchise) {
      let q = ctx.db.query("mugs").withIndex("by_franchise", (i) => i.eq("franchiseId", franchise._id).eq("status", "published")).order("desc");
      if (style) q = q.filter((f) => f.eq(f.field("style"), style));
      result = await q.paginate(args.paginationOpts);
    } else if (style) {
      result = await ctx.db
        .query("mugs")
        .withIndex("by_style", (i) => i.eq("style", style).eq("status", "published"))
        .order("desc")
        .paginate(args.paginationOpts);
    } else if (sort === "owned") {
      result = await ctx.db.query("mugs").withIndex("by_status_owned", (i) => i.eq("status", "published")).order("desc").paginate(args.paginationOpts);
    } else if (sort === "wanted") {
      result = await ctx.db.query("mugs").withIndex("by_status_wanted", (i) => i.eq("status", "published")).order("desc").paginate(args.paginationOpts);
    } else if (sort === "name") {
      result = await ctx.db.query("mugs").withIndex("by_status_name", (i) => i.eq("status", "published")).order("asc").paginate(args.paginationOpts);
    } else {
      result = await ctx.db.query("mugs").withIndex("by_status_published", (i) => i.eq("status", "published")).order("desc").paginate(args.paginationOpts);
    }

    const cache = cardCache();
    const base = imagesBase(imagesEnv());
    const page = [];
    for (const mug of result.page) page.push(await cardFor(ctx, mug, cache, base));
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const facets = query({
  args: {},
  handler: async (ctx) => {
    const brands = (await ctx.db.query("brands").withIndex("by_mugCount").order("desc").take(80))
      .filter((b) => b.mugCount > 0)
      .map((b) => ({ slug: b.slug, name: b.name, count: b.mugCount }));
    const franchises = (await ctx.db.query("franchises").withIndex("by_mugCount").order("desc").take(80))
      .filter((f) => f.mugCount > 0)
      .map((f) => ({ slug: f.slug, name: f.name, count: f.mugCount }));
    const styles = [];
    for (const style of STYLES) {
      const count = await readStat(ctx.db, STAT.style(style));
      if (count > 0) styles.push({ style, count });
    }
    return {
      brands,
      franchises,
      styles,
      totals: {
        mugs: await readStat(ctx.db, STAT.mugs),
        owned: await readStat(ctx.db, STAT.owned),
        wanted: await readStat(ctx.db, STAT.wanted),
        collectors: await readStat(ctx.db, STAT.collectors),
      },
    };
  },
});

export const brand = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const brand = await ctx.db.query("brands").withIndex("by_slug", (q) => q.eq("slug", args.slug)).unique();
    if (!brand) return null;
    return { slug: brand.slug, name: brand.name, website: brand.website ?? null, country: brand.country ?? null, mugCount: brand.mugCount };
  },
});

/** A mug's page: facts, images, shop links, the viewer's shelf state, photos and related mugs. */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const mug = await ctx.db.query("mugs").withIndex("by_slug", (q) => q.eq("slug", args.slug)).unique();
    if (!mug) return null;
    const admin = await isAdmin(ctx);
    if (mug.status !== "published" && !admin) return null;

    const base = imagesBase(imagesEnv());
    const brand = mug.brandId ? await ctx.db.get(mug.brandId) : null;
    const franchise = mug.franchiseId ? await ctx.db.get(mug.franchiseId) : null;
    const images = [];
    for (const ref of mug.images) {
      const resolved = await resolveRef(ctx.storage, ref, base);
      if (resolved) images.push(resolved);
    }

    const subject = await subjectOf(ctx);
    let mine = null;
    if (subject) {
      const item = await ctx.db
        .query("shelfItems")
        .withIndex("by_subject_mug", (q) => q.eq("subject", subject).eq("mugId", mug._id))
        .unique();
      if (item) {
        mine = {
          state: item.state,
          note: item.note ?? null,
          condition: item.condition ?? null,
          pricePaid: item.pricePaid ?? null,
          currency: item.currency ?? null,
          acquiredOn: item.acquiredOn ?? null,
        };
      }
    }

    const env = { PUBLISHING: process.env.PUBLISHING };
    const photos = [];
    for (const photo of await ctx.db
      .query("photos")
      .withIndex("by_mug", (q) => q.eq("mugId", mug._id).eq("status", "visible"))
      .order("desc")
      .take(24)) {
      const owner = await profileOf(ctx.db, photo.subject);
      if (!isListed(owner, env)) continue;
      const image = await resolveRef(ctx.storage, photo.image, base);
      if (image) photos.push({ image, caption: photo.caption ?? null, handle: owner.handle, name: owner.displayName ?? owner.handle });
      if (photos.length >= 12) break;
    }

    const cache = cardCache();
    const related = [];
    const relatedQuery = franchise
      ? ctx.db.query("mugs").withIndex("by_franchise", (q) => q.eq("franchiseId", franchise._id).eq("status", "published"))
      : brand
        ? ctx.db.query("mugs").withIndex("by_brand", (q) => q.eq("brandId", brand._id).eq("status", "published"))
        : null;
    if (relatedQuery) {
      for (const other of await relatedQuery.order("desc").take(9)) {
        if (other._id !== mug._id) related.push(await cardFor(ctx, other, cache, base));
        if (related.length >= 8) break;
      }
    }

    return {
      id: mug._id,
      slug: mug.slug,
      name: mug.name,
      brand: brand ? { slug: brand.slug, name: brand.name, website: brand.website ?? null } : null,
      franchise: franchise ? { slug: franchise.slug, name: franchise.name } : null,
      character: mug.character ?? null,
      style: mug.style,
      capacityMl: mug.capacityMl ?? null,
      material: mug.material ?? null,
      hasLid: mug.hasLid ?? null,
      dishwasherSafe: mug.dishwasherSafe ?? null,
      microwaveSafe: mug.microwaveSafe ?? null,
      sku: mug.sku ?? null,
      gtin: mug.gtin ?? null,
      releaseYear: mug.releaseYear ?? null,
      blurb: mug.blurb ?? null,
      images,
      imagesPending: mug.pendingImages.length,
      links: mug.links,
      lastPrice: mug.lastPrice ?? null,
      ownedCount: mug.ownedCount,
      wantedCount: mug.wantedCount,
      hidden: mug.status !== "published",
      canEdit: admin,
      mine,
      photos,
      related,
    };
  },
});
