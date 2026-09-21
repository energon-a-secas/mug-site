import type { GenericDatabaseWriter } from "convex/server";
import { LIMITS } from "../../shared/contract.js";
import { seenOf } from "./matchCore.ts";
import { applyMugPatch, cleanEdits, createMug, fieldPatch, linkFor, resolveNames } from "./mugCore.ts";
import type { Edits } from "./mugCore.ts";
import { done, fail } from "./result.ts";
import type { Result } from "./result.ts";
import { compact } from "./util.ts";

// The admin's answers to the review queue (docs/CONTRACTS.md C7): approve a
// listing as a new mug or as an update to the one it changed, merge it into a
// mug the admin picks, or reject it. Each answer records who gave it.

type Db = GenericDatabaseWriter<any>;

async function pendingRow(db: Db, stagingId: string): Promise<any | Result> {
  const row = await db.get(stagingId as any);
  if (!row) return fail("not-found", "That queue item no longer exists.");
  if ((row as any).status !== "pending" || !(row as any).listing) {
    return fail("not-pending", `That queue item is ${(row as any).status}, not waiting for review.`);
  }
  return row;
}

/** Point the listing's shop page at mugId, whatever it pointed at before. */
async function upsertSource(db: Db, row: any, mugId: string, now: number) {
  const listing = row.listing;
  const existing = await db.query("mugSources").withIndex("by_key", (q: any) => q.eq("key", listing.source.key)).first();
  const fields = compact({ mugId, sourceId: row.sourceId, url: listing.source.url, seen: seenOf(listing), lastSeenAt: now });
  if (existing) await db.patch(existing._id, fields);
  else await db.insert("mugSources", { key: listing.source.key, ...fields } as any);
}

async function closeRow(db: Db, row: any, mugId: string, subject: string, now: number) {
  await db.patch(row._id, { status: "approved", mugId, reviewedBy: subject, reviewedAt: now, updatedAt: now });
}

/**
 * The listing's facts into an existing mug. Changed fields (C7) and blanks take
 * the shop's value; everything the admin curated otherwise stays; the admin's
 * own edits win over both. New images are queued for mirroring.
 */
async function mergeListing(db: Db, mug: any, row: any, edits: Edits, changed: string[] | "all", now: number) {
  const listing = row.listing;
  const takes = (field: string) => changed === "all" || changed.includes(field);
  const patch: Record<string, unknown> = {};
  const fill = (field: string, value: unknown, alwaysWhenChanged = true) => {
    if (value === undefined) return;
    if (mug[field] === undefined || (alwaysWhenChanged && takes(field))) patch[field] = value;
  };
  fill("name", listing.name);
  fill("capacityMl", listing.capacityMl);
  fill("gtin", listing.gtin);
  fill("sku", listing.sku);
  if (listing.style !== "other" && (mug.style === "other" || takes("style"))) patch.style = listing.style;
  for (const field of ["material", "hasLid", "dishwasherSafe", "microwaveSafe", "character"]) fill(field, listing[field], false);
  if (listing.price) patch.lastPrice = { ...listing.price, at: now };

  const known = new Set<string>([...mug.pendingImages, ...mug.images.map((ref: any) => ref.source).filter(Boolean)]);
  const offered: string[] = edits.images ?? listing.images;
  const fresh = takes("images") || mug.images.length + mug.pendingImages.length === 0 ? offered.filter((url) => !known.has(url)) : [];
  if (fresh.length) {
    patch.pendingImages = [...mug.pendingImages, ...fresh].slice(0, LIMITS.images);
    patch.imageState = "pending";
  }

  const link = linkFor(listing);
  if (link && !mug.links.some((l: any) => l.url === link.url)) patch.links = [...mug.links, compact(link)];

  const nameEdits: Edits = {};
  if (mug.brandId === undefined && listing.brand) nameEdits.brand = listing.brand;
  if (mug.franchiseId === undefined && listing.franchise) nameEdits.franchise = listing.franchise;
  Object.assign(patch, await resolveNames(db, { ...nameEdits, ...pickNames(edits) }, now));
  Object.assign(patch, fieldPatch(edits));
  if (edits.status) patch.status = edits.status;

  const updated = await applyMugPatch(db, mug, patch, now);
  return { mug: updated, images: fresh.length > 0 };
}

function pickNames(edits: Edits): Edits {
  const out: Edits = {};
  if (edits.brand !== undefined) out.brand = edits.brand;
  if (edits.franchise !== undefined) out.franchise = edits.franchise;
  return out;
}

/**
 * Approve: a "changed" row updates the mug it matched; "new" and "similar"
 * make a new mug (for "similar" the admin has looked and said it differs).
 */
export async function approveStaging(
  db: Db,
  args: { stagingId: string; edits?: unknown; subject: string; now: number },
): Promise<Result> {
  const row = await pendingRow(db, args.stagingId);
  if ((row as any).ok === false) return row as Result;
  const checked = cleanEdits(args.edits);
  if (!checked.ok) return checked;
  const r = row as any;

  if (r.match?.kind === "changed" && r.match.mugId) {
    const mug = await db.get(r.match.mugId);
    if (mug) {
      const { mug: updated, images } = await mergeListing(db, mug, r, checked.edits, r.match.fields, args.now);
      await upsertSource(db, r, updated._id, args.now);
      await closeRow(db, r, updated._id, args.subject, args.now);
      return done({ mugId: updated._id, slug: updated.slug, created: false, scheduleImages: images });
    }
  }
  const mug = await createMug(db, r.listing, checked.edits, args.now);
  await upsertSource(db, r, mug._id, args.now);
  await closeRow(db, r, mug._id, args.subject, args.now);
  return done({ mugId: mug._id, slug: mug.slug, created: true, scheduleImages: mug.pendingImages.length > 0 });
}

/** Merge: the admin says this listing is that mug. Every field the shop gives is offered. */
export async function mergeStaging(
  db: Db,
  args: { stagingId: string; mugId: string; edits?: unknown; subject: string; now: number },
): Promise<Result> {
  const row = await pendingRow(db, args.stagingId);
  if ((row as any).ok === false) return row as Result;
  const checked = cleanEdits(args.edits);
  if (!checked.ok) return checked;
  const mug = await db.get(args.mugId as any);
  if (!mug) return fail("no-mug", "The mug to merge into no longer exists.");
  // Merging keeps the target's curated fields; only blanks and images are filled.
  const { mug: updated, images } = await mergeListing(db, mug, row, checked.edits, ["images"], args.now);
  await upsertSource(db, row, updated._id, args.now);
  await closeRow(db, row, updated._id, args.subject, args.now);
  return done({ mugId: updated._id, slug: updated.slug, created: false, scheduleImages: images });
}

export async function rejectStaging(db: Db, args: { stagingId: string; subject: string; now: number }): Promise<Result> {
  const row = await db.get(args.stagingId as any);
  if (!row) return fail("not-found", "That queue item no longer exists.");
  const status = (row as any).status;
  if (status === "approved" || status === "rejected") return fail("closed", `That queue item is already ${status}.`);
  await db.patch((row as any)._id, { status: "rejected", reviewedBy: args.subject, reviewedAt: args.now, updatedAt: args.now });
  return done();
}
