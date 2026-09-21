// ── fromPaste: a product the admin copied from a marketplace page ────────────
//
// Amazon is never fetched by anything in this repo (C11). An Amazon mug enters
// the catalogue because the admin copies what the page shows (its URL, its
// title, a bullet line or two) and pastes it into the admin page. This turns
// that text into a C1 listing. Pure text, no I/O.
//
// The reading, in order:
//   1. A URL line is the product link. An Amazon URL with an ASIN becomes the
//      canonical https://www.<amazon host>/dp/<ASIN>, and the key amazon:<ASIN>.
//   2. The first other line is the title; the rest are description, used for
//      facts (capacity, lid, material, care) and kept for the admin.
//   3. Marketplace decoration comes off the title: "Amazon.com: ...",
//      "... : Amazon.ca: Home", and the category Amazon appends after the last
//      colon ("...: Coffee Cups & Mugs").
//   4. A known brand leading the title (or trailing it, or named on a
//      "Brand:" or "Visit the X Store" line) becomes `brand`.
//   5. The name ends after the first product noun (mug, teapot, stein,
//      tumbler; cup only when none of those appear) unless the words after it
//      continue the product ("and Coaster Set", "with Lid").
// Style comes from the name first and the whole title second, never from the
// description first: "Bas Relief ... Mug" stays relief even when the bullet
// copy says "sculpted artwork".

import { detectCharacter, detectFranchise, detectLid, detectMaterial, detectStyle, parseCapacityMl } from './facts.js';
import { brandVariants, collapse, fold } from './names.js';
import { asinFrom, canonicalUrl, normalizeListing } from './normalize.js';
import { escapeRe } from './opengraph.js';

/** Makers of character mugs whose name commonly leads a marketplace title. */
export const KNOWN_BRANDS = Object.freeze([
  'Paladone', 'ABYstyle', 'Silver Buffalo', 'BigMouth Inc', 'Funko', 'Vandor', 'Zak Designs',
  'Pyramid International', 'Half Moon Bay', 'Beeline Creative', 'Geeki Tikis', 'Surreal Entertainment',
  'Grupo Erik', 'Just Funky', 'Enesco', 'Monogram', 'Toynk', 'Numskull',
]);

const EN_DASH = String.fromCharCode(0x2013);
const BULLET = String.fromCharCode(0x2022);
const MIDDOT = String.fromCharCode(0x00b7);
const ELLIPSIS = String.fromCharCode(0x2026);
const SEP_CHARS = `|\\-${EN_DASH}${BULLET}${MIDDOT}`;

const URL_LINE = /^https?:\/\/\S+$/i;
const BRAND_LINE = /^(?:brand|marca|marque|marke)\s*:\s*(.{2,80})$/i;
const STORE_LINE = /^visit the\s+(.{2,80}?)\s+store$/i;

const MARKET = '(?:amazon\\.[a-z]{2,3}(?:\\.[a-z]{2})?|walmart\\.com|target\\.com|ebay(?:\\.[a-z]{2,3}(?:\\.[a-z]{2})?)?)';
const HEAD = new RegExp(`^\\s*${MARKET}\\s*[:|]\\s*`, 'i');
const TAIL = new RegExp(`\\s*[:|,${SEP_CHARS}]\\s*${MARKET}(?:\\s*[:|][^:|]*)*\\s*$`, 'i');
const ELLIPSIS_END = new RegExp(`\\s*(?:\\.{3}|${ELLIPSIS})\\s*$`);
const LEADING_SEP = new RegExp(`^[\\s,:;${SEP_CHARS}]+`);
const TRAILING_SEP = new RegExp(`[\\s,:;${SEP_CHARS}]+$`);
const HARD_SEP = new RegExp(`\\s[${SEP_CHARS}]\\s|,\\s`);

const NOUN = /\b(?:mugs?|teapots?|steins?|tumblers?)\b/i;
const WEAK_NOUN = /\b(?:cups?)\b/i;
const ACCESSORY = '(?:coasters?|saucers?|lids?|spoons?|infusers?|straws?|sets?|box(?:es)?|plates?|cups?|mugs?|teapots?)';
const CONTINUES = [
  /^\s+(?:gift\s+)?set(?:\s+of\s+\d+)?\b/i,
  new RegExp(`^\\s+(?:and|&|\\+|with)\\s+(?:an?\\s+)?(?:[\\p{L}\\p{N}'-]+\\s+){0,2}?${ACCESSORY}\\b(?:\\s+(?:gift\\s+)?set\\b)?`, 'iu'),
  /^\s+(?:mugs?|cups?|teapots?)\b/i,
];
const NO_LID = /\b(?:without\s+(?:a\s+)?lid|no\s+lid|lid\s+(?:is\s+)?(?:not\s+included|sold\s+separately))\b/;

/** Lowercase and accent-folded, one character for one, so an index into it is an index into the original. */
function foldSameLength(text) {
  let out = '';
  for (const ch of text) {
    const folded = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (folded.length === ch.length) out += folded;
    else if (ch.toLowerCase().length === ch.length) out += ch.toLowerCase();
    else out += ch;
  }
  return out;
}

function variantPattern(variant) {
  return escapeRe(variant).replace(/ /g, '[\\s._-]*');
}

/** The longest known brand that starts the title, with the title after it. */
function leadingBrand(title, brands) {
  const folded = foldSameLength(title);
  let best = null;
  for (const brand of brands) {
    for (const variant of brandVariants(brand)) {
      const m = new RegExp(`^${variantPattern(variant)}\\.?(?=$|[\\s,:;${SEP_CHARS}])`).exec(folded);
      if (m && (!best || m[0].length > best.length)) best = { brand, length: m[0].length };
    }
  }
  return best ? { brand: best.brand, rest: title.slice(best.length).replace(LEADING_SEP, '') } : null;
}

