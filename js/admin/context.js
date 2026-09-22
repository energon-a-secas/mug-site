// ── The console's shared context ─────────────────────────────
// What every section receives: the session, the live region, and the
// dashboard's counts. The counts are fetched once when the console opens and
// again after anything that changes them, so the rail's badges and the
// review tabs agree without each section asking on its own.

import { FN } from '../backend.js';
import { escHtml } from '../utils.js';
import { announce, countText } from './ui.js';

/** The rail's badges from an admin:dashboard answer: only work that waits for someone. */
export function railCounts(dash) {
  if (!dash) return {};
  return {
    review: dash.queue.pending,
    runs: dash.activeRuns,
    images: dash.images.thumbs,
    community: dash.photosPending,
    suggestions: dash.suggestionsPending,
    runner: dash.queue.needsLocal + dash.images.blocked,
  };
}

/**
 * The context handed to every section's mount(): { session, announce,
 * counts, loadCounts(), refreshCounts(), onCounts(fn) }. loadCounts throws
 * when the dashboard cannot be read; refreshCounts never does: it logs and
 * resolves to the last counts it had (or null).
 */
export function createContext(session, rail) {
  let counts = null;
  let asked = 0;
  let applied = 0;
  const listeners = new Set();

  const paint = () => {
    const values = railCounts(counts);
    for (const span of rail.querySelectorAll('[data-count]')) {
      const n = values[span.dataset.count] || 0;
      span.hidden = !n;
      span.innerHTML = n
        ? `<span class="visually-hidden">: </span>${escHtml(countText(n, counts.cap))}<span class="visually-hidden"> waiting</span>`
        : '';
    }
  };

  // A slow answer never overwrites a newer one.
  const load = async () => {
    const mine = ++asked;
    const dash = await session.query(FN.admin.dashboard, {});
    if (mine > applied) {
      applied = mine;
      counts = dash || null;
      paint();
      listeners.forEach((fn) => {
        try {
          fn(counts);
        } catch (err) {
          console.error('mug admin: a counts listener threw', err);
        }
      });
    }
    return counts;
  };

  return {
    session,
    announce,
    get counts() {
      return counts;
    },
    loadCounts: load,
    async refreshCounts() {
      try {
        return await load();
      } catch (err) {
        console.error('mug admin: the dashboard did not answer', err);
        return counts;
      }
    },
    onCounts(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
