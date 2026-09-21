// A mug's imageState from what it holds (docs/CONTRACTS.md C4.3, A9). One
// function, so the mirror, the runner and a retry cannot disagree about it.
//
// pending: remote URLs still to fetch. With blocked, the image host refused
// the Worker and the runner will try; without, the last attempt failed.
// failed: URLs the runner could not fetch either; `images:retry` tries again.

export type ImageState = "none" | "pending" | "blocked" | "failed" | "thumbs" | "ok";

export function imageStateOf(
  images: { thumb?: string }[],
  pending: string[],
  failed: string[],
  blocked: boolean,
): ImageState {
  if (pending.length) return blocked ? "blocked" : "failed";
  if (!images.length) return failed.length ? "failed" : "none";
  return images.every((ref) => ref.thumb) ? "ok" : "thumbs";
}
