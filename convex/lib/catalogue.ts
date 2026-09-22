import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { brandVariants, fold, nameKey, slugify } from "../../shared/extract/names.js";

// Catalogue helpers shared by the cores: finding or creating brands and
// franchises, free mug slugs, and the searchable text. No identity checks
// here; callers have done them.

type Reader = GenericDatabaseReader<any>;
type Writer = GenericDatabaseWriter<any>;

// The brand table is small (a few hundred rows at most), so matching reads it
// whole rather than keeping an alias index in step.
const BRAND_SCAN_MAX = 1000;

export async function findBrand(db: Reader, name: string | undefined | null): Promise<any | null> {
  const variants = brandVariants(name || "");
  if (!variants.length) return null;
  const bySlug = await db.query("brands").withIndex("by_slug", (q: any) => q.eq("slug", slugify(name))).unique();
  if (bySlug) return bySlug;
  const wanted = new Set(variants);
  for (const brand of await db.query("brands").take(BRAND_SCAN_MAX)) {
    if ((brand.aliases || []).some((alias: string) => wanted.has(alias))) return brand;
  }
  return null;
}

export async function findOrCreateBrand(db: Writer, name: string, now: number): Promise<any> {
  const found = await findBrand(db, name);
  if (found) return found;
  const bare = brandVariants(name).find((v) => !v.includes(" ")) || fold(name);
  const slug = await freeSlug(db, "brands", slugify(name) || slugify(bare) || "brand");
  const id = await db.insert("brands", {
    slug,
    name: name.trim(),
    aliases: brandVariants(name),
    mugCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return await db.get(id);
}

export async function findFranchise(db: Reader, name: string | undefined | null): Promise<any | null> {
  const slug = slugify(name || "");
  if (!slug) return null;
  return await db.query("franchises").withIndex("by_slug", (q: any) => q.eq("slug", slug)).unique();
}

export async function findOrCreateFranchise(db: Writer, name: string, now: number): Promise<any> {
  const found = await findFranchise(db, name);
  if (found) return found;
  const id = await db.insert("franchises", {
    slug: slugify(name),
    name: name.trim(),
    mugCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return await db.get(id);
}

async function freeSlug(db: Reader, table: "brands" | "mugs", base: string): Promise<string> {
  const root = base || "item";
  for (let n = 1; n < 200; n++) {
    const slug = n === 1 ? root : `${root}-${n}`;
    const taken = await db.query(table).withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
    if (!taken) return slug;
  }
  throw new Error(`no free slug for ${root}`);
}

/** "pikachu-3d-mug", then "pikachu-3d-mug-abystyle", then numbered. */
export async function uniqueMugSlug(db: Reader, name: string, brandSlug?: string): Promise<string> {
  const base = slugify(name, 70) || "mug";
  const plain = await db.query("mugs").withIndex("by_slug", (q: any) => q.eq("slug", base)).first();
  if (!plain) return base;
  if (brandSlug) {
    const branded = `${base}-${brandSlug}`.slice(0, 90);
    const taken = await db.query("mugs").withIndex("by_slug", (q: any) => q.eq("slug", branded)).first();
    if (!taken) return branded;
  }
  return await freeSlug(db, "mugs", base);
}

/** What the search index reads: every name a visitor might type, folded. */
export function searchTextFor(parts: {
  name: string;
  brand?: string | null;
  franchise?: string | null;
  character?: string | null;
  style?: string | null;
  sku?: string | null;
  gtin?: string | null;
}): string {
  return [parts.name, parts.brand, parts.franchise, parts.character, parts.style, parts.sku, parts.gtin]
    .filter(Boolean)
    .map((part) => fold(part))
    .join(" ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A16: the catalogue's default order puts sculpted and shaped mugs first,
// then the other three-dimensional kinds, then everything else, newest first
// within each. One number carries both, so a single descending index serves
// it: the weight in the high digits, publishedAt (about 1.8e12) below them.
const FEATURED_WEIGHT: Record<string, number> = { sculpted: 3, shaped: 3, relief: 2, tiki: 2, teapot: 2, stein: 1 };

/** The sort key for "3D and shaped first": higher sorts first. */
export function featuredKey(style: string | undefined, publishedAt: number): number {
  return (FEATURED_WEIGHT[style ?? ""] ?? 0) * 1e13 + publishedAt;
}

export function mugNameKey(name: string, brand?: string | null): string {
  return nameKey(name, brand || undefined) || slugify(name);
}
