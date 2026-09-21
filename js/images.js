// ── Resizing in the browser ───────────────────────────────────
// Free-plan Workers cannot decode images within their CPU budget, so the
// person uploading pays for it (docs/CONTRACTS.md C4.4): collectors' photos
// shrink to 1600 px before upload, and the admin page makes 480 px thumbnails.

/** A Blob no wider or taller than max, as WebP when the browser can encode it, else JPEG. */
export async function resize(source, max, quality = 0.82) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const encode = async (type) =>
    canvas.convertToBlob ? await canvas.convertToBlob({ type, quality }) : await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  return { blob, width, height };
}

/** POST a Blob to a Convex upload URL; resolves to the storage id. */
export async function upload(uploadUrl, blob) {
  const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  const { storageId } = await res.json();
  return storageId;
}
