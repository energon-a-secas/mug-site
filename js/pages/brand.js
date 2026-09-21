// ── One maker: /brand/?<slug> ─────────────────────────────────

import { FN } from '../backend.js';
import { connect } from '../session.js';
import { mugGrid } from '../render/cards.js';
import { ICONS } from '../render/icons.js';
import { getUnits } from '../prefs.js';
import { $, bareParam, escHtml, plural, safeHref } from '../utils.js';
import { notConnected, skeletons } from './common.js';

const PAGE_SIZE = 24;

export async function start() {
  const slug = bareParam(location.search);
  const grid = $('#grid');
  if (!slug) {
    $('#brandName').textContent = 'No maker named';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}<p><a href="/">Browse the catalogue</a>.</p></div>`;
    return;
  }
  grid.innerHTML = skeletons(8);
  const session = await connect();
  if (!session.state.connected) {
    grid.innerHTML = notConnected();
    return;
  }
  const brand = await session.query(FN.catalog.brand, { slug }).catch(() => null);
  if (!brand) {
    $('#brandName').textContent = 'Maker not found';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}<p>No maker by that name. <a href="/">Browse the catalogue</a>.</p></div>`;
    grid.setAttribute('aria-busy', 'false');
    return;
  }
  document.title = `${brand.name} mugs | Mug`;
  $('#crumb').textContent = brand.name;
  $('#brandName').textContent = brand.name;
  const site = brand.website ? ` · <a href="${escHtml(safeHref(brand.website))}" rel="noopener" target="_blank">${escHtml(new URL(safeHref(brand.website), location.href).hostname)}</a>` : '';
  $('#brandMeta').innerHTML = `${escHtml(plural(brand.mugCount, 'mug'))} in the catalogue${site}`;

  let cursor = null;
  let cards = [];
  const more = $('#loadMore');
  const load = async () => {
    more.disabled = true;
    const result = await session.query(FN.catalog.list, { paginationOpts: { numItems: PAGE_SIZE, cursor }, brand: slug });
    cards = cards.concat(result.page);
    cursor = result.continueCursor;
    grid.innerHTML = cards.length ? mugGrid(cards, { units: getUnits() }) : `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}<p>No mugs from this maker yet.</p></div>`;
    grid.setAttribute('aria-busy', 'false');
    more.hidden = result.isDone;
    more.disabled = false;
  };
  more.addEventListener('click', load);
  await load().catch((err) => {
    console.error(err);
    grid.innerHTML = '<div class="notice notice--warn" role="alert" style="grid-column:1/-1">Could not load this maker. Reload to try again.</div>';
  });
}
