// ── Overview: what waits, and how the deployment is set up ───
// admin:dashboard as tiles, each opening the section that holds that work,
// and the deployment's configuration said in sentences, because "proxy:
// false" does not tell the admin that every scan now needs the runner.

import { escHtml, plural } from '../utils.js';
import { countText, loadFailed, sectionHead, skeletonRows } from './ui.js';

/** The tiles, in reading order. capped: the dashboard stops counting at its cap. */
export const TILES = Object.freeze([
  { label: 'pending review', href: '#review/pending', value: (d) => d.queue.pending, capped: true },
  { label: 'need the runner', href: '#review/needsLocal', value: (d) => d.queue.needsLocal, capped: true },
  { label: 'failed pages', href: '#review/failed', value: (d) => d.queue.failed, capped: true },
  { label: 'mugs with images waiting', href: '#catalog/pending', value: (d) => d.images.pending, capped: true },
  { label: 'mugs with blocked images', href: '#catalog/blocked', value: (d) => d.images.blocked, capped: true },
  { label: 'mugs whose images failed', href: '#catalog/failed', value: (d) => d.images.failed, capped: true },
  { label: 'mugs missing thumbnails', href: '#images', value: (d) => d.images.thumbs, capped: true },
  { label: 'photos to moderate', href: '#community', value: (d) => d.photosPending, capped: true },
  { label: 'label suggestions to review', href: '#suggestions', value: (d) => d.suggestionsPending, capped: true },
  { label: 'active scans', href: '#runs', value: (d) => d.activeRuns, capped: false },
  { label: 'mugs published', href: '#catalog', value: (d) => d.mugs, capped: false, quiet: true },
]);

/** The configuration as notices and facts. Every value from the server is escaped. */
export function configHtml(config) {
  const c = config || {};
  const notices = [];
  if (!c.proxy) {
    notices.push(`<div class="notice notice--warn"><p>Cloud fetching is off; scans need the runner, and images are stored in Convex until the Worker is set. Set <code>MUG_PROXY_URL</code> and <code>MUG_PROXY_TOKEN</code> on the deployment to turn it on.</p></div>`);
  }
  if (!c.publishing) {
    notices.push('<div class="notice"><p>Public shelves are closed; set <code>PUBLISHING=open</code> on the deployment when ready.</p></div>');
  }
  const admins = Number(c.admins) || 0;
  return `<section class="stack stack--tight" aria-labelledby="ov-config">
    <h3 id="ov-config">This deployment</h3>
    ${notices.join('')}
    <dl class="fact-table admin-facts">
      <dt>Cloud fetching</dt><dd>${c.proxy ? 'on: the Worker reads shops and stores images in R2' : 'off'}</dd>
      <dt>Images base</dt><dd>${c.imagesBase ? `<code>${escHtml(c.imagesBase)}</code>` : 'none: images are served from Convex storage'}</dd>
      <dt>Public shelves</dt><dd>${c.publishing ? 'open' : 'closed'}</dd>
      <dt>Maintainers</dt><dd>${escHtml(plural(admins, 'account'))} in <code>ADMIN_SUBJECTS</code></dd>
    </dl>
  </section>`;
}

/** The whole overview from an admin:dashboard answer. */
export function overviewHtml(dash) {
  const tiles = TILES.map((tile) => {
    const n = Number(tile.value(dash)) || 0;
    const hot = n > 0 && !tile.quiet;
    return `<a class="stat admin-stat${hot ? ' admin-stat--hot' : ''}" href="${tile.href}">
      <b>${escHtml(countText(n, tile.capped ? dash.cap : 0))}</b><span>${escHtml(tile.label)}</span>
    </a>`;
  }).join('');
  return `<section class="stack stack--tight" aria-labelledby="ov-work">
      <h3 id="ov-work">Waiting for you</h3>
      <div class="stat-row">${tiles}</div>
      <p class="hint">Counts stop at ${escHtml(countText(dash.cap))}; a tile opens the section that holds the work.</p>
    </section>
    ${configHtml(dash.config)}`;
}

/** Mounts the overview into el. */
export function mount(el, ctx) {
  let alive = true;
  el.innerHTML = `${sectionHead('Overview', 'What waits for you, and how this deployment is set up.', '<button type="button" class="btn btn--secondary btn--sm" data-act="reload">Refresh</button>')}
    <div class="stack" data-body aria-busy="true">${skeletonRows(2)}</div>`;
  const body = el.querySelector('[data-body]');

  const load = async () => {
    body.setAttribute('aria-busy', 'true');
    let dash = null;
    let failed = false;
    try {
      dash = await ctx.loadCounts();
    } catch (err) {
      console.error(err);
      failed = true;
    }
    if (!alive) return;
    body.setAttribute('aria-busy', 'false');
    if (dash) body.innerHTML = overviewHtml(dash);
    else body.innerHTML = loadFailed(failed ? 'Could not load the dashboard. Check your connection.' : 'The dashboard answered nothing: this account may no longer be a maintainer.');
  };

  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act="reload"]');
    if (!button) return;
    load().then(() => ctx.announce('Overview refreshed.'));
  });
  load();
  return () => {
    alive = false;
  };
}
