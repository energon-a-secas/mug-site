import type { GenericDatabaseWriter } from "convex/server";
import { LIMITS, MATERIALS, STYLES } from "../../shared/contract.js";
import { normalizeGtin } from "../../shared/extract/names.js";
import { canonicalUrl, hostOf } from "../../shared/extract/normalize.js";
import { findOrCreateBrand, findOrCreateFranchise, mugNameKey, searchTextFor, uniqueMugSlug } from "./catalogue.ts";
import { bump, STAT } from "./counters.ts";
import { fail } from "./result.ts";
import type { Failure } from "./result.ts";
import { cleanText, compact } from "./util.ts";

// A mug's fields and the counters that depend on them. Every change to a mug
// goes through applyMugPatch, which is the only place brand, franchise, style
// and status counters move, and the only place searchText and nameKey are
// recomputed. Creation goes through createMug for the same reason.

type Db = GenericDatabaseWriter<any>;

// null means "clear this field"; undefined means "leave it".
export type Edits = {
  name?: string;
  brand?: string | null;
  franchise?: string | null;
  character?: string | null;
  style?: string;
  capacityMl?: number | null;
  material?: string | null;
  hasLid?: boolean | null;
  dishwasherSafe?: boolean | null;
  microwaveSafe?: boolean | null;
  sku?: string | null;
  gtin?: string | null;
  releaseYear?: number | null;
  blurb?: string | null;
  images?: string[];
  status?: "published" | "hidden";
};

const TEXT_FIELDS: [keyof Edits, number][] = [
  ["brand", LIMITS.brand],
  ["franchise", LIMITS.franchise],
  ["character", LIMITS.character],
  ["sku", LIMITS.sku],
  ["blurb", 500],
];

/** Every edit a person sends is checked here, so a function's validator is not the only guard. */
export function cleanEdits(raw: unknown): { ok: true; edits: Edits } | Failure {
  if (raw === undefined || raw === null) return { ok: true, edits: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("bad-edits", "Edits have to be an object.");
  const input = raw as Record<string, unknown>;
  const edits: Edits = {};

  if (input.name !== undefined) {
    const name = cleanText(input.name, LIMITS.name);
    if (!name) return fail("bad-name", "A mug needs a name.");
    edits.name = name;
  }
  for (const [field, max] of TEXT_FIELDS) {
    if (input[field] === undefined) continue;
    const text = input[field] === null ? "" : cleanText(input[field], max);
    (edits as any)[field] = text || null;
  }
  if (input.style !== undefined) {
    if (!STYLES.includes(input.style as string)) return fail("bad-style", `Style must be one of ${STYLES.join(", ")}.`);
    edits.style = input.style as string;
  }
  if (input.material !== undefined) {
    if (input.material !== null && input.material !== "" && !MATERIALS.includes(input.material as string)) {
      return fail("bad-material", `Material must be one of ${MATERIALS.join(", ")}.`);
    }
    edits.material = (input.material as string) || null;
  }
  if (input.capacityMl !== undefined) {
    if (input.capacityMl === null || input.capacityMl === "") edits.capacityMl = null;
    else {
      const ml = Math.round(Number(input.capacityMl));
      if (!Number.isFinite(ml) || ml < LIMITS.capacityMinMl || ml > LIMITS.capacityMaxMl) {
        return fail("bad-capacity", `Capacity must be between ${LIMITS.capacityMinMl} and ${LIMITS.capacityMaxMl} ml.`);
      }
      edits.capacityMl = ml;
    }
  }
  for (const field of ["hasLid", "dishwasherSafe", "microwaveSafe"] as const) {
    if (input[field] === undefined) continue;
    if (input[field] !== null && typeof input[field] !== "boolean") return fail("bad-flag", `${field} must be true, false or null.`);
    edits[field] = input[field] as boolean | null;
  }
  if (input.gtin !== undefined) {
    if (input.gtin === null || input.gtin === "") edits.gtin = null;
    else {
      const gtin = normalizeGtin(input.gtin);
      if (!gtin) return fail("bad-gtin", "That barcode does not verify: check the digits.");
      edits.gtin = gtin;
    }
  }
  if (input.releaseYear !== undefined) {
    if (input.releaseYear === null || input.releaseYear === "") edits.releaseYear = null;
    else {
      const year = Number(input.releaseYear);
      if (!Number.isInteger(year) || year < 1900 || year > 2100) return fail("bad-year", "Release year must be a four-digit year.");
      edits.releaseYear = year;
    }
  }
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || input.images.length > LIMITS.images) return fail("bad-images", "Images must be a list of up to 12 URLs.");
    const urls = input.images.map((u) => canonicalUrl(u));
    if (urls.some((u) => !u)) return fail("bad-images", "Every image has to be an https URL.");
    edits.images = urls as string[];
  }
  if (input.status !== undefined) {
    if (input.status !== "published" && input.status !== "hidden") return fail("bad-status", "Status is published or hidden.");
    edits.status = input.status;
  }
  return { ok: true, edits };
}

/** The label a shop link shows: the host, "amazon.ca" or "abystyle.com". */
export function linkFor(listing: any): { kind: string; url: string; label?: string } | null {
  const url = listing?.source?.url;
  if (!url) return null;
  const host = hostOf(url);
  return { kind: listing.source.platform === "paste" ? "shop" : "source", url, label: host || undefined };
}

async function nameOf(db: Db, id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const doc = await db.get(id as any);
  return doc ? (doc as any).name : undefined;
}

