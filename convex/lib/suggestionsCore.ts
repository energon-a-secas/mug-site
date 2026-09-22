import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { cleanEdits, saveMugEdits } from "./mugCore.ts";
import type { Edits } from "./mugCore.ts";
import { profileOf } from "./profilesCore.ts";
import { checkRate, rateFailure, recordRate } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure } from "./result.ts";
import { cleanText } from "./util.ts";

// A17: collectors propose corrections to a mug's labels, and an admin decides.
// A proposal is checked by the same cleanEdits an admin's own edit is, holds
// only the fields that differ from the mug, and is applied through
// saveMugEdits, so counters, searchText and the featured key move exactly as
// they do when an admin edits the mug. A new franchise, character or maker
// named in a proposal only comes into being when it is approved.

type Db = GenericDatabaseWriter<any>;
type Reader = GenericDatabaseReader<any>;

/** What a collector may propose: the labels a mug page shows. */
export const LABEL_FIELDS = [
  "name", "brand", "franchise", "character", "style", "capacityMl", "material",
  "hasLid", "dishwasherSafe", "microwaveSafe", "releaseYear",
] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];
export const NOTE_MAX = 300;
export const REASON_MAX = 200;

/** A mug's labels as a collector sees them: names rather than ids, null when unknown. */
export async function currentLabels(db: Reader, mug: any): Promise<Record<LabelField, unknown>> {
  const brand = mug.brandId ? await db.get(mug.brandId) : null;
  const franchise = mug.franchiseId ? await db.get(mug.franchiseId) : null;
  return {
    name: mug.name,
    brand: brand ? (brand as any).name : null,
    franchise: franchise ? (franchise as any).name : null,
    character: mug.character ?? null,
    style: mug.style,
    capacityMl: mug.capacityMl ?? null,
    material: mug.material ?? null,
    hasLid: mug.hasLid ?? null,
    dishwasherSafe: mug.dishwasherSafe ?? null,
    microwaveSafe: mug.microwaveSafe ?? null,
    releaseYear: mug.releaseYear ?? null,
  };
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return (a ?? null) === (b ?? null);
}

/**
 * A proposal's real changes: label fields only, each checked by cleanEdits,
 * and only those that differ from `current`. Changing nothing is refused
 * rather than queued.
 */
export function labelChanges(raw: unknown, current: Record<string, unknown>): { ok: true; changes: Edits } | Failure {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("bad-changes", "Send the labels as an object.");
  const input = raw as Record<string, unknown>;
  const foreign = Object.keys(input).filter((key) => !(LABEL_FIELDS as readonly string[]).includes(key));
  if (foreign.length) return fail("bad-field", `Only a mug's labels can be suggested, not ${foreign.join(", ")}.`);
  const checked = cleanEdits(input);
  if (!checked.ok) return checked;
  const changes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(checked.edits)) {
    if (!same(value, current[field])) changes[field] = value;
  }
  if (!Object.keys(changes).length) return fail("no-change", "That is what the mug already says.");
  return { ok: true, changes: changes as Edits };
}

/**
 * A signed-in collector's proposal for a published mug. One pending proposal
 * per collector per mug: a second one replaces the first. Every send counts
 * against the collector's daily allowance, replacements included.
 */
export async function createSuggestion(
  db: Db,
  args: { subject: string; mug: any; changes: unknown; note?: unknown; now: number },
) {
  const { subject, mug, now } = args;
  if (!mug || mug.status !== "published") return fail("not-found", "That mug is not in the catalogue.");
  const profile = await profileOf(db, subject);
  if (profile?.suspended) return fail("suspended", "This account cannot suggest changes.");
  const checked = labelChanges(args.changes, await currentLabels(db, mug));
  if (!checked.ok) return checked;
  const note = cleanText(args.note, NOTE_MAX) || undefined;

  const verdict = await checkRate(db, subject, "suggestion.create", now);
  if (!verdict.allowed) return rateFailure(verdict, "suggestions");
  await recordRate(db, subject, "suggestion.create", now);

  const existing = await db
    .query("suggestions")
    .withIndex("by_mug_subject", (q: any) => q.eq("mugId", mug._id).eq("subject", subject).eq("status", "pending"))
    .first();
  if (existing) {
    await db.patch(existing._id, { changes: checked.changes, note, updatedAt: now });
    return done({ id: existing._id, replaced: true, fields: Object.keys(checked.changes) });
  }
  const id = await db.insert("suggestions", {
    mugId: mug._id,
    subject,
    changes: checked.changes,
    ...(note ? { note } : {}),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return done({ id, replaced: false, fields: Object.keys(checked.changes) });
}

/**
 * An admin's decision. Approving re-reads the mug as it is now: a field that
 * already says what was proposed is dropped, and the rest go through
 * saveMugEdits. Rejecting only records the decision.
 */
export async function decideSuggestion(
  db: Db,
  args: { id: string; approve: boolean; admin: string; reason?: unknown; now: number },
) {
  const { approve, admin, now } = args;
  const row: any = await db.get(args.id as any);
  if (!row) return fail("not-found", "That suggestion no longer exists.");
  if (row.status !== "pending") return fail("decided", "That suggestion was already decided.");
  const reason = cleanText(args.reason, REASON_MAX) || undefined;
  const decided = { decidedAt: now, decidedBy: admin, updatedAt: now, ...(reason ? { reason } : {}) };
  if (!approve) {
    await db.patch(row._id, { status: "rejected", ...decided });
    return done({ status: "rejected" });
  }
  const mug: any = await db.get(row.mugId);
  if (!mug) {
    await db.patch(row._id, { status: "rejected", ...decided, reason: "The mug no longer exists." });
    return fail("gone", "The mug no longer exists, so the suggestion was closed.");
  }
  const checked = labelChanges(row.changes, await currentLabels(db, mug));
  if (!checked.ok && checked.code !== "no-change") return checked;
  const applied = checked.ok ? Object.keys(checked.changes) : [];
  if (checked.ok) await saveMugEdits(db, mug, checked.changes, now);
  await db.patch(row._id, { status: "approved", ...decided });
  return done({ status: "approved", applied, slug: mug.slug });
}

/** The admin's queue, oldest first: each field as it is and as proposed, and who proposed it. */
export async function pendingSuggestions(db: Reader, limit = 100) {
  const rows = await db.query("suggestions").withIndex("by_status", (q: any) => q.eq("status", "pending")).order("asc").take(limit);
  const out = [];
  for (const row of rows as any[]) {
    const mug: any = await db.get(row.mugId);
    const current = mug ? await currentLabels(db, mug) : null;
    const profile = await profileOf(db, row.subject);
    out.push({
      id: row._id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      note: row.note ?? null,
      mug: mug ? { slug: mug.slug, name: mug.name, hidden: mug.status !== "published" } : null,
      changes: Object.entries(row.changes as Record<string, unknown>).map(([field, to]) => ({
        field,
        from: current ? ((current as any)[field] ?? null) : null,
        to: to ?? null,
      })),
      by: profile ? { handle: profile.handle ?? null, name: profile.displayName ?? null } : null,
    });
  }
  return out;
}

/** The viewer's own pending proposal for a mug, for the mug page: which fields, and since when. */
export async function mySuggestion(db: Reader, mugId: string, subject: string) {
  const row: any = await db
    .query("suggestions")
    .withIndex("by_mug_subject", (q: any) => q.eq("mugId", mugId).eq("subject", subject).eq("status", "pending"))
    .first();
  return row ? { fields: Object.keys(row.changes), createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
}
