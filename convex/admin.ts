import { query } from "./_generated/server";
import { adminList, subjectOf } from "./lib/access.ts";
import { isAdminSubject } from "./lib/admin.ts";
import { imagesBase, imagesEnv } from "./lib/images.ts";
import { proxyConfigured, proxyEnv } from "./lib/proxy.ts";
import { publishingOpen } from "./lib/profilesCore.ts";
import { readStat, STAT } from "./lib/counters.ts";

// The admin page's first two calls. whoami answers everyone, so the page can
// say why it is empty; dashboard answers admins only. `subject` is the
// caller's own, already inside their token: a new deployment's first
// maintainer reads it off the page and adds it to ADMIN_SUBJECTS.

export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const subject = await subjectOf(ctx);
    return { signedIn: !!subject, isAdmin: isAdminSubject(subject, adminList()), subject };
  },
});

async function countUpTo(q: any, max: number): Promise<number> {
  return (await q.take(max)).length;
}

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const subject = await subjectOf(ctx);
    if (!isAdminSubject(subject, adminList())) return null;
    const cap = 500;
    const staging = async (status: any) =>
      await countUpTo(ctx.db.query("staging").withIndex("by_status", (q) => q.eq("status", status)), cap);
    const images = async (state: any) =>
      await countUpTo(ctx.db.query("mugs").withIndex("by_imageState", (q) => q.eq("imageState", state)), cap);
    const active = [];
    for (const status of ["discovering", "extracting"] as const) {
      for (const run of await ctx.db.query("runs").withIndex("by_status", (q) => q.eq("status", status)).take(20)) active.push(run._id);
    }
    return {
      cap,
      queue: {
        pending: await staging("pending"),
        queued: await staging("queued"),
        needsLocal: await staging("needsLocal"),
        failed: await staging("failed"),
      },
      images: {
        pending: await images("pending"),
        blocked: await images("blocked"),
        failed: await images("failed"),
        thumbs: await images("thumbs"),
      },
      photosPending: await countUpTo(ctx.db.query("photos").withIndex("by_status", (q) => q.eq("status", "pending")), cap),
      activeRuns: active.length,
      mugs: await readStat(ctx.db, STAT.mugs),
      config: {
        proxy: proxyConfigured(proxyEnv()),
        imagesBase: imagesBase(imagesEnv()),
        publishing: publishingOpen({ PUBLISHING: process.env.PUBLISHING }),
        admins: (process.env.ADMIN_SUBJECTS || "").split(",").filter((s) => s.trim()).length,
      },
    };
  },
});
