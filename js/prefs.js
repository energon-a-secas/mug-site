// ── Per-visitor preferences ───────────────────────────────────
// Browser storage holds conveniences only, never anything that must survive:
// every read and write is guarded, and the page works without it.

const UNITS_KEY = 'mug:units';

export function getUnits() {
  try {
    return localStorage.getItem(UNITS_KEY) === 'oz' ? 'oz' : 'ml';
  } catch {
    return 'ml';
  }
}

export function setUnits(units) {
  try {
    localStorage.setItem(UNITS_KEY, units === 'oz' ? 'oz' : 'ml');
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
  document.dispatchEvent(new CustomEvent('mug:units', { detail: units }));
}
