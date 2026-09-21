// ── Entry point ──────────────────────────────────────────────
// Import modules and initialize the app.
// Keep this file under 50 lines: it only wires things together.

import { state, loadSaved } from './state.js';
import { render } from './render.js';
import { bindEvents } from './events.js';

function init() {
  loadSaved(state);
  render(state);
  bindEvents(state);
}

init();
