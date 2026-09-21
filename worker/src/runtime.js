// ── Per-isolate state and limits ─────────────────────────────────────────────
//
// Kept out of index.js on purpose: workerd treats every named export of the
// main module as an entrypoint and refuses to start when one is a number or a
// string ("Incorrect type for map entry ... not of type 'function or
// ExportedHandler'", seen under wrangler 4.136.1). index.js therefore exports
// only its handler and ERROR_CODES, and anything else a test needs lives here.

/** robots.txt policies, per isolate, keyed by origin (C10.2's one-hour cache). */
export const robotsCache = new Map();

/**
 * Fetches one invocation may make: typically robots.txt, the page and a
 * redirect hop or two (C3 expects about four); the headroom covers C10.3's
 * five hand-followed redirects without nearing the free plan's 50.
 */
export const SUBREQUEST_BUDGET = 12;
