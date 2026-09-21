// ── Admin routes: which section a hash names ─────────────────
// Sections are addressed as #section/param/param, so an overview tile can
// open Review on its "needs runner" tab (#review/needsLocal) and an import
// can link to the exact queue item it made (#review/pending/<id>). Pure, so
// tests/admin-render.test.mjs can hold the parsing to its word.

/** Every section, in rail order. */
export const SECTION_IDS = Object.freeze([
  'overview', 'review', 'import', 'sources', 'runs', 'catalog', 'images', 'community', 'runner',
]);

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The route a location.hash names: { section, params }. An empty hash is the
 * overview. Anything else that is not a section (the skip link's "#main")
 * is null, so the router can leave the current section where it is.
 */
export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return { section: 'overview', params: [] };
  const parts = raw.split('/').map(decode);
  if (!SECTION_IDS.includes(parts[0])) return null;
  return { section: parts[0], params: parts.slice(1).filter(Boolean) };
}

/** The hash for a section and its params, each part encoded; empty params are dropped. */
export function sectionHash(section, ...params) {
  const parts = [section, ...params.filter((p) => p !== undefined && p !== null && p !== '')];
  return `#${parts.map((p) => encodeURIComponent(String(p))).join('/')}`;
}