/** A known brand ending the title after a separator or "by" ("... Mug - Paladone"). */
function trailingBrand(title, brands) {
  const folded = foldSameLength(title);
  let best = null;
  for (const brand of brands) {
    for (const variant of brandVariants(brand)) {
      const m = new RegExp(`(?:\\s+by\\s+|\\s*[,${SEP_CHARS}]\\s*)${variantPattern(variant)}\\.?\\s*$`).exec(folded);
      if (m && (!best || m.index < best.index)) best = { brand, index: m.index };
    }
  }
  return best ? { brand: best.brand, rest: title.slice(0, best.index) } : null;
}

/** After an "Amazon.com:" head, the last colon introduces Amazon's category; drop it when the rest still names the product. */
function stripCategory(title) {
  const at = title.lastIndexOf(':');
  if (at <= 0) return title;
  const head = title.slice(0, at).trim();
  const tail = title.slice(at + 1).trim();
  if (!tail || tail.length > 60 || /\d/.test(tail)) return title;
  return NOUN.test(head) || WEAK_NOUN.test(head) ? head : title;
}

function tidy(text) {
  return collapse(text.replace(/\s*,\s*/g, ' ').replace(TRAILING_SEP, ''));
}

/** The product's name: up to the first product noun and whatever continues it. */
export function cutName(rest) {
  const m = NOUN.exec(rest) || WEAK_NOUN.exec(rest);
  if (m && rest.slice(0, m.index).trim()) {
    let end = m.index + m[0].length;
    for (let guard = 0; guard < 6; guard++) {
      const tail = rest.slice(end);
      const hit = CONTINUES.map((re) => re.exec(tail)).find(Boolean);
      if (!hit) break;
      end += hit[0].length;
    }
    return tidy(rest.slice(0, end));
  }
  // No noun, or it opens the title ("Mug 3D Pikachu - ..."): stop at the first hard separator.
  const sep = HARD_SEP.exec(rest);
  return tidy(sep && sep.index > 0 ? rest.slice(0, sep.index) : rest);
}

/** A lid is only claimed when the text says there is one, and never when it says there is none. */
function lidSaid(...texts) {
  const t = fold(texts.join('\n'));
  return NO_LID.test(t) ? undefined : detectLid(t);
}

/** https://www.<amazon host>/dp/<ASIN> for an Amazon product URL, keeping .com, .ca, .co.uk; else null. */
export function amazonProductUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  const domain = /(?:^|\.)(amazon\.[a-z]{2,3}(?:\.[a-z]{2})?)$/i.exec(url.hostname);
  const asin = asinFrom(url.href);
  return domain && asin ? `https://www.${domain[1].toLowerCase()}/dp/${asin}` : null;
}

/**
 * C1.1: a listing from pasted text. `url` (optional) overrides a URL line in
 * the text; `knownBrands` extends KNOWN_BRANDS (Convex passes its brands).
 * source.platform is "paste" and source.via is "browser".
 *
 * @param {string} text
 * @param {{ url?: string, knownBrands?: string[], now?: number }} [options]
 */
export function fromPaste(text, { url, knownBrands = [], now = Date.now() } = {}) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/).map((line) => collapse(line)).filter(Boolean);
  let pasted = typeof url === 'string' && url.trim() ? url.trim() : undefined;
  let lineBrand;
  const body = [];
  for (const line of lines) {
    if (URL_LINE.test(line)) {
      if (!pasted) pasted = line;
      continue;
    }
    const named = BRAND_LINE.exec(line) || STORE_LINE.exec(line);
    if (named && !lineBrand) {
      lineBrand = collapse(named[1]);
      continue;
    }
    body.push(line);
  }
  const titleLine = body.shift() || '';
  const description = body.join('\n');

  let title = titleLine;
  const decorated = HEAD.test(title);
  title = title.replace(HEAD, '').replace(TAIL, '');
  if (decorated) title = stripCategory(title);
  title = title.replace(ELLIPSIS_END, '').trim();

  const brands = [...KNOWN_BRANDS, ...(Array.isArray(knownBrands) ? knownBrands.filter((b) => typeof b === 'string' && b.trim()) : [])];
  let brand;
  let rest = title;
  const lead = leadingBrand(title, brands);
  if (lead) {
    brand = lead.brand;
    rest = lead.rest;
  } else if (lineBrand) {
    brand = lineBrand;
    const own = leadingBrand(title, [lineBrand]);
    if (own) rest = own.rest;
  } else {
    const trail = trailingBrand(title, brands);
    if (trail) {
      brand = trail.brand;
      rest = trail.rest;
    }
  }

  const name = cutName(rest);
  const style = [detectStyle(name), detectStyle(rest)].find((s) => s !== 'other');
  const sourceUrl = pasted ? amazonProductUrl(pasted) || canonicalUrl(pasted) || undefined : undefined;
  const input = {
    source: { url: sourceUrl, platform: 'paste', via: 'browser', fetchedAt: now },
    name,
    brand,
    style,
    capacityMl: parseCapacityMl(title) ?? parseCapacityMl(description),
    material: detectMaterial(title) ?? detectMaterial(description),
    hasLid: lidSaid(title, description),
    franchise: detectFranchise(name) ? undefined : detectFranchise(rest) || undefined,
    character: detectCharacter(name) ? undefined : detectCharacter(rest) || undefined,
    description: description || undefined,
  };
  return normalizeListing(input, { now });
}
