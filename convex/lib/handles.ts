// Handles: the name after the question mark in /u/?<handle>.
//
// Canonical here; js/handles.js mirrors it so the shelf page can say what is
// wrong before asking the server, and tests/handles-mirror.test.mjs runs one
// corpus through both. The rules are vitrina's (projects/vitrina-site/convex/
// lib/handles.ts) with Mug's own reserved words and brand names.

/** 3 to 30 characters, a to z and digits, hyphens only singly and never at either end. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;

/** Paths the site serves, words that read as the site speaking, and the shops it lists. */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
  "u", "shelf", "admin", "api", "www", "css", "js", "shared", "convex", "worker", "runner", "docs", "scripts",
  "tests", "templates", "index", "sitemap", "robots", "llms", "favicon", "manifest", "static", "img", "i",
  "bot", "mug", "mugs", "mugbot", "brand", "brands", "community", "catalog", "catalogue", "about", "help",
  "support", "privacy", "terms", "legal", "contact", "login", "logout", "signin", "sign-in", "signup",
  "sign-up", "account", "accounts", "auth", "oauth", "session", "clerk", "neorgon", "energon", "owner",
  "official", "staff", "team", "mod", "moderator", "security", "abuse", "report", "me", "you", "anon",
  "anonymous", "null", "undefined", "test", "settings", "system", "user", "users", "profile", "root",
  "verify", "claim", "embed", "policy", "abystyle", "paladone", "funko", "silverbuffalo", "silver-buffalo",
  "bigmouth", "bigmouth-inc", "amazon",
]);

// A handle with one of these as a whole segment reads as a role.
export const ROLE_WORDS: readonly string[] = Object.freeze([
  "admin", "administrator", "staff", "team", "mod", "moderator", "official", "support", "help",
]);

// Substrings after folding lookalike digits: "neorg0n" impersonates as well as the word.
export const BRANDS: readonly string[] = Object.freeze(["neorgon", "energon", "mugbot"]);

export const HANDLE_MESSAGES = Object.freeze({
  "handle-invalid": "Letters a to z, digits and single hyphens, 3 to 30 characters, not only digits.",
  "handle-reserved": "That address is reserved. Try another.",
});

/** Case, surrounding space and a leading "@" (or its "%40" encoding) do not make a different handle. */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let handle = raw.trim();
  if (handle.startsWith("%40")) handle = "@" + handle.slice(3);
  if (handle.startsWith("@")) handle = handle.slice(1);
  return handle.trim().toLowerCase();
}

function lookalikes(handle: string): string[] {
  const folded = handle.replace(/-/g, "").replace(/0/g, "o").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s");
  return [folded.replace(/1/g, "i"), folded.replace(/1/g, "l")];
}

/** An error code, or null when the (already normalised) handle may be claimed. */
export function handleProblem(handle: string): "handle-invalid" | "handle-reserved" | null {
  if (typeof handle !== "string" || !HANDLE_RE.test(handle) || /^[0-9]+$/.test(handle)) return "handle-invalid";
  if (RESERVED_HANDLES.includes(handle)) return "handle-reserved";
  if (lookalikes(handle).some((folded) => BRANDS.some((brand) => folded.includes(brand)))) return "handle-reserved";
  if (handle.split("-").some((segment) => ROLE_WORDS.includes(segment))) return "handle-reserved";
  return null;
}
