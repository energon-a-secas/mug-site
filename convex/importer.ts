import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation } from "./_generated/server";
import { listingKey, canonicalUrl, normalizeListing } from "../shared/extract/normalize.js";
import { fromPaste as parsePaste } from "../shared/extract/paste.js";
import { adminList, requireAdmin } from "./lib/access.ts";
import { isAdminSubject } from "./lib/admin.ts";
import { callProxy, proxyConfigured, proxyEnv } from "./lib/proxy.ts";
import { done, fail } from "./lib/result.ts";
import { approveStaging } from "./lib/reviewCore.ts";
import { applyExtract, reNormalize, stageListing } from "./lib/stageCore.ts";

// The admin's three ways to add one mug: a shop URL the Worker reads, a paste
// of what a marketplace page says (Amazon and every other shop nothing may
// fetch, C11), and a form filled in by hand.

async function newRun(ctx: any, kind: "url" | "paste" | "manual", target: string, subject: string) {
  const now = Date.now();
  return await ctx.db.insert("runs", {
    kind, target: target.slice(0, 300), trigger: "manual", status: kind === "url" ? "extracting" : "ready",
    entryIndex: 0, page: 1, retries: 0, discovered: 1, staged: 0, unchanged: 0, skipped: 0, needsLocal: 0, failed: 0,
    startedBy: subject, createdAt: now, updatedAt: now,
  });
}

export const queueUrl = internalMutation({
  args: { url: v.string(), subject: v.string(), local: v.boolean() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const key = listingKey({ url: args.url, platform: "jsonld" });
    const open = (await ctx.db.query("staging").withIndex("by_key", (q) => q.eq("key", key)).take(10)).find((r) =>
      ["queued", "pending", "needsLocal"].includes(r.status),
    );
    if (open) return { stagingId: open._id, runId: open.runId ?? null, existing: true, status: open.status };
    const runId = await newRun(ctx, "url", args.url, args.subject);
    const stagingId = await ctx.db.insert("staging", {
      runId, key, url: args.url, status: args.local ? "needsLocal" : "queued", attempts: 0, createdAt: now, updatedAt: now,
    });
    if (args.local) await ctx.db.patch(runId, { status: "ready", needsLocal: 1 });
    return { stagingId, runId, existing: false, status: args.local ? "needsLocal" : "queued" };
  },
});

export const applyUrl = internalMutation({
  args: { stagingId: v.id("staging"), runId: v.id("runs"), listing: v.optional(v.any()), error: v.optional(v.object({ code: v.string(), message: v.string() })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let listing;
    let error = args.error;
    if (args.listing !== undefined) {
      const checked = reNormalize(args.listing, "worker", now);
      if (checked.ok) listing = checked.listing;
      else error = { code: "NOT_A_PRODUCT", message: checked.message };
    }
    const result = await applyExtract(ctx.db, { stagingId: args.stagingId, listing, error, now });
    const run = await ctx.db.get(args.runId);
    if (run && run.status === "extracting") await ctx.db.patch(run._id, { status: "ready", updatedAt: now });
    return result;
  },
});

/** One shop page through the Worker now; to the runner queue when the cloud cannot read it. */
export const fromUrl = action({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isAdminSubject(identity?.subject, adminList())) return fail("not-admin", "This needs a catalogue maintainer's account.");
    const url = canonicalUrl(args.url);
    if (!url) return fail("bad-url", "That is not an https URL.");
    if (/(^|\.)amazon\.[a-z.]+$/i.test(new URL(url).hostname)) {
      return fail("amazon", "Amazon is never fetched (robots.txt refuses it). Paste the product's title and details instead.");
    }
    const local = !proxyConfigured(proxyEnv());
    const queued: any = await ctx.runMutation(internal.importer.queueUrl, { url, subject: identity!.subject, local });
    if (queued.existing || local) return done({ stagingId: queued.stagingId, status: queued.status, existing: queued.existing });
    const answer = await callProxy(proxyEnv(), "/v1/extract", { json: { url } });
    const result: any = await ctx.runMutation(internal.importer.applyUrl, {
      stagingId: queued.stagingId,
      runId: queued.runId,
      listing: answer.ok ? answer.listing : undefined,
      error: answer.ok ? undefined : { code: answer.code, message: answer.message },
    });
    return done({ stagingId: queued.stagingId, status: result.outcome, match: result.match ?? null, error: answer.ok ? null : { code: answer.code, message: answer.message } });
  },
});

async function knownBrands(ctx: any): Promise<string[]> {
  return (await ctx.db.query("brands").take(1000)).map((b: any) => b.name);
}

/** A marketplace title and details, pasted. The same parser the admin page previews with. */
export const fromPaste = mutation({
  args: { text: v.string(), url: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    if (args.text.length > 20000) return fail("too-long", "Paste at most 20,000 characters.");
    const now = Date.now();
    const parsed: any = parsePaste(args.text, { url: args.url || undefined, knownBrands: await knownBrands(ctx), now });
    if (!parsed.ok) return fail(parsed.code, parsed.message);
    const runId = await newRun(ctx, "paste", parsed.listing.name, who.subject);
    const staged = await stageListing(ctx.db, { listing: parsed.listing, runId, now });
    return done({ ...staged, listing: parsed.listing });
  },
});

/** A mug typed in by hand; approve: true also publishes it in the same step. */
export const manual = mutation({
  args: { listing: v.any(), approve: v.optional(v.boolean()), edits: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const now = Date.now();
    const input = { ...(args.listing || {}), source: { platform: "manual", via: "browser", url: args.listing?.source?.url || undefined } };
    const normalized: any = normalizeListing(input, { now });
    if (!normalized.ok) return fail(normalized.code, normalized.message);
    const runId = await newRun(ctx, "manual", normalized.listing.name, who.subject);
    const staged = await stageListing(ctx.db, { listing: normalized.listing, runId, now });
    if (!args.approve || staged.outcome !== "staged" || !staged.stagingId) return done({ ...staged });
    const approved: any = await approveStaging(ctx.db, { stagingId: staged.stagingId, edits: args.edits, subject: who.subject, now });
    if (approved.ok && approved.scheduleImages) await ctx.scheduler.runAfter(0, internal.images.mirrorMug, { mugId: approved.mugId });
    return approved;
  },
});
