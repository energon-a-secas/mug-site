import { hostOf } from "../../shared/extract/normalize.js";

// A6 and A13 for a single URL import. The source that owns the URL's host
// names the maker and the shop's currency, as it does for a scan. ABYstyle's
// US shop writes "ABYstyle USA" in its vendor field and Shopify's product JSON
// has no currency, so without this a pasted URL got another brand than the
// scanned listings, and no price.

type SourceLike = { baseUrl: string; entryUrls?: string[]; enabled?: boolean };

/** The source whose base or entry URLs are on `host` (compared without "www."), an enabled one first. */
export function sourceForHost<T extends SourceLike>(sources: T[], host: string): T | null {
  const want = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!want) return null;
  const owns = (source: T) => [source.baseUrl, ...(source.entryUrls || [])].some((url) => hostOf(url) === want);
  const matches = sources.filter(owns);
  return matches.find((source) => source.enabled) || matches[0] || null;
}
