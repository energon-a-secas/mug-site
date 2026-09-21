// ── Facts from product text ──────────────────────────────────────────────────
//
// Capacity, style, material, lid, care, "is this a mug at all", franchise and
// character, read from the words a shop uses. normalizeListing calls these to
// fill whatever an extractor left unset, so a Shopify product, a JSON-LD page
// and a pasted Amazon title all get the same treatment.
//
// Every detector answers "don't know" (undefined or null) rather than guess:
// a missing fact is shown as missing, a wrong one is shown as true.

import { LIMITS } from '../contract.js';
import { FRANCHISES } from './franchises.js';
import { fold } from './names.js';

const US_FL_OZ_ML = 29.5735;

// Metric first: when a title says "20oz | 0.59 Liters" the shop measured in
// one unit and converted to the other, and the metric figure is the one a
// European maker wrote down.
const METRIC = /(\d{1,4}(?:[.,]\d{1,3})?)\s*(ml|millilit(?:er|re)s?|cl|centilit(?:er|re)s?|l|lit(?:er|re)s?)(?![a-z])/g;
const IMPERIAL = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:fl\.?\s*oz\.?|fluid[\s_]*ounces?|oz\.?|ounces?)(?![a-z])/g;

function num(text) {
  return Number(String(text).replace(',', '.'));
}

function inRange(ml) {
  return Number.isFinite(ml) && ml >= LIMITS.capacityMinMl && ml <= LIMITS.capacityMaxMl;
}

/** Millilitres as an integer, or undefined. "approx. 475 ml", "16 oz", "0,5 l", "32.0 fluid_ounces". */
export function parseCapacityMl(text) {
  const t = fold(text);
  if (!t) return undefined;
  for (const m of t.matchAll(METRIC)) {
    const unit = m[2];
    const factor = unit.startsWith('c') ? 10 : unit === 'ml' || unit.startsWith('milli') ? 1 : 1000;
    const ml = Math.round(num(m[1]) * factor);
    if (inRange(ml)) return ml;
  }
  for (const m of t.matchAll(IMPERIAL)) {
    const ml = Math.round(num(m[1]) * US_FL_OZ_ML);
    if (inRange(ml)) return ml;
  }
  return undefined;
}

// Strongest signal first. A 3D teapot is a teapot; a relief stein is a stein.
const STYLE_RULES = [
  ['teapot', /\b(?:tea\s?pots?|theieres?|teteras?|teieras?)\b/],
  ['tiki', /\btiki\b/],
  ['stein', /\b(?:steins?|tankards?|chopes?|bierkrug)\b/],
  ['travel', /\b(?:travel\s+mugs?|tumblers?|thermos|insulated|vacuum)\b/],
  ['shaped', /\b(?:shaped|shape\s+mug)\b/],
  ['relief', /\b(?:bas[\s-]?relief|relief|embossed|debossed)\b/],
  ['sculpted', /\b(?:3d|3-d|sculpt(?:ed|ure)?|figural|head\s+mugs?|character\s+mugs?|toby\s+jugs?)\b/],
  // Sculpted, shaped and relief are read first, so "3D coffee mug" stays sculpted:
  // a plain coffee mug or a magic (heat-change) one is a printed body.
  ['printed', /\b(?:print(?:ed)?|decal|logo|graphic|sublimat\w*|heat[\s-]?chang\w*|colou?r[\s-]?chang\w*|magic\s+mugs?|coffee\s+mugs?)\b/],
];

/** One of STYLES; "other" when the words say nothing. */
export function detectStyle(text) {
  const t = fold(text);
  for (const [style, re] of STYLE_RULES) if (re.test(t)) return style;
  return 'other';
}

const MATERIAL_RULES = [
  ['porcelain', /\b(?:porcelain|porcelaine|porcelana|bone\s+china|fine\s+china)\b/],
  ['stoneware', /\b(?:stoneware|gres)\b/],
  ['earthenware', /\b(?:earthenware|faience|dolomite|terracotta)\b/],
  ['ceramic', /\b(?:ceramics?|ceramique|ceramica|keramik)\b/],
  ['glass', /\b(?:glass|borosilicate|verre|vidrio)\b/],
  ['steel', /\b(?:stainless|steel|enamel(?:led|ware)?|metal)\b/],
  ['plastic', /\b(?:plastic|melamine|acrylic|polypropylene|tritan)\b/],
];

