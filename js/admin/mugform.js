// ── The mug form: one set of fields for three places ─────────
// Review's "edit before approving", Import's typed-in mug and Catalog's
// editor edit the same facts, so they share one renderer, one reader and
// one diff. The diff is the point: approving sends only what the admin
// changed, in the shape cleanEdits (convex/lib/mugCore.ts) takes, where null
// clears a field and a missing key leaves it alone. An untouched form
// therefore never overwrites a curated mug with the shop's values.

import { LIMITS, MATERIALS, STYLES, STYLE_LABELS } from '../../shared/contract.js';
import { escHtml } from '../utils.js';
import { lines } from './ui.js';

const SPEC = Object.freeze({
  name: { label: 'Name', kind: 'text', max: LIMITS.name, required: true },
  brand: { label: 'Brand', kind: 'text', max: LIMITS.brand, hint: 'The maker, not the licence.' },
  franchise: { label: 'Franchise', kind: 'text', max: LIMITS.franchise },
  character: { label: 'Character', kind: 'text', max: LIMITS.character },
  style: { label: 'Style', kind: 'style' },
  capacityMl: { label: 'Capacity (ml)', kind: 'int', min: LIMITS.capacityMinMl, max: LIMITS.capacityMaxMl },
  material: { label: 'Material', kind: 'material' },
  hasLid: { label: 'Has a lid', kind: 'tri' },
  dishwasherSafe: { label: 'Dishwasher safe', kind: 'tri' },
  microwaveSafe: { label: 'Microwave safe', kind: 'tri' },
  releaseYear: { label: 'Release year', kind: 'int', min: 1900, max: 2100 },
  sku: { label: 'SKU', kind: 'text', max: LIMITS.sku },
  gtin: { label: 'GTIN (barcode)', kind: 'text', max: 20, numeric: true, hint: 'Digits only. A wrong check digit is refused.' },
  blurb: { label: 'Blurb', kind: 'blurb', max: 500, hint: "Your words, up to 500 characters. The shop's own description is never published." },
  status: { label: 'Visibility', kind: 'status' },
});

const FACTS = ['name', 'brand', 'franchise', 'character', 'style', 'capacityMl', 'material', 'hasLid', 'dishwasherSafe', 'microwaveSafe'];

/** Review's edit form: the facts, a blurb and visibility. */
export const REVIEW_FIELDS = Object.freeze([...FACTS, 'blurb', 'status']);

/** Catalog's editor: Review's facts plus release year, SKU and GTIN. */
export const CATALOG_FACTS = Object.freeze([...FACTS, 'releaseYear', 'sku', 'gtin']);
export const CATALOG_FIELDS = Object.freeze([...CATALOG_FACTS, 'blurb', 'status']);

/** Import's typed-in mug: listing facts (SKU and GTIN help matching), then two edits that apply on approval. */
export const MANUAL_FACTS = Object.freeze([...FACTS, 'sku', 'gtin']);
export const MANUAL_EDITS = Object.freeze(['blurb', 'status']);

const TRI = [['unknown', 'Unknown'], ['yes', 'Yes'], ['no', 'No']];

