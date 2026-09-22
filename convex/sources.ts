import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { slugify } from "../shared/extract/names.js";
import { canonicalUrl } from "../shared/extract/normalize.js";
import { adminList, requireAdmin } from "./lib/access.ts";
import { isAdminSubject } from "./lib/admin.ts";
import { findOrCreateBrand } from "./lib/catalogue.ts";
import { sourceForHost } from "./lib/sourceHost.ts";
import { callProxy, proxyEnv } from "./lib/proxy.ts";
import { done, fail } from "./lib/result.ts";
import { cleanText, compact } from "./lib/util.ts";

// Shop feeds the admin can scan (docs/CONTRACTS.md C2).

const ADAPTERS = ["shopify", "woocommerce", "jsonld", "manual"] as const;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return null;
    const out = [];
    for (const source of await ctx.db.query("sources").take(500)) {
      const brand = source.brandId ? await ctx.db.get(source.brandId) : null;
      const run = source.lastRunId ? await ctx.db.get(source.lastRunId) : null;
      out.push({
        ...source,
        brand: brand ? brand.name : null,
        lastRun: run
          ? { id: run._id, status: run.status, staged: run.staged, unchanged: run.unchanged, needsLocal: run.needsLocal, failed: run.failed, error: run.error ?? null, at: run.updatedAt }
          : null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

function words(list: string[]): string[] {
  return [...new Set(list.map((w) => cleanText(w, 40).toLowerCase()).filter(Boolean))].slice(0, 30);
}

export const save = mutation({
  args: {
    id: v.optional(v.id("sources")),
    name: v.string(),
    brand: v.optional(v.string()),
    adapter: v.string(),
    baseUrl: v.string(),
    entryUrls: v.array(v.string()),
    include: v.array(v.string()),
    exclude: v.array(v.string()),
    fetchVia: v.union(v.literal("cloud"), v.literal("local")),
    watch: v.boolean(),
    enabled: v.boolean(),
    currency: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const now = Date.now();
    const name = cleanText(args.name, 80);
    if (!name) return fail("bad-name", "A source needs a name.");
    if (!ADAPTERS.includes(args.adapter as any)) return fail("bad-adapter", `Adapter is one of ${ADAPTERS.join(", ")}.`);
    const baseUrl = canonicalUrl(args.baseUrl);
    if (!baseUrl) return fail("bad-url", "The shop address has to be an https URL.");
    const entryUrls = [];
    for (const raw of args.entryUrls.slice(0, 10)) {
      if (!raw.trim()) continue;
      const url = canonicalUrl(raw);
      if (!url) return fail("bad-url", `Not an https URL: ${raw.slice(0, 80)}`);
      entryUrls.push(url);
    }
    const currency = (args.currency || "").trim().toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) return fail("bad-currency", "Currency is a three-letter code such as USD.");
    const brand = args.brand && args.brand.trim() ? await findOrCreateBrand(ctx.db, cleanText(args.brand, 80), now) : null;
    const fields = compact({
      name,
      brandId: brand?._id,
      adapter: args.adapter as (typeof ADAPTERS)[number],
      baseUrl: baseUrl.replace(/\/+$/, ""),
      entryUrls,
      include: words(args.include),
      exclude: words(args.exclude),
      fetchVia: args.fetchVia,
      watch: args.watch,
      enabled: args.enabled,
      currency: currency || undefined,
      notes: cleanText(args.notes, 500) || undefined,
      updatedAt: now,
    });
    if (args.id) {
      const current = await ctx.db.get(args.id);
      if (!current) return fail("not-found", "That source no longer exists.");
      await ctx.db.patch(args.id, { ...fields, brandId: brand?._id, currency: fields.currency, notes: fields.notes });
      return done({ id: args.id, slug: current.slug });
    }
    let slug = slugify(name) || "source";
    for (let n = 2; await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).first(); n++) slug = `${slugify(name)}-${n}`;
    const id = await ctx.db.insert("sources", { ...fields, slug, createdAt: now } as any);
    return done({ id, slug });
  },
});

export const remove = mutation({
  args: { id: v.id("sources") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const source = await ctx.db.get(args.id);
    if (!source) return done();
    const run = source.lastRunId ? await ctx.db.get(source.lastRunId) : null;
    if (run && (run.status === "discovering" || run.status === "extracting")) return fail("run-active", "Cancel the running scan first.");
    await ctx.db.delete(args.id);
    return done();
  },
});

export const byId = internalQuery({
  args: { id: v.id("sources") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/** A single URL import's brand and currency: those of the source that owns the URL's host, if any. */
export const forHost = internalQuery({
  args: { host: v.string() },
  handler: async (ctx, args) => {
    const source = sourceForHost(await ctx.db.query("sources").take(500), args.host);
    if (!source) return null;
    const brand = source.brandId ? await ctx.db.get(source.brandId) : null;
    return { slug: source.slug, brand: brand ? brand.name : null, currency: source.currency ?? null };
  },
});

export const recordProbe = internalMutation({
  args: { id: v.id("sources"), probe: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { lastProbe: args.probe, updatedAt: Date.now() });
  },
});

/** Robots verdict and platform guess for the shop's front door (C3 /v1/probe). */
export const probe = action({
  args: { id: v.id("sources") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isAdminSubject(identity?.subject, adminList())) return fail("not-admin", "This needs a catalogue maintainer's account.");
    const source = await ctx.runQuery(internal.sources.byId, { id: args.id });
    if (!source) return fail("not-found", "That source no longer exists.");
    const answer = await callProxy(proxyEnv(), "/v1/probe", { json: { url: source.entryUrls[0] || source.baseUrl } });
    const probe = answer.ok
      ? compact({
          at: Date.now(),
          robots: answer.robots?.allowed ? "allowed" : "disallowed",
          platform: answer.platform,
          status: answer.status,
          note: answer.robots?.rule ? String(answer.robots.rule).slice(0, 200) : undefined,
        })
      : { at: Date.now(), robots: "unknown", note: `${answer.code}: ${answer.message}`.slice(0, 200) };
    await ctx.runMutation(internal.sources.recordProbe, { id: args.id, probe });
    return answer.ok ? done({ probe }) : fail(answer.code, answer.message, { probe });
  },
});
