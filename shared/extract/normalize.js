// ── normalizeListing: the one door into C1 ───────────────────────────────────
//
// Every extractor ends here, and Convex runs it again on whatever the Worker
// or the runner posts (docs/CONTRACTS.md C1, C8). It never throws on bad
// input: it answers { ok: false, code, message } so a scan can count a bad
// product and move on. Derived facts (style, capacity, material, lid, care,
// isMug, franchise, character) are filled from the words when an extractor
// left them unset, so every platform gets the same reading.

import { LISTING_VERSION, LIMITS, MATERIALS, PLATFORMS, STYLES, VIAS } from '../contract.js';
import {
  detectCare, detectCharacter, detectFranchise, detectLid, detectMaterial, detectStyle,
  mugVerdict, parseCapacityMl,
} from './facts.js';
import { cleanName, collapse, fold, nameKey, normalizeGtin, slugify } from './names.js';

function fail(code, message) {
  return { ok: false, code, message };
}

/** An absolute https URL without its fragment, or null. http is upgraded: the page is https. */
export function canonicalUrl(raw, base) {
  if (raw === null || raw === undefined || raw === '') return null;
  let url;
  try {
    url = base ? new URL(String(raw).trim(), base) : new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  url.hash = '';
  const out = url.toString();
  return out.length <= LIMITS.url ? out : null;
}

/** Lowercase hostname without a leading "www.", or "" when the URL does not parse. */
export function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const ASIN = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/)([A-Z0-9]{10})(?=[/?#]|$)/i;

/** The Amazon product id in a URL, uppercase, or null. */
export function asinFrom(raw) {
  const m = String(raw ?? '').match(ASIN);
  return m ? m[1].toUpperCase() : null;
}

/** C1.2: the identity a re-scan uses to find the mug it already made. */
export function listingKey({ url, platform, handle, id, name, brand } = {}) {
  const host = hostOf(url);
  switch (platform) {
    case 'shopify':
      if (host && handle) return `${host}/products/${String(handle).toLowerCase()}`;
      break;
    case 'woocommerce':
      if (host && id !== undefined && id !== null && id !== '') return `${host}/p/${id}`;
      break;
    case 'paste': {
      const asin = asinFrom(url);
      if (asin) return `amazon:${asin}`;
      return `paste:${nameKey(name, brand) || slugify(name) || 'untitled'}`;
    }
    case 'manual':
      return `manual:${nameKey(name, brand) || slugify(name) || 'untitled'}:${slugify(brand) || '-'}`;
    default:
      break;
  }
  if (!host) return '';
  const { pathname } = new URL(url);
  const path = pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: ',', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', deg: ' degrees', trade: '', reg: '', copy: '' };

// Built from its code point: the character itself is banned from this repo's
// text, and a literal in a regex is invisible in review.
const EM_DASH = new RegExp(String.fromCharCode(0x2014), 'g');

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
      // An em dash arriving as an entity becomes a comma, never the character.
      if (code === 0x2014) return ',';
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Plain text from shop HTML: scripts and styles dropped, tags to spaces, entities decoded. */
export function plainText(html) {
  const text = String(html ?? '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .replace(EM_DASH, ',')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function boundedString(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = collapse(decodeEntities(String(value)));
  return text ? text.slice(0, max).trim() : undefined;
}

function bool(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function price(value) {
  if (!value || typeof value !== 'object') return undefined;
  const amount = typeof value.amount === 'string' ? Number(value.amount.replace(',', '.')) : value.amount;
  const currency = typeof value.currency === 'string' ? value.currency.trim().toUpperCase() : '';
  if (!Number.isFinite(amount) || amount <= 0 || amount > LIMITS.priceMax) return undefined;
  if (!/^[A-Z]{3}$/.test(currency)) return undefined;
  return { amount: Math.round(amount * 100) / 100, currency };
}

function images(list, base) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const url = canonicalUrl(typeof raw === 'string' ? raw : raw && raw.src, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= LIMITS.images) break;
  }
  return out;
}

function tags(list) {
  const out = [];
  const seen = new Set();
  const items = typeof list === 'string' ? list.split(',') : Array.isArray(list) ? list : [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const tag = collapse(fold(raw)).slice(0, LIMITS.tag).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function capacity(value) {
  const ml = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(ml)) return undefined;
  const rounded = Math.round(ml);
  return rounded >= LIMITS.capacityMinMl && rounded <= LIMITS.capacityMaxMl ? rounded : undefined;
}

/**
 * input: anything shaped roughly like C1 (extractors pass partial listings).
 * Returns { ok: true, listing } with every field clamped to C1 and undefined
 * fields omitted, or { ok: false, code: "no-name" | "bad-url" | "bad-source", message }.
 */
export function normalizeListing(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') return fail('bad-source', 'A listing has to be an object.');
  const src = input.source && typeof input.source === 'object' ? input.source : {};
  if (!PLATFORMS.includes(src.platform)) return fail('bad-source', `Unknown platform ${JSON.stringify(src.platform)}.`);
  if (!VIAS.includes(src.via)) return fail('bad-source', `Unknown via ${JSON.stringify(src.via)}.`);

  const url = canonicalUrl(src.url);
  const urlOptional = src.platform === 'paste' || src.platform === 'manual';
  if (!url && !(urlOptional && (src.url === undefined || src.url === null || src.url === ''))) {
    return fail('bad-url', 'The source URL has to be an absolute http(s) address.');
  }

  const brand = boundedString(input.brand, LIMITS.brand);
  const name = boundedString(cleanName(decodeEntities(String(input.name ?? '')), brand), LIMITS.name);
  if (!name) return fail('no-name', 'The product has no name.');

  const productType = boundedString(input.productType, LIMITS.productType);
  const tagList = tags(input.tags);
  const description = input.description ? plainText(input.description).slice(0, LIMITS.description).trim() : '';

  // Words that describe the product itself, strongest first. The description
  // is only consulted when the title and category are silent, because shop
  // copy mentions other products ("pairs well with our 3D teapot").
  const titleText = [name, productType, tagList.join(' ')].filter(Boolean).join(' \n ');
  const allText = [titleText, description].filter(Boolean).join(' \n ');

  let style = STYLES.includes(input.style) ? input.style : detectStyle(titleText);
  if (style === 'other' && !STYLES.includes(input.style) && description) style = detectStyle(description);

  const material = MATERIALS.includes(input.material) ? input.material : detectMaterial(allText);
  const care = detectCare(allText);
  const franchiseIn = boundedString(input.franchise, LIMITS.franchise);
  const franchise = franchiseIn ? detectFranchise(franchiseIn) || franchiseIn : detectFranchise(titleText) || undefined;
  const character = boundedString(input.character, LIMITS.character) || detectCharacter(titleText) || undefined;
  const isMug = verdictOf(input.isMug) || mugVerdict({ name, tags: tagList, productType });

  const key = boundedString(src.key, LIMITS.key) || listingKey({ url, platform: src.platform, handle: src.handle, id: src.id, name, brand });
  if (!key) return fail('bad-url', 'No stable key could be made for this listing.');

  const fetchedAt = Number.isFinite(src.fetchedAt) && src.fetchedAt > 0 ? Math.round(src.fetchedAt) : now;

  const listing = {
    v: LISTING_VERSION,
    source: omitUndefined({ host: url ? hostOf(url) : (asinFrom(src.url) ? 'amazon' : ''), url: url || undefined, key, platform: src.platform, via: src.via, fetchedAt }),
    name,
    brand,
    franchise,
    character,
    style,
    capacityMl: capacity(input.capacityMl) ?? parseCapacityMl(name) ?? parseCapacityMl(productType) ?? parseCapacityMl(tagList.join(' ')) ?? parseCapacityMl(description),
    material,
    hasLid: bool(input.hasLid) ?? detectLid(titleText),
    dishwasherSafe: bool(input.dishwasherSafe) ?? care.dishwasherSafe,
    microwaveSafe: bool(input.microwaveSafe) ?? care.microwaveSafe,
    sku: boundedString(input.sku, LIMITS.sku),
    gtin: normalizeGtin(input.gtin) || undefined,
    price: price(input.price),
    available: bool(input.available),
    images: images(input.images, url || undefined),
    description: description || undefined,
    tags: tagList,
    isMug,
    productType,
  };
  return { ok: true, listing: omitUndefined(listing) };
}

function verdictOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (!['yes', 'maybe', 'no'].includes(value.verdict)) return null;
  const reason = boundedString(value.reason, LIMITS.reason) || 'set by the extractor';
  return { verdict: value.verdict, reason };
}

function omitUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}