function tidy(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cap(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A listing's or a mug's values as the form holds them: strings, tri-states
 * as yes, no or unknown, visibility published unless the record says hidden.
 * styleAuto leaves style blank so the server works it out from the name.
 */
export function valuesOf(record, { styleAuto = false } = {}) {
  const source = record || {};
  const out = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    const value = source[name];
    if (spec.kind === 'tri') out[name] = value === true ? 'yes' : value === false ? 'no' : 'unknown';
    else out[name] = value === undefined || value === null ? '' : String(value);
  }
  if (out.status !== 'hidden') out.status = 'published';
  if (!STYLES.includes(out.style)) out.style = styleAuto ? '' : 'other';
  return out;
}

function typed(kind, value) {
  switch (kind) {
    case 'tri':
      return value === 'yes' ? true : value === 'no' ? false : null;
    case 'int':
      return value === '' ? null : Number(value);
    case 'material':
      return value || null;
    case 'style':
    case 'status':
      return value;
    default:
      // text and blurb: an emptied field clears it. cleanEdits refuses an empty name itself.
      return value === '' ? null : value;
  }
}

/**
 * The edits between two sets of form values: only the fields that differ,
 * typed for cleanEdits. Whitespace alone is not a change, because the
 * server collapses it anyway.
 */
export function editsFrom(initial, current, fields) {
  const edits = {};
  for (const name of fields) {
    const spec = SPEC[name];
    if (!spec || current[name] === undefined) continue;
    const before = tidy(initial ? initial[name] : '');
    const after = tidy(current[name]);
    if (before !== after) edits[name] = typed(spec.kind, after);
  }
  return edits;
}

/** The image list to send: undefined when the admin kept every offered image in order, else the ticked ones. */
export function imagesEdit(offered, picked) {
  const same = offered.length === picked.length && offered.every((url, i) => url === picked[i]);
  return same ? undefined : picked.slice(0, LIMITS.images);
}

/**
 * The listing importer:manual takes, from the typed-in form. Blank facts are
 * left out so normalizeListing can read them from the name; isMug is the
 * admin's own say-so, so a typed-in mug is never skipped as "not a mug".
 */
export function manualListing(values, imagesText = '', shopUrl = '') {
  const listing = { name: tidy(values.name), isMug: { verdict: 'yes', reason: 'entered by hand' }, images: lines(imagesText) };
  for (const field of ['brand', 'franchise', 'character', 'sku', 'gtin']) {
    const value = tidy(values[field]);
    if (value) listing[field] = value;
  }
  if (STYLES.includes(values.style)) listing.style = values.style;
  if (MATERIALS.includes(values.material)) listing.material = values.material;
  const ml = tidy(values.capacityMl);
  if (ml) listing.capacityMl = Number(ml);
  for (const field of ['hasLid', 'dishwasherSafe', 'microwaveSafe']) {
    if (values[field] === 'yes') listing[field] = true;
    if (values[field] === 'no') listing[field] = false;
  }
  const url = tidy(shopUrl);
  listing.source = url ? { url } : {};
  return listing;
}

/** The named controls' current values from a form, for editsFrom. */
export function readValues(form, fields) {
  const out = {};
  for (const name of fields) {
    const control = form.elements.namedItem(name);
    if (control && 'value' in control) out[name] = control.value;
  }
  return out;
}

function select(id, name, options, value, extra) {
  const items = options
    .map(([v, label]) => `<option value="${escHtml(v)}"${v === value ? ' selected' : ''}>${escHtml(label)}</option>`)
    .join('');
  return `<select class="select" id="${id}" name="${name}"${extra}>${items}</select>`;
}

function control(name, spec, value, id, described, styleAuto) {
  const v = escHtml(value);
  switch (spec.kind) {
    case 'text':
      return `<input class="input" id="${id}" name="${name}" type="text" value="${v}" maxlength="${spec.max}" autocomplete="off"${spec.required ? ' required' : ''}${spec.numeric ? ' inputmode="numeric"' : ''}${described}>`;
    case 'int':
      return `<input class="input" id="${id}" name="${name}" type="number" inputmode="numeric" step="1" min="${spec.min}" max="${spec.max}" value="${v}"${described}>`;
    case 'style': {
      const options = STYLES.map((s) => [s, STYLE_LABELS[s] || s]);
      return select(id, name, styleAuto ? [['', 'Work it out from the name'], ...options] : options, value, described);
    }
    case 'material':
      return select(id, name, [['', 'Not stated'], ...MATERIALS.map((m) => [m, cap(m)])], value, described);
    case 'tri':
      return select(id, name, TRI, value, described);
    case 'status':
      return select(id, name, [['published', 'Published'], ['hidden', 'Hidden']], value, described);
    case 'blurb':
      return `<textarea class="textarea" id="${id}" name="${name}" rows="3" maxlength="${spec.max}" data-counter="${id}-count"${described}>${v}</textarea>`;
    default:
      return '';
  }
}

/**
 * The fields as labelled controls, for an .admin-grid. idp makes every id
 * unique on the page (one review item's form beside twenty others).
 */
export function mugFields(values, { idp, fields, styleAuto = false }) {
  return fields
    .map((name) => {
      const spec = SPEC[name];
      if (!spec) return '';
      const value = String((values && values[name]) ?? '');
      const id = escHtml(`${idp}-${name}`);
      const hintId = `${id}-hint`;
      const described = spec.hint ? ` aria-describedby="${hintId}"` : '';
      const wide = spec.kind === 'blurb' ? ' field--wide' : '';
      const hint = spec.hint ? `<p class="hint" id="${hintId}">${escHtml(spec.hint)}</p>` : '';
      const counter = spec.kind === 'blurb' ? `<p class="hint" id="${id}-count">${value.length} / ${spec.max}</p>` : '';
      return `<div class="field${wide}"><label for="${id}">${escHtml(spec.label)}</label>${control(name, spec, value, id, described, styleAuto)}${hint}${counter}</div>`;
    })
    .join('');
}
