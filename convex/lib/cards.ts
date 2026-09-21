import { coverOf } from "./images.ts";

// The mug summary every list shows (catalogue grid, shelves, community). One
// shape, so the pages render cards from one function.

type Ctx = { db: any; storage: any };

export type Card = {
  slug: string;
  name: string;
  brand: { slug: string; name: string } | null;
  franchise: string | null;
  character: string | null;
  style: string;
  capacityMl: number | null;
  image: { src: string; thumb: string; w?: number; h?: number } | null;
  ownedCount: number;
  wantedCount: number;
};

export function cardCache() {
  return { brands: new Map<string, any>(), franchises: new Map<string, any>() };
}

async function cached(ctx: Ctx, map: Map<string, any>, id: string | undefined) {
  if (!id) return null;
  if (!map.has(id)) map.set(id, await ctx.db.get(id));
  return map.get(id) || null;
}

export async function cardFor(ctx: Ctx, mug: any, cache: ReturnType<typeof cardCache>, base: string | null): Promise<Card> {
  const brand = await cached(ctx, cache.brands, mug.brandId);
  const franchise = await cached(ctx, cache.franchises, mug.franchiseId);
  return {
    slug: mug.slug,
    name: mug.name,
    brand: brand ? { slug: brand.slug, name: brand.name } : null,
    franchise: franchise ? franchise.name : null,
    character: mug.character ?? null,
    style: mug.style,
    capacityMl: mug.capacityMl ?? null,
    image: await coverOf(ctx.storage, mug, base),
    ownedCount: mug.ownedCount,
    wantedCount: mug.wantedCount,
  };
}
