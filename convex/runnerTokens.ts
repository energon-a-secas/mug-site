import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { adminList, requireAdmin } from "./lib/access.ts";
import { isAdminSubject } from "./lib/admin.ts";
import { done, fail } from "./lib/result.ts";
import { cleanText } from "./lib/util.ts";
import { hashToken, newToken } from "./lib/tokens.ts";

// Tokens for the local runner (docs/CONTRACTS.md C8). Minted in an action,
// because only actions get real randomness; the plaintext is returned once
// and only its SHA-256 is stored.

export const list = query({
  args: {},
  handler: async (ctx) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return null;
    return (await ctx.db.query("runnerTokens").withIndex("by_created").order("desc").take(50)).map((t) => ({
      id: t._id,
      label: t.label,
      prefix: t.prefix,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt ?? null,
      revokedAt: t.revokedAt ?? null,
    }));
  },
});

export const insert = internalMutation({
  args: { label: v.string(), hash: v.string(), prefix: v.string(), createdBy: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("runnerTokens", { ...args, createdAt: Date.now() });
  },
});

export const create = action({
  args: { label: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isAdminSubject(identity?.subject, adminList())) return fail("not-admin", "This needs a catalogue maintainer's account.");
    const label = cleanText(args.label, 60) || "runner";
    const token = newToken();
    await ctx.runMutation(internal.runnerTokens.insert, {
      label,
      hash: await hashToken(token),
      prefix: token.slice(0, 13),
      createdBy: identity!.subject,
    });
    return done({ token, prefix: token.slice(0, 13) });
  },
});

export const revoke = mutation({
  args: { id: v.id("runnerTokens") },
  handler: async (ctx, args) => {
    const who = await requireAdmin(ctx);
    if (!who.ok) return who;
    const row = await ctx.db.get(args.id);
    if (!row) return fail("not-found", "That token no longer exists.");
    if (!row.revokedAt) await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return done();
  },
});

export const byHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("runnerTokens").withIndex("by_hash", (q) => q.eq("hash", args.hash)).unique();
    return row && !row.revokedAt ? { id: row._id, prefix: row.prefix, lastUsedAt: row.lastUsedAt ?? 0 } : null;
  },
});
