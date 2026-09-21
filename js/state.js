// ── State management ─────────────────────────────────────────
// Shared mutable state object. All modules import and mutate the
// same reference, replacing the original top-level `let` globals.

const STORAGE_KEY = 'app-state'; // Change per project

export const state = {
  // Add your app's state properties here
  data: null,
};

/** Load saved state from localStorage. */
export function loadSaved(s) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch { /* ignore corrupted data */ }
}

/** Persist current state to localStorage. */
export function save(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* quota exceeded or private browsing */ }
}
