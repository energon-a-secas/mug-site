import type { GenericDatabaseWriter } from "convex/server";
import { LIMITS, RATE_PRUNE_MAX } from "./limits.ts";
import type { LimitName } from "./limits.ts";
import { fail } from "./result.ts";
import type { Failure } from "./result.ts";

// vitrina's rate limiter (projects/vitrina-site/convex/lib/rate.ts), unchanged
// in shape: a sliding window over rateEvents rows, checked inside the caller's
// own transaction, answering with a failure rather than throwing. Check and
// record are separate, so a refused change does not spend an allowance.

type Db = GenericDatabaseWriter<any>;

export type Verdict = { allowed: boolean; used: number; max: number; retryAfterMs: number };

export function bucketFor(subject: string, name: LimitName): string {
  return `${subject}|${name}`;
}

export async function checkRate(db: Db, subject: string, name: LimitName, now: number): Promise<Verdict> {
  const { max, windowMs } = LIMITS[name];
  const bucket = bucketFor(subject, name);
  const cutoff = now - windowMs;
  const recent = await db
    .query("rateEvents")
    .withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucket).gte("at", cutoff))
    .take(max);
  const stale = await db
    .query("rateEvents")
    .withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucket).lt("at", cutoff))
    .take(RATE_PRUNE_MAX);
  for (const row of stale) await db.delete(row._id);
  if (recent.length >= max) {
    return { allowed: false, used: recent.length, max, retryAfterMs: Math.max(0, recent[0].at + windowMs - now) };
  }
  return { allowed: true, used: recent.length, max, retryAfterMs: 0 };
}

export async function recordRate(db: Db, subject: string, name: LimitName, now: number): Promise<void> {
  await db.insert("rateEvents", { bucket: bucketFor(subject, name), at: now });
}

function wait(ms: number): string {
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function rateFailure(verdict: Verdict, what: string): Failure {
  return fail("rate-limited", `Too many ${what} for now. Try again in ${wait(verdict.retryAfterMs)}.`, {
    retryAfterMs: verdict.retryAfterMs,
  });
}
