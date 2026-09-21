// Mirror of convex/lib/handles.ts, so the shelf page can say what is wrong
// with an address before asking the server. tests/handles-mirror.test.mjs
// runs one corpus through both; change them together.

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;

export const RESERVED_HANDLES = Object.freeze([
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

export const ROLE_WORDS = Object.freeze([
  "admin", "administrator", "staff", "team", "mod", "moderator", "official", "support", "help",
]);

export const BRANDS = Object.freeze(["neorgon", "energon", "mugbot"]);

export const HANDLE_MESSAGES = Object.freeze({
  "handle-invalid": "Letters a to z, digits and single hyphens, 3 to 30 characters, not only digits.",
  "handle-reserved": "That address is reserved. Try another.",
});

export function normalizeHandle(raw) {
  if (typeof raw !== "string") return "";
  let handle = raw.trim();
  if (handle.startsWith("%40")) handle = "@" + handle.slice(3);
  if (handle.startsWith("@")) handle = handle.slice(1);
  return handle.trim().toLowerCase();
}

function lookalikes(handle) {
  const folded = handle.replace(/-/g, "").replace(/0/g, "o").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s");
  return [folded.replace(/1/g, "i"), folded.replace(/1/g, "l")];
}

export function handleProblem(handle) {
  if (typeof handle !== "string" || !HANDLE_RE.test(handle) || /^[0-9]+$/.test(handle)) return "handle-invalid";
  if (RESERVED_HANDLES.includes(handle)) return "handle-reserved";
  if (lookalikes(handle).some((folded) => BRANDS.some((brand) => folded.includes(brand)))) return "handle-reserved";
  if (handle.split("-").some((segment) => ROLE_WORDS.includes(segment))) return "handle-reserved";
  return null;
}
