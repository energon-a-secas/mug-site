import type { GenericDatabaseWriter } from "convex/server";
import { bump, STAT } from "./counters.ts";
import { ensureProfile } from "./profilesCore.ts";
import { checkRate, rateFailure, recordRate } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Result } from "./result.ts";
import { cleanText, compact } from "./util.ts";

// A collector's shelf: owned, wanted and once-owned ("had") mugs. Every
// transition moves the mug's counters, the profile's counters and the
// community totals together, in this one mutation.

type Db = GenericDatabaseWriter<any>;
type State = "owned" | "wanted" | "had";

const STATES: State[] = ["owned", "wanted", "had"];
const CONDITIONS = ["mint", "boxed", "used", "chipped"];

function deltas(from: State | null, to: State | null) {
  const d = { owned: 0, wanted: 0 };
  if (from === "owned") d.owned -= 1;
  if (from === "wanted") d.wanted -= 1;
  if (to === "owned") d.owned += 1;
  if (to === "wanted") d.wanted += 1;
  return d;
}

async function moveCounters(db: Db, mug: any, profile: any, from: State | null, to: State | null) {
  const d = deltas(from, to);
  if (!d.owned && !d.wanted) return;
  await db.patch(mug._id, {
    ownedCount: Math.max(0, mug.ownedCount + d.owned),
    wantedCount: Math.max(0, mug.wantedCount + d.wanted),
  });
  await db.patch(profile._id, {
    ownedCount: Math.max(0, profile.ownedCount + d.owned),
    wantedCount: Math.max(0, profile.wantedCount + d.wanted),
  });
  await bump(db, STAT.owned, d.owned);
  await bump(db, STAT.wanted, d.wanted);
}

/** state null removes the mug from the shelf. */
export async function setShelfState(
  db: Db,
  args: { subject: string; mugId: string; state: State | null; now: number },
): Promise<Result> {
  const { subject, mugId, state, now } = args;
  if (state !== null && !STATES.includes(state)) return fail("bad-state", "A shelf state is owned, wanted or had.");
  const mug = await db.get(mugId as any);
  if (!mug) return fail("no-mug", "That mug is not in the catalogue.");
  const existing = await db
    .query("shelfItems")
    .withIndex("by_subject_mug", (q: any) => q.eq("subject", subject).eq("mugId", mugId))
    .unique();
  const from: State | null = existing ? existing.state : null;
  if (from === state) return done({ state, changed: false });
  // A hidden mug can leave a shelf but cannot join one.
  if (state !== null && (mug as any).status !== "published" && !existing) {
    return fail("no-mug", "That mug is not in the catalogue.");
  }
  const verdict = await checkRate(db, subject, "shelf.write", now);
  if (!verdict.allowed) return rateFailure(verdict, "shelf changes");

  const profile = await ensureProfile(db, subject, now);
  await moveCounters(db, mug, profile, from, state);
  if (state === null) await db.delete(existing._id);
  else if (existing) await db.patch(existing._id, { state, updatedAt: now });
  else await db.insert("shelfItems", { subject, mugId, state, createdAt: now, updatedAt: now } as any);
  await recordRate(db, subject, "shelf.write", now);
  return done({ state, changed: true });
}

/** Notes, condition, price paid and date, on a mug already on the shelf. */
export async function updateShelfItem(
  db: Db,
  args: { subject: string; mugId: string; patch: Record<string, unknown>; now: number },
): Promise<Result> {
  const { subject, mugId, patch, now } = args;
  const item = await db
    .query("shelfItems")
    .withIndex("by_subject_mug", (q: any) => q.eq("subject", subject).eq("mugId", mugId))
    .unique();
  if (!item) return fail("not-on-shelf", "Add the mug to your shelf first.");
  const next: Record<string, unknown> = { updatedAt: now };
  if (patch.note !== undefined) next.note = cleanText(patch.note, 500) || undefined;
  if (patch.condition !== undefined) {
    if (patch.condition !== null && patch.condition !== "" && !CONDITIONS.includes(patch.condition as string)) {
      return fail("bad-condition", `Condition is one of ${CONDITIONS.join(", ")}.`);
    }
    next.condition = patch.condition || undefined;
  }
  if (patch.pricePaid !== undefined) {
    if (patch.pricePaid === null || patch.pricePaid === "") next.pricePaid = undefined;
    else {
      const amount = Number(patch.pricePaid);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000) return fail("bad-price", "Price paid must be between 0 and 100000.");
      next.pricePaid = Math.round(amount * 100) / 100;
    }
  }
  if (patch.currency !== undefined) {
    const currency = typeof patch.currency === "string" ? patch.currency.trim().toUpperCase() : "";
    if (currency && !/^[A-Z]{3}$/.test(currency)) return fail("bad-currency", "Currency is a three-letter code such as USD.");
    next.currency = currency || undefined;
  }
  if (patch.acquiredOn !== undefined) {
    const day = typeof patch.acquiredOn === "string" ? patch.acquiredOn.trim() : "";
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)))) {
      return fail("bad-date", "The date is YYYY-MM-DD.");
    }
    next.acquiredOn = day || undefined;
  }
  const verdict = await checkRate(db, subject, "shelf.write", now);
  if (!verdict.allowed) return rateFailure(verdict, "shelf changes");
  await db.patch(item._id, next);
  await recordRate(db, subject, "shelf.write", now);
  return done();
}

export { compact };
