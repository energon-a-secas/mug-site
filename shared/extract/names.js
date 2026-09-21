// ── Names, keys and codes ────────────────────────────────────────────────────
//
// Shared by every extractor and by Convex's matcher (convex/lib/matchCore.ts),
// so "is this the same mug?" has one definition. Pure functions, no I/O.

import { FRANCHISE_ALIASES } from './franchises.js';

const DIACRITICS = /\p{M}/gu;

/** Lowercase, accents folded, so "Pokémon" and "POKEMON" compare equal. */
export function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(DIACRITICS, '').toLowerCase();
}

/** Whitespace collapsed and trimmed; never returns anything but a string. */
export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function slugify(text, max = 80) {
  const slug = fold(text)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

// "BigMouth Inc" has to match "bigmouth", "big mouth" and "BigMouth Inc." alike.
const CORPORATE = /\b(inc|ltd|llc|limited|co|corp|gmbh|sas|sa|sl|srl)\b\.?/g;

export function brandVariants(brand) {
  const raw = collapse(brand);
  if (!raw) return [];
  const spaced = raw.replace(/([a-z])([A-Z])/g, '$1 $2');
  const out = new Set();
  for (const form of [raw, spaced]) {
    const folded = fold(form).replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const bare = folded.replace(CORPORATE, '').replace(/\s+/g, ' ').trim();
    for (const f of [folded, bare]) {
      if (f.length >= 2) {
        out.add(f);
        out.add(f.replace(/ /g, ''));
      }
    }
  }
  // Longest first, so "bigmouth inc" is removed before "bigmouth" leaves " inc".
  return [...out].sort((a, b) => b.length - a.length);
}

// Words that describe the product class rather than which product it is.
// Dropping them is what lets "Pikachu 3D Mug" and "Mug 3D Pikachu 475ml" meet.
const FILLER = new Set([
  'mug', 'mugs', 'cup', 'cups', '3d', 'ceramic', 'ceramique', 'official', 'officially', 'licensed',
  'license', 'licence', 'merchandise', 'merch', 'gift', 'gifts', 'the', 'a', 'an', 'of', 'and', 'with',
  'for', 'in', 'de', 'la', 'le', 'les', 'du', 'des', 'tasse', 'taza', 'sculpted', 'shaped', 'figural',
  'novelty', 'collectible', 'collectable', 'new', 'edition', 'large', 'giant', 'coffee', 'tea', 'boxed',
  'oz', 'ml', 'fl', 'l', 'cl', 'liter', 'liters', 'litre', 'litres', 'ounce', 'ounces',
]);

const CAPACITY_PHRASE =
  /\b\d+(?:[.,]\d+)?\s*(?:ml|cl|l|oz\.?|fl\.?\s*oz\.?|fluid[\s_]*ounces?|ounces?|liters?|litres?)(?![a-z])/g;

/**
 * The match key for C7 rule 4. Brand words, franchise words, capacities and
 * filler are dropped and the rest sorted, so word order and marketplace
 * decoration do not make two listings of one mug look different. Equal keys
 * are "similar", never merged automatically: "Pikachu 3D Mug" and a printed
 * "Pikachu Mug" share one on purpose, and an admin tells them apart.
 */
export function nameKey(name, brand) {
  let text = ` ${fold(name).replace(CAPACITY_PHRASE, ' ')} `;
  const drop = [...brandVariants(brand), ...FRANCHISE_ALIASES];
  for (const phrase of drop) {
    if (!phrase) continue;
    text = text.replace(new RegExp(`(?<![a-z0-9])${escapeRe(phrase)}(?![a-z0-9])`, 'g'), ' ');
  }
  const words = text
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].sort().join(' ');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Marketplace tails a pasted title carries: "… : Amazon.ca: Home",
// "Amazon.com | …", "… - Walmart.com".
const MARKET_TAIL = /\s*[:|,-]\s*(?:amazon\.[a-z.]+|walmart\.com|target\.com|ebay)(?:\s*[:|]\s*[^:|]*)*$/i;
const MARKET_HEAD = /^(?:amazon\.[a-z.]+|walmart\.com)\s*[:|]\s*/i;

/**
 * A display name: whitespace collapsed, marketplace decoration and a leading
 * or trailing brand removed ("ABYSTYLE - Pokemon Pikachu 3D Mug" becomes
 * "Pokemon Pikachu 3D Mug"). Keeps the brand when it is the whole name.
 */
export function cleanName(name, brand) {
  let text = collapse(name).replace(MARKET_HEAD, '').replace(MARKET_TAIL, '');
  for (const variant of brandVariants(brand)) {
    const re = escapeRe(variant).replace(/ /g, '\\s*');
    const head = new RegExp(`^${re}\\s*(?:[-|:,]\\s*|\\s+)`, 'i');
    const tail = new RegExp(`\\s*(?:[-|:,]\\s*|\\s+by\\s+)${re}$`, 'i');
    const next = text.replace(head, '').replace(tail, '');
    if (next.trim().length >= 3) text = next;
  }
  return collapse(text);
}

/**
 * C1.3. Digits only, check digit verified; a UPC-A gains its leading zero and
 * a zero-led GTIN-14 loses one, so one product has one code. Anything that
 * does not verify is dropped, not guessed at.
 */
export function normalizeGtin(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  if (/^0+$/.test(digits) || !checkDigitOk(digits)) return null;
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 14 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function checkDigitOk(digits) {
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 2; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}
