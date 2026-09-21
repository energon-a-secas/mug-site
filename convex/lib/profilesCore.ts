import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { bump, STAT } from "./counters.ts";
import { HANDLE_MESSAGES, handleProblem, normalizeHandle } from "./handles.ts";
import { checkRate, rateFailure, recordRate } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Result } from "./result.ts";
import { cleanText } from "./util.ts";

// Profiles and the publishing gate (docs/CONTRACTS.md C9), vitrina's design:
// a handle can be claimed at any time, but a shelf is only public when the
// deployment has PUBLISHING=open and its owner has published it.

type Db = GenericDatabaseWriter<any>;
type Reader = GenericDatabaseReader<any>;
type Env = { PUBLISHING?: string };

export function publishingOpen(env: Env): boolean {
  return env.PUBLISHING === "open";
}

export async function profileOf(db: Reader, subject: string): Promise<any | null> {
  return await db.query("profiles").withIndex("by_subject", (q: any) => q.eq("subject", subject)).unique();
}

/** Created lazily, the first time a collector puts a mug on a shelf or claims a handle. */
export async function ensureProfile(db: Db, subject: string, now: number): Promise<any> {
  const existing = await profileOf(db, subject);
  if (existing) return existing;
  const id = await db.insert("profiles", {
    subject,
    published: false,
    suspended: false,
    ownedCount: 0,
    wantedCount: 0,
    createdAt: now,
    updatedAt: now,
  } as any);
  return await db.get(id);
}

export async function claimHandle(db: Db, subject: string, raw: unknown, now: number): Promise<Result> {
  const handle = normalizeHandle(raw);
  const problem = handleProblem(handle);
  if (problem) return fail(problem, HANDLE_MESSAGES[problem]);
  const profile = await ensureProfile(db, subject, now);
  if (profile.handle === handle) return done({ handle });
  const holder = await db.query("profiles").withIndex("by_handle", (q: any) => q.eq("handle", handle)).first();
  if (holder && holder.subject !== subject) return fail("handle-taken", "Somebody already has that address.");
  const verdict = await checkRate(db, subject, "handle.change", now);
  if (!verdict.allowed) return rateFailure(verdict, "address changes");
  await db.patch(profile._id, { handle, updatedAt: now });
  await recordRate(db, subject, "handle.change", now);
  return done({ handle });
}

export async function updateProfile(
  db: Db,
  subject: string,
  args: { displayName?: unknown; bio?: unknown },
  now: number,
): Promise<Result> {
  const profile = await ensureProfile(db, subject, now);
  const verdict = await checkRate(db, subject, "profile.edit", now);
  if (!verdict.allowed) return rateFailure(verdict, "profile edits");
  const patch: Record<string, unknown> = { updatedAt: now };
  if (args.displayName !== undefined) patch.displayName = cleanText(args.displayName, 40) || undefined;
  if (args.bio !== undefined) patch.bio = cleanText(args.bio, 280) || undefined;
  await db.patch(profile._id, patch);
  await recordRate(db, subject, "profile.edit", now);
  return done();
}

export async function setPublished(db: Db, subject: string, published: boolean, now: number, env: Env): Promise<Result> {
  const profile = await ensureProfile(db, subject, now);
  if (published && !publishingOpen(env)) {
    return fail("publishing-closed", "Public shelves are not open yet. Your shelf stays private for now.");
  }
  if (published && !profile.handle) return fail("no-handle", "Pick an address for your shelf first.");
  if (profile.suspended) return fail("suspended", "This shelf cannot be published.");
  if (profile.published === published) return done({ published });
  await db.patch(profile._id, { published, publishedAt: published ? now : profile.publishedAt, updatedAt: now });
  await bump(db, STAT.collectors, published ? 1 : -1);
  return done({ published });
}

/**
 * Who may see a shelf at /u/?handle. Null for everyone but the owner when
 * publishing is closed, when the shelf is unpublished, or when it is suspended.
 */
export async function visibleProfile(db: Reader, viewer: string | null, rawHandle: unknown, env: Env): Promise<any | null> {
  if (typeof rawHandle !== "string") return null;
  const handle = normalizeHandle(rawHandle);
  if (handleProblem(handle) === "handle-invalid") return null;
  const profile = await db.query("profiles").withIndex("by_handle", (q: any) => q.eq("handle", handle)).first();
  if (!profile) return null;
  const owner = viewer !== null && viewer === profile.subject;
  if (owner) return { profile, owner: true };
  if (!publishingOpen(env) || !profile.published || profile.suspended) return null;
  return { profile, owner: false };
}

/** Whether a collector's activity may appear on community surfaces. */
export function isListed(profile: any | null, env: Env): boolean {
  return !!profile && publishingOpen(env) && profile.published && !profile.suspended && !!profile.handle;
}
