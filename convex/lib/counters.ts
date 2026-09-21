import type { GenericDatabaseWriter } from "convex/server";

// The stats table: named counters the community page reads without scanning.
// Only cores call bump(), in the same mutation as the change being counted.

type Db = GenericDatabaseWriter<any>;

export const STAT = {
  mugs: "mugs",
  owned: "owned",
  wanted: "wanted",
  collectors: "collectors",
  style: (style: string) => `style:${style}`,
};

export async function bump(db: Db, key: string, delta: number): Promise<void> {
  if (!delta) return;
  const row = await db.query("stats").withIndex("by_key", (q: any) => q.eq("key", key)).unique();
  if (row) await db.patch(row._id, { count: Math.max(0, row.count + delta) });
  else if (delta > 0) await db.insert("stats", { key, count: delta });
}

export async function readStat(db: any, key: string): Promise<number> {
  const row = await db.query("stats").withIndex("by_key", (q: any) => q.eq("key", key)).unique();
  return row ? row.count : 0;
}
