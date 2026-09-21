import type { GenericDatabaseWriter } from "convex/server";
import { listingKey, normalizeListing } from "../../shared/extract/normalize.js";
import { matchListing, seenOf, storedMatch } from "./matchCore.ts";
import type { Match } from "./matchCore.ts";
import { compact } from "./util.ts";

// What a scan, a URL import, a paste or a runner post does to the review
// queue (docs/CONTRACTS.md C7, C8). Run counters are cumulative event counts,
// bumped in the same mutation as the event they count.

type Db = GenericDatabaseWriter<any>;

const OPEN = ["queued", "pending", "needsLocal"];

// C3: which Worker failures send a page to the runner, and which are retried once.
export const BLOCKED_CODES = ["UPSTREAM_BLOCKED"];
export const RETRY_CODES = ["UPSTREAM_ERROR", "UPSTREAM_TIMEOUT", "INTERNAL"];
const MAX_ATTEMPTS = 2;

// A page read within this window is not fetched again by a re-scan.
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export type RunDelta = Partial<Record<"discovered" | "staged" | "unchanged" | "skipped" | "needsLocal" | "failed", number>>;

export async function bumpRun(db: Db, runId: string | undefined, delta: RunDelta, now: number): Promise<void> {
  if (!runId) return;
  const run = await db.get(runId as any);
  if (!run) return;
  const patch: Record<string, number> = { updatedAt: now };
  for (const [key, n] of Object.entries(delta)) if (n) patch[key] = ((run as any)[key] || 0) + n;
  await db.patch(runId as any, patch);
}

/**
 * C8: whatever arrives over the wire is normalised again here, and `via` is
 * set by the caller from how it arrived, never taken from the payload.
 */
export function reNormalize(raw: unknown, via: "worker" | "runner" | "browser", now: number):
  | { ok: true; listing: any }
  | { ok: false; code: string; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, code: "bad-listing", message: "A listing has to be an object." };
  const input = { ...(raw as any), source: { ...(((raw as any).source as object) || {}), via } };
  return normalizeListing(input, { now }) as any;
}

async function openRowByKey(db: Db, key: string): Promise<any | null> {
  const rows = await db.query("staging").withIndex("by_key", (q: any) => q.eq("key", key)).take(20);
  return rows.find((row: any) => OPEN.includes(row.status)) || null;
}

/** A "same" match changes no mug: it links a new shop page or notes that the known one was seen. */
async function settleSame(db: Db, match: Match, listing: any, sourceId: string | undefined, now: number) {
  if (match.link) {
    const existing = await db.query("mugSources").withIndex("by_key", (q: any) => q.eq("key", listing.source.key)).first();
    if (!existing) {
      await db.insert("mugSources", compact({
        mugId: match.mugId,
        key: listing.source.key,
        sourceId,
        url: listing.source.url,
        seen: seenOf(listing),
        lastSeenAt: now,
      }) as any);
    }
    return "linked" as const;
  }
  if (match.sourceRowId) await db.patch(match.sourceRowId as any, { lastSeenAt: now });
  return "unchanged" as const;
}

export type StageOutcome = "staged" | "updated" | "unchanged" | "linked" | "skipped";

/** One normalised listing into the queue, or recognised as already known. */
export async function stageListing(
  db: Db,
  args: { listing: any; runId?: string; sourceId?: string; now: number },
): Promise<{ outcome: StageOutcome; stagingId?: string; mugId?: string }> {
  const { listing, runId, sourceId, now } = args;
  if (listing.isMug?.verdict === "no") {
    await bumpRun(db, runId, { skipped: 1 }, now);
    return { outcome: "skipped" };
  }
  const match = await matchListing(db, listing);
  const open = await openRowByKey(db, listing.source.key);
  if (match.kind === "same") {
    const outcome = await settleSame(db, match, listing, sourceId, now);
    if (open) await db.delete(open._id);
    await bumpRun(db, runId, { unchanged: 1 }, now);
    return { outcome, mugId: match.mugId };
  }
  const fields = compact({
    listing,
    match: storedMatch(match),
    status: "pending" as const,
    url: listing.source.url,
    updatedAt: now,
  });
  if (open) {
    await db.patch(open._id, { ...fields, error: undefined });
    return { outcome: "updated", stagingId: open._id };
  }
  const id = await db.insert("staging", compact({
    runId,
    sourceId,
    key: listing.source.key,
    attempts: 0,
    createdAt: now,
    ...fields,
  }) as any);
  await bumpRun(db, runId, { staged: 1 }, now);
  return { outcome: "staged", stagingId: id };
}

