import { query } from "./_generated/server";
import { cardCache, cardFor } from "./lib/cards.ts";
import { readStat, STAT } from "./lib/counters.ts";
import { imagesBase, imagesEnv, resolveRef } from "./lib/images.ts";
import { isListed, profileOf, publishingOpen } from "./lib/profilesCore.ts";

// The community page. Aggregates (how many own a mug) are anonymous and always
// shown; anything that names a collector appears only when publishing is open
// and that collector has published (docs/CONTRACTS.md C9).

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const env = { PUBLISHING: process.env.PUBLISHING };
    const base = imagesBase(imagesEnv());
    const cache = cardCache();
    const open = publishingOpen(env);

    const mostOwned = [];
    for (const mug of await ctx.db.query("mugs").withIndex("by_status_owned", (q) => q.eq("status", "published")).order("desc").take(10)) {
      if (mug.ownedCount > 0) mostOwned.push(await cardFor(ctx, mug, cache, base));
    }
    const mostWanted = [];
    for (const mug of await ctx.db.query("mugs").withIndex("by_status_wanted", (q) => q.eq("status", "published")).order("desc").take(10)) {
      if (mug.wantedCount > 0) mostWanted.push(await cardFor(ctx, mug, cache, base));
    }
    const newest = [];
    for (const mug of await ctx.db.query("mugs").withIndex("by_status_published", (q) => q.eq("status", "published")).order("desc").take(10)) {
      newest.push(await cardFor(ctx, mug, cache, base));
    }

    const collectors = [];
    const recent = [];
    const photos = [];
    if (open) {
      for (const profile of await ctx.db.query("profiles").withIndex("by_published_owned", (q) => q.eq("published", true)).order("desc").take(24)) {
        if (!isListed(profile, env)) continue;
        const shelf = [];
        for (const item of await ctx.db
          .query("shelfItems")
          .withIndex("by_subject", (q) => q.eq("subject", profile.subject).eq("state", "owned"))
          .order("desc")
          .take(5)) {
          const mug = await ctx.db.get(item.mugId);
          if (mug && mug.status === "published") shelf.push(await cardFor(ctx, mug, cache, base));
        }
        collectors.push({
          handle: profile.handle,
          name: profile.displayName ?? profile.handle,
          bio: profile.bio ?? null,
          ownedCount: profile.ownedCount,
          wantedCount: profile.wantedCount,
          shelf,
        });
        if (collectors.length >= 12) break;
      }

      const profiles = new Map<string, any>();
      for (const item of await ctx.db.query("shelfItems").withIndex("by_created").order("desc").take(120)) {
        if (item.state === "had") continue;
        if (!profiles.has(item.subject)) profiles.set(item.subject, await profileOf(ctx.db, item.subject));
        const owner = profiles.get(item.subject);
        if (!isListed(owner, env)) continue;
        const mug = await ctx.db.get(item.mugId);
        if (!mug || mug.status !== "published") continue;
        recent.push({
          at: item.createdAt,
          state: item.state,
          handle: owner.handle,
          name: owner.displayName ?? owner.handle,
          mug: await cardFor(ctx, mug, cache, base),
        });
        if (recent.length >= 20) break;
      }

      for (const photo of await ctx.db.query("photos").withIndex("by_status", (q) => q.eq("status", "visible")).order("desc").take(40)) {
        if (!profiles.has(photo.subject)) profiles.set(photo.subject, await profileOf(ctx.db, photo.subject));
        const owner = profiles.get(photo.subject);
        if (!isListed(owner, env)) continue;
        const mug = await ctx.db.get(photo.mugId);
        const image = await resolveRef(ctx.storage, photo.image, base);
        if (!mug || mug.status !== "published" || !image) continue;
        photos.push({ image, caption: photo.caption ?? null, handle: owner.handle, name: owner.displayName ?? owner.handle, mug: { slug: mug.slug, name: mug.name } });
        if (photos.length >= 12) break;
      }
    }

    return {
      publishing: open,
      totals: {
        mugs: await readStat(ctx.db, STAT.mugs),
        owned: await readStat(ctx.db, STAT.owned),
        wanted: await readStat(ctx.db, STAT.wanted),
        collectors: await readStat(ctx.db, STAT.collectors),
      },
      mostOwned,
      mostWanted,
      newest,
      collectors,
      recent,
      photos,
    };
  },
});
