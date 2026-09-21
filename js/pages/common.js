// ── Pieces several pages share ───────────────────────────────

import { isLocalHost } from '../backend.js';
import { ICONS } from '../render/icons.js';

export function skeletons(n) {
  return Array.from({ length: n }, () => '<div class="skeleton skeleton-card" aria-hidden="true"></div>').join('');
}

/** What a page shows when no Convex deployment is configured (docs/CONTRACTS.md C6). */
export function notConnected() {
  const local = isLocalHost(location);
  return `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}
    <p><strong>The catalogue is not connected yet.</strong></p>
    <p class="hint">${local
      ? 'Point this page at a dev backend: add <code>?convex=http://127.0.0.1:3210</code> to the address (see the README).'
      : 'The backend is being set up. Check back soon.'}</p>
  </div>`;
}

export function signInPrompt(what) {
  return `<div class="empty">${ICONS.mug()}
    <p><strong>${what}</strong></p>
    <p class="hint">One Neorgon account works on every Neorgon site.</p>
    <button type="button" class="btn btn--primary" data-sign-in>Sign in</button>
  </div>`;
}

/** A capacity gauge: a mug outline filled to capacity, against a 1 litre stein. */
export function gauge(ml) {
  const level = Math.max(0.08, Math.min(1, (ml || 0) / 1000));
  const top = 8 + 38 * (1 - level);
  return `<svg class="gauge" viewBox="0 0 64 64" aria-hidden="true">
    <defs><clipPath id="gaugeBody"><path d="M10 8h36v36a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10z"/></clipPath></defs>
    <path class="body" d="M10 8h36v36a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10z"/>
    <rect class="fill" x="10" y="${top.toFixed(1)}" width="36" height="${(54 - top).toFixed(1)}" clip-path="url(#gaugeBody)" opacity="0.85"/>
    <path class="handle" d="M46 16h4a8 8 0 0 1 0 16h-4"/>
  </svg>`;
}
