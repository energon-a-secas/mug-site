// ── Suggest a correction (docs/CONTRACTS.md A17) ─────────────
// Any signed-in collector can propose different labels for a mug: a wrong
// style, a missing capacity, a franchise or character the catalogue lacks.
// Nothing on the page changes until a maintainer approves it in
// /admin/#suggestions. The server checks every field again and keeps only the
// ones that differ, so this form's own diff is a courtesy, not the guard.

import { MATERIALS, STYLES, STYLE_LABELS } from '../../shared/contract.js';
import { escHtml } from '../utils.js';

export const FIELD_LABELS = Object.freeze({
  name: 'Name',
  brand: 'Maker',
  franchise: 'Franchise',
  character: 'Character',
  style: 'Style',
  capacityMl: 'Capacity',
  material: 'Material',
  hasLid: 'Lid',
  dishwasherSafe: 'Dishwasher',
  microwaveSafe: 'Microwave',
  releaseYear: 'Released',
});

/** The mug's labels as the form shows them: names, not objects; null when unknown. */
export function labelsOf(m) {
  return {
    name: m.name,
    brand: m.brand ? m.brand.name : null,
    franchise: m.franchise ? m.franchise.name : null,
    character: m.character ?? null,
    style: m.style,
    capacityMl: m.capacityMl ?? null,
    material: m.material ?? null,
    hasLid: m.hasLid ?? null,
    dishwasherSafe: m.dishwasherSafe ?? null,
    microwaveSafe: m.microwaveSafe ?? null,
    releaseYear: m.releaseYear ?? null,
  };
}

const text = (name, label, value, attrs = '') =>
  `<label class="field"><span>${label}</span><input class="input" name="${name}" value="${escHtml(value ?? '')}" ${attrs}></label>`;

const choice = (name, label, value, options) =>
  `<label class="field"><span>${label}</span><select class="select" name="${name}">${options
    .map(([v, l]) => `<option value="${escHtml(v)}" ${String(value ?? '') === v ? 'selected' : ''}>${escHtml(l)}</option>`)
    .join('')}</select></label>`;

const flag = (name, label, value, yes, no) =>
  choice(name, label, value === true ? 'true' : value === false ? 'false' : '', [['', 'Not known'], ['true', yes], ['false', no]]);

/** The panel under a mug's facts: a sign-in prompt, or the form prefilled with today's labels. */
export function suggestPanel(m, signedIn) {
  if (m.hidden) return '';
  if (!signedIn) {
    return `<p class="hint">Something wrong or missing? <button type="button" class="btn btn--ghost btn--sm" data-suggest-sign-in>Sign in to suggest a correction</button></p>`;
  }
  const l = labelsOf(m);
  const waiting = m.suggestion
    ? `<p class="notice" data-suggest-status>Your suggestion (${escHtml(m.suggestion.fields.map((f) => FIELD_LABELS[f] || f).join(', '))}) is waiting for a maintainer. Sending again replaces it.</p>`
    : '';
  return `<details class="panel" id="suggestPanel" ${m.suggestion ? 'open' : ''}>
    <summary style="cursor:pointer;font-weight:600">Suggest a correction</summary>
    <form id="suggestForm" class="stack stack--tight" style="margin-top:var(--space-4)">
      ${waiting}
      <p class="hint">Change what is wrong or fill in what is missing, and a maintainer checks it before the page changes. A new franchise or character is fine.</p>
      ${text('name', 'Name', l.name, 'maxlength="200" required')}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-3)">
        ${text('brand', 'Maker', l.brand, 'maxlength="80"')}
        ${text('franchise', 'Franchise', l.franchise, 'maxlength="80"')}
        ${text('character', 'Character', l.character, 'maxlength="80"')}
        ${choice('style', 'Style', l.style, STYLES.map((s) => [s, STYLE_LABELS[s] || s]))}
        ${text('capacityMl', 'Capacity (ml)', l.capacityMl, 'inputmode="numeric" pattern="[0-9]*"')}
        ${choice('material', 'Material', l.material, [['', 'Not known'], ...MATERIALS.map((x) => [x, x[0].toUpperCase() + x.slice(1)])])}
        ${flag('hasLid', 'Lid', l.hasLid, 'Has a lid', 'No lid')}
        ${flag('dishwasherSafe', 'Dishwasher', l.dishwasherSafe, 'Safe', 'Hand wash only')}
        ${flag('microwaveSafe', 'Microwave', l.microwaveSafe, 'Safe', 'Not safe')}
        ${text('releaseYear', 'Released', l.releaseYear, 'inputmode="numeric" pattern="[0-9]{4}" placeholder="Year"')}
      </div>
      <label class="field"><span>Anything else</span><textarea class="textarea" name="note" maxlength="300" placeholder="Where you saw it, or what the fields above cannot say"></textarea></label>
      <div class="toolbar"><button class="btn btn--primary btn--sm" type="submit">Send suggestion</button></div>
    </form>
  </details>`;
}

function formValue(field, raw) {
  const value = String(raw ?? '').trim();
  if (field === 'name' || field === 'style') return value;
  if (!value) return null;
  if (field === 'capacityMl' || field === 'releaseYear') return Number(value);
  if (field === 'hasLid' || field === 'dishwasherSafe' || field === 'microwaveSafe') return value === 'true';
  return value;
}

/** { changes, note }: only the fields the collector changed, in the server's shapes. */
export function readSuggestion(form, m) {
  const data = new FormData(form);
  const before = labelsOf(m);
  const changes = {};
  for (const field of Object.keys(FIELD_LABELS)) {
    const value = formValue(field, data.get(field));
    const was = before[field];
    const same = typeof value === 'string' && typeof was === 'string' ? value === was.trim() : value === (was ?? null);
    if (!same) changes[field] = value;
  }
  return { changes, note: String(data.get('note') || '').trim() };
}