/** A product URL found by discovery, queued for /v1/extract unless it was read recently. */
export async function stageUrl(
  db: Db,
  args: { url: string; runId?: string; sourceId?: string; now: number },
): Promise<"queued" | "duplicate" | "recent" | "skipped"> {
  const { url, runId, sourceId, now } = args;
  const key = listingKey({ url, platform: "jsonld" });
  if (!key) {
    await bumpRun(db, runId, { skipped: 1 }, now);
    return "skipped";
  }
  if (await openRowByKey(db, key)) return "duplicate";
  const known = await db.query("mugSources").withIndex("by_key", (q: any) => q.eq("key", key)).first();
  if (known && now - known.lastSeenAt < RECENT_MS) {
    await bumpRun(db, runId, { unchanged: 1 }, now);
    return "recent";
  }
  await db.insert("staging", compact({
    runId,
    sourceId,
    key,
    url,
    status: "queued" as const,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }) as any);
  return "queued";
}

export type ExtractOutcome = "pending" | "unchanged" | "linked" | "needsLocal" | "retry" | "failed" | "not-open";

/** The answer to a queued or runner-bound page: a listing, or a C3 error. */
export async function applyExtract(
  db: Db,
  args: { stagingId: string; listing?: any; error?: { code: string; message: string; retryable?: boolean }; now: number },
): Promise<{ outcome: ExtractOutcome; match?: any }> {
  const { stagingId, listing, error, now } = args;
  const row = await db.get(stagingId as any);
  if (!row || !["queued", "needsLocal"].includes((row as any).status)) return { outcome: "not-open" };
  const r = row as any;
  const attempts = r.attempts + 1;

  if (listing) {
    if (listing.isMug?.verdict === "no") {
      await db.patch(r._id, { status: "rejected", attempts, error: { code: "not-a-mug", message: listing.isMug.reason }, updatedAt: now });
      await bumpRun(db, r.runId, { skipped: 1 }, now);
      return { outcome: "failed" };
    }
    const match = await matchListing(db, listing);
    if (match.kind === "same") {
      const outcome = await settleSame(db, match, listing, r.sourceId, now);
      await db.delete(r._id);
      await bumpRun(db, r.runId, { unchanged: 1 }, now);
      return { outcome };
    }
    await db.patch(r._id, compact({
      listing,
      match: storedMatch(match),
      status: "pending" as const,
      key: listing.source.key,
      url: listing.source.url ?? r.url,
      attempts,
      error: undefined,
      updatedAt: now,
    }));
    await bumpRun(db, r.runId, { staged: 1 }, now);
    return { outcome: "pending", match: storedMatch(match) };
  }

  const failure = { code: String(error?.code || "INTERNAL").slice(0, 40), message: String(error?.message || "No answer").slice(0, 300) };
  if (BLOCKED_CODES.includes(failure.code) && r.status !== "needsLocal") {
    await db.patch(r._id, { status: "needsLocal", attempts, error: failure, updatedAt: now });
    await bumpRun(db, r.runId, { needsLocal: 1 }, now);
    return { outcome: "needsLocal" };
  }
  // A12: a robots.txt that could not be read is a refusal for now; a real
  // Disallow never comes back retryable, so it is still final.
  const retryable = RETRY_CODES.includes(failure.code) || (failure.code === "ROBOTS_DISALLOWED" && error?.retryable === true);
  if (retryable && attempts < MAX_ATTEMPTS) {
    await db.patch(r._id, { status: r.status, attempts, error: failure, updatedAt: now });
    return { outcome: "retry" };
  }
  await db.patch(r._id, { status: "failed", attempts, error: failure, updatedAt: now });
  await bumpRun(db, r.runId, { failed: 1 }, now);
  return { outcome: "failed" };
}
