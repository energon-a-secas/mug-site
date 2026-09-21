import type { GenericDatabaseWriter } from "convex/server";
import { LIMITS } from "../../shared/contract.js";
import { imageStateOf } from "./imageState.ts";

// The runner's image bookkeeping (docs/CONTRACTS.md C8, A9), as a core so the
// tests can run it: plain node on tests/support/fakedb.mjs.

type Db = GenericDatabaseWriter<any>;

/** Which pending image a runner means: its URL when sent (A9), else its position. */
export function pendingIndex(mug: any, index: number, url?: string): number {
  if (url) return mug.pendingImages.indexOf(url);
  return Number.isInteger(index) && mug.pendingImages[index] ? index : -1;
}

/**
 * A9: the runner could not fetch a blocked image either. The URL leaves the
 * pending list for failedImages, so the next drain stops asking for it, and
 * images:retry can send it round again.
 */
export async function imageFailure(db: Db, rawMugId: string, index: number, url: string | undefined, error: any, now: number) {
  if (!error) return { ok: false, code: "bad-body", message: "An image item reports only an error here; send its bytes to /runner/image." };
  const mugId = (db as any).normalizeId ? (db as any).normalizeId("mugs", rawMugId) : rawMugId;
  const mug = mugId ? await db.get(mugId as any) : null;
  const at = mug ? pendingIndex(mug, index, url) : -1;
  if (!mug || at < 0) return { ok: false, code: "not-pending", message: "That image is not waiting any more." };
  const failedUrl = mug.pendingImages[at];
  const pendingImages = mug.pendingImages.filter((_: string, i: number) => i !== at);
  const failedImages = [...(mug.failedImages ?? []).filter((u: string) => u !== failedUrl), failedUrl].slice(-LIMITS.images);
  await db.patch(mug._id, {
    pendingImages,
    failedImages,
    imageState: imageStateOf(mug.images, pendingImages, failedImages, pendingImages.length > 0),
    updatedAt: now,
  });
  return { ok: true, status: "failed", code: String(error.code || "").slice(0, 40) };
}
