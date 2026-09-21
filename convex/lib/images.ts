// C4.3: browsers never see an image reference, only URLs. An R2 key becomes
// <images base>/<key>; a Convex storage id becomes its storage URL.

export type ImageEnv = { MUG_IMAGES_BASE?: string; MUG_PROXY_URL?: string };
export type Resolved = { src: string; thumb: string; w?: number; h?: number };

export function imagesEnv(): ImageEnv {
  return { MUG_IMAGES_BASE: process.env.MUG_IMAGES_BASE, MUG_PROXY_URL: process.env.MUG_PROXY_URL };
}

export function imagesBase(env: ImageEnv): string | null {
  if (env.MUG_IMAGES_BASE) return env.MUG_IMAGES_BASE.replace(/\/+$/, "");
  if (env.MUG_PROXY_URL) return `${env.MUG_PROXY_URL.replace(/\/+$/, "")}/i`;
  return null;
}

type Storage = { getUrl(id: any): Promise<string | null> };

async function urlOf(storage: Storage, store: string, key: string | undefined, base: string | null): Promise<string | null> {
  if (!key) return null;
  if (store === "r2") return base ? `${base}/${key}` : null;
  return await storage.getUrl(key as any);
}

export async function resolveRef(storage: Storage, ref: any, base: string | null): Promise<Resolved | null> {
  if (!ref) return null;
  const src = await urlOf(storage, ref.store, ref.key, base);
  if (!src) return null;
  const thumb = (await urlOf(storage, ref.store, ref.thumb, base)) || src;
  const out: Resolved = { src, thumb };
  if (ref.w) out.w = ref.w;
  if (ref.h) out.h = ref.h;
  return out;
}

/** The first image, for cards. */
export async function coverOf(storage: Storage, mug: any, base: string | null): Promise<Resolved | null> {
  return mug.images && mug.images.length ? await resolveRef(storage, mug.images[0], base) : null;
}