/** One of MATERIALS, or undefined. */
export function detectMaterial(text) {
  const t = fold(text);
  for (const [material, re] of MATERIAL_RULES) if (re.test(t)) return material;
  return undefined;
}

/** true when the text says it has a lid; never false, since silence proves nothing. */
export function detectLid(text) {
  return /\b(?:with\s+(?:a\s+)?lid|lidded|lids?|couvercle|tapa|deckel)\b/.test(fold(text)) ? true : undefined;
}

/** Care claims, negatives first so "not dishwasher safe" is never read as safe. */
export function detectCare(text) {
  const t = fold(text);
  const out = {};
  if (/\b(?:not|never)\s+(?:\w+\s+)?dishwasher[\s-]*(?:safe|proof)|hand[\s-]*wash(?:ing)?\s+only\b/.test(t)) out.dishwasherSafe = false;
  else if (/\bdishwasher[\s-]*(?:safe|proof)\b/.test(t)) out.dishwasherSafe = true;
  if (/\b(?:not|never|do\s+not)\s+(?:\w+\s+)?microwav\w*|not\s+suitable\s+for\s+(?:the\s+)?microwave/.test(t)) out.microwaveSafe = false;
  else if (/\bmicrowave[\s-]*(?:safe|proof)\b/.test(t)) out.microwaveSafe = true;
  return out;
}

const STRONG = /\b(?:mugs?|tasses?|tazas?|tazze|tazza|becher|teapots?|tea\s+pots?|theieres?|teteras?|steins?|tankards?)\b/;
const WEAK = /\b(?:cups?|tumblers?|drinkware)\b/;
const NOT_A_MUG =
  /\b(?:coasters?|key\s?chains?|key\s?rings?|t-?shirts?|tees?|hoodies?|socks?|posters?|plush(?:ies)?|figurines?|pins?|patch(?:es)?|stickers?|notebooks?|lamps?|bags?|backpacks?|wallets?|puzzles?|water\s+bottles?|bottles?|shot\s+glass(?:es)?|mug\s+(?:racks?|trees?|warmers?|hangers?|holders?)|vinyl\s+figures?)\b/;

/**
 * { verdict, reason }. "maybe" is the honest answer for a mug-and-coaster set
 * or a tumbler, and the admin decides; "no" is what a scan drops.
 */
export function mugVerdict({ name, tags, productType } = {}) {
  const title = fold(name);
  const kind = fold(productType);
  const tagText = fold((Array.isArray(tags) ? tags : []).join(' '));
  const negative = NOT_A_MUG.test(title);
  if (STRONG.test(title)) {
    return negative
      ? { verdict: 'maybe', reason: 'title names a mug and another product' }
      : { verdict: 'yes', reason: 'title names a mug' };
  }
  if (!negative && STRONG.test(kind)) return { verdict: 'yes', reason: 'shop category is mugs' };
  if (!negative && (WEAK.test(title) || WEAK.test(kind))) return { verdict: 'maybe', reason: 'cup or tumbler, not called a mug' };
  if (!negative && STRONG.test(tagText)) return { verdict: 'maybe', reason: 'only a tag says mug' };
  return { verdict: 'no', reason: negative ? 'title names another product' : 'nothing says mug' };
}

function wordRe(phrase) {
  const folded = fold(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${folded}(?![a-z0-9])`);
}

const FRANCHISE_MATCHERS = FRANCHISES.map((f) => ({
  name: f.name,
  aliases: [...(f.nameMatches === false ? [] : [f.name]), ...f.aliases].map(wordRe),
  characters: f.characters.map((c) => ({ name: c, re: wordRe(c) })),
}));

/** The canonical franchise name, from an alias or a character that belongs to it. */
export function detectFranchise(text) {
  const t = fold(text);
  if (!t) return null;
  for (const f of FRANCHISE_MATCHERS) if (f.aliases.some((re) => re.test(t))) return f.name;
  for (const f of FRANCHISE_MATCHERS) if (f.characters.some((c) => c.re.test(t))) return f.name;
  return null;
}

/** A known character named in the text, with its canonical spelling, or null. */
export function detectCharacter(text) {
  const t = fold(text);
  if (!t) return null;
  for (const f of FRANCHISE_MATCHERS) for (const c of f.characters) if (c.re.test(t)) return c.name;
  return null;
}