async function moveCount(db: Db, fromId: string | undefined | false, toId: string | undefined | false) {
  if (fromId === toId) return;
  for (const [id, delta] of [[fromId, -1], [toId, 1]] as const) {
    if (!id) continue;
    const doc = await db.get(id as any);
    if (doc) await db.patch(id as any, { mugCount: Math.max(0, (doc as any).mugCount + delta) });
  }
}

/**
 * Resolve brand and franchise names in edits to ids, creating them as needed.
 * Returns the patch keys for brandId and franchiseId (undefined clears).
 */
async function resolveNames(db: Db, edits: Edits, now: number): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  if (edits.brand !== undefined) patch.brandId = edits.brand ? (await findOrCreateBrand(db, edits.brand, now))._id : undefined;
  if (edits.franchise !== undefined) {
    patch.franchiseId = edits.franchise ? (await findOrCreateFranchise(db, edits.franchise, now))._id : undefined;
  }
  return patch;
}

/** Plain field edits as a patch: null clears, a value sets. brand, franchise, images and status are handled elsewhere. */
function fieldPatch(edits: Edits): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edits)) {
    if (["brand", "franchise", "images", "status"].includes(key)) continue;
    patch[key] = value === null ? undefined : value;
  }
  return patch;
}

/**
 * The one way a mug changes. Moves brand, franchise, style and mug counters
 * when a published mug changes group or visibility, and keeps searchText and
 * nameKey in step with the name, brand, franchise and character.
 */
export async function applyMugPatch(db: Db, mug: any, patch: Record<string, unknown>, now: number): Promise<any> {
  const next = { ...mug };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const wasOn = mug.status === "published";
  const isOn = next.status === "published";
  await moveCount(db, wasOn && mug.brandId, isOn && next.brandId);
  await moveCount(db, wasOn && mug.franchiseId, isOn && next.franchiseId);
  if (wasOn !== isOn || mug.style !== next.style) {
    if (wasOn) await bump(db, STAT.style(mug.style), -1);
    if (isOn) await bump(db, STAT.style(next.style), 1);
  }
  if (wasOn !== isOn) await bump(db, STAT.mugs, isOn ? 1 : -1);

  const brandName = await nameOf(db, next.brandId);
  const franchiseName = await nameOf(db, next.franchiseId);
  const derived = {
    nameKey: mugNameKey(next.name, brandName),
    searchText: searchTextFor({ name: next.name, brand: brandName, franchise: franchiseName, character: next.character, style: next.style, sku: next.sku, gtin: next.gtin }),
  };
  const finalPatch: Record<string, unknown> = { ...patch, ...derived, updatedAt: now };
  if (!wasOn && isOn) finalPatch.publishedAt = now;
  await db.patch(mug._id, finalPatch);
  return { ...next, ...derived, updatedAt: now };
}

/** A new mug from a listing and an admin's edits. Counters move only when it is published. */
export async function createMug(db: Db, listing: any, edits: Edits, now: number): Promise<any> {
  const name = edits.name ?? listing.name;
  const brandName = edits.brand !== undefined ? edits.brand : listing.brand;
  const franchiseName = edits.franchise !== undefined ? edits.franchise : listing.franchise;
  const brand = brandName ? await findOrCreateBrand(db, brandName, now) : null;
  const franchise = franchiseName ? await findOrCreateFranchise(db, franchiseName, now) : null;
  const pick = <T>(field: keyof Edits, fallback: T): T | undefined => {
    const value = (edits as any)[field];
    if (value === null) return undefined;
    return value !== undefined ? value : fallback;
  };
  const images = (edits.images ?? listing.images ?? []).slice(0, LIMITS.images);
  const status = edits.status ?? "published";
  const style = edits.style ?? listing.style ?? "other";
  const character = pick("character", listing.character);
  const sku = pick("sku", listing.sku);
  const gtin = pick("gtin", listing.gtin);
  const link = linkFor(listing);

  const doc = compact({
    slug: await uniqueMugSlug(db, name, brand?.slug),
    name,
    nameKey: mugNameKey(name, brand?.name),
    brandId: brand?._id,
    franchiseId: franchise?._id,
    character,
    style,
    capacityMl: pick("capacityMl", listing.capacityMl),
    material: pick("material", listing.material),
    hasLid: pick("hasLid", listing.hasLid),
    dishwasherSafe: pick("dishwasherSafe", listing.dishwasherSafe),
    microwaveSafe: pick("microwaveSafe", listing.microwaveSafe),
    sku,
    gtin,
    releaseYear: pick("releaseYear", undefined),
    blurb: pick("blurb", undefined),
    images: [],
    pendingImages: images,
    imageState: images.length ? ("pending" as const) : ("none" as const),
    links: link ? [compact(link)] : [],
    lastPrice: listing.price ? { ...listing.price, at: now } : undefined,
    status,
    ownedCount: 0,
    wantedCount: 0,
    searchText: searchTextFor({ name, brand: brand?.name, franchise: franchise?.name, character, style, sku, gtin }),
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
  });
  const id = await db.insert("mugs", doc as any);
  if (status === "published") {
    await moveCount(db, undefined, brand?._id);
    await moveCount(db, undefined, franchise?._id);
    await bump(db, STAT.mugs, 1);
    await bump(db, STAT.style(style), 1);
  }
  return await db.get(id);
}

/** An admin's edit of a mug that already exists. */
export async function saveMugEdits(db: Db, mug: any, edits: Edits, now: number): Promise<any> {
  const patch: Record<string, unknown> = { ...fieldPatch(edits), ...(await resolveNames(db, edits, now)) };
  if (edits.status) patch.status = edits.status;
  return await applyMugPatch(db, mug, patch, now);
}

export { fieldPatch, resolveNames };
