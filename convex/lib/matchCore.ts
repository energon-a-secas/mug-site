import type { GenericDatabaseReader } from "convex/server";
import { findBrand } from "./catalogue.ts";
import { mugNameKey } from "./catalogue.ts";

// docs/CONTRACTS.md C7 with amendment A3: which mug, if any, a listing is.
// Strongest rule first; "similar" is never merged without an admin.

type Reader = GenericDatabaseReader<any>;

export type Seen = {
  name: string;
  capacityMl?: number;
  style: string;
  price?: string;
  images: number;
  gtin?: string;
  sku?: string;
};

export type Match = {
  kind: "new" | "same" | "changed" | "similar";
  mugId?: string;
  fields: string[];
  reason: string;
  // Rules 2 and 3: attach this listing's shop page to mugId, stage nothing.
  link?: boolean;
  // Rule 1: the mugSources row the listing was compared with.
  sourceRowId?: string;
};

/** The parts of a listing whose change at the shop is worth an admin's look. */
export function seenOf(listing: any): Seen {
  const seen: Seen = { name: listing.name, style: listing.style, images: listing.images.length };
  if (listing.capacityMl !== undefined) seen.capacityMl = listing.capacityMl;
  if (listing.price) seen.price = `${listing.price.amount} ${listing.price.currency}`;
  if (listing.gtin) seen.gtin = listing.gtin;
  if (listing.sku) seen.sku = listing.sku;
  return seen;
}

export function diffSeen(before: Seen, after: Seen): string[] {
  const keys: (keyof Seen)[] = ["name", "capacityMl", "style", "price", "images", "gtin", "sku"];
  return keys.filter((key) => (before[key] ?? null) !== (after[key] ?? null));
}

export async function matchListing(db: Reader, listing: any): Promise<Match> {
  const row = await db.query("mugSources").withIndex("by_key", (q: any) => q.eq("key", listing.source.key)).first();
  if (row) {
    const mug = await db.get(row.mugId);
    if (mug) {
      const fields = diffSeen(row.seen, seenOf(listing));
      return fields.length
        ? { kind: "changed", mugId: mug._id, fields, reason: `the shop page changed: ${fields.join(", ")}`, sourceRowId: row._id }
        : { kind: "same", mugId: mug._id, fields: [], reason: "same shop page, nothing changed", sourceRowId: row._id };
    }
  }

  if (listing.gtin) {
    const mug = await db.query("mugs").withIndex("by_gtin", (q: any) => q.eq("gtin", listing.gtin)).first();
    if (mug) return { kind: "same", mugId: mug._id, fields: [], reason: "same barcode", link: true };
  }

  if (listing.sku && listing.brand) {
    const brand = await findBrand(db, listing.brand);
    if (brand) {
      const mug = await db
        .query("mugs")
        .withIndex("by_brand_sku", (q: any) => q.eq("brandId", brand._id).eq("sku", listing.sku))
        .first();
      if (mug) return { kind: "same", mugId: mug._id, fields: [], reason: "same brand and SKU", link: true };
    }
  }

  const key = mugNameKey(listing.name, listing.brand);
  if (key) {
    const mug = await db.query("mugs").withIndex("by_nameKey", (q: any) => q.eq("nameKey", key)).first();
    if (mug) return { kind: "similar", mugId: mug._id, fields: [], reason: `same name words as "${mug.name}"` };
  }

  return { kind: "new", fields: [], reason: "nothing like it in the catalogue" };
}

/** The part of a Match that staging stores (matchValidator). */
export function storedMatch(match: Match): { kind: Match["kind"]; mugId?: string; fields: string[]; reason: string } {
  const out: any = { kind: match.kind, fields: match.fields, reason: match.reason.slice(0, 200) };
  if (match.mugId) out.mugId = match.mugId;
  return out;
}
