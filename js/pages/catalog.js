// ── The catalogue: search, facets, the grid ──────────────────
// Filters live in the URL (?q=&brand=&franchise=&style=&sort=), so a filtered
// view can be linked, reloaded and gone back to.

import { FN } from '../backend.js';
import { STYLE_LABELS } from '../../shared/contract.js';
import { connect } from '../session.js';
import { mugGrid } from '../render/cards.js';
import { ICONS } from '../render/icons.js';
import { getUnits, setUnits } from '../prefs.js';
import { $, $$, debounce, escHtml, plural } from '../utils.js';
import { notConnected, skeletons } from './common.js';

const PAGE_SIZE = 24;
const KEYS = ['q', 'brand', 'franchise', 'style', 'sort'];

const view = { filters: {}, cursor: null, done: false, cards: [], facets: null, loading: false, token: 0 };

function readFilters() {
  const params = new URLSearchParams(location.search);
  const filters = {};
  for (const key of KEYS) {
    const value = (params.get(key) || '').trim();
    if (value) filters[key] = value;
  }
  return filters;
}

function writeFilters(filters, push = true) {
  const params = new URLSearchParams(location.search);
  for (const key of KEYS) {
    if (filters[key]) params.set(key, filters[key]);
    else params.delete(key);
  }
  const query = params.toString();
  const url = `${location.pathname}${query ? `?${query}` : ''}`;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

function facetName(kind, slug) {
  if (kind === 'style') return STYLE_LABELS[slug] || slug;
  const list = view.facets ? view.facets[kind === 'brand' ? 'brands' : 'franchises'] : [];
  return (list.find((item) => item.slug === slug) || {}).name || slug;
}

function paintFacets() {
  const f = view.facets;
  if (!f) return;
  const lists = {
    style: f.styles.map((s) => ({ value: s.style, name: STYLE_LABELS[s.style] || s.style, count: s.count })),
    brand: f.brands.map((b) => ({ value: b.slug, name: b.name, count: b.count })),
    franchise: f.franchises.map((x) => ({ value: x.slug, name: x.name, count: x.count })),
  };
  for (const [kind, items] of Object.entries(lists)) {
    const box = $(`[data-facet="${kind}"]`);
    if (!box) continue;
    box.closest('.facet').hidden = items.length === 0;
    box.innerHTML = items
      .map((item) => `<button type="button" data-kind="${kind}" data-value="${escHtml(item.value)}" aria-pressed="${view.filters[kind] === item.value}"><span>${escHtml(item.name)}</span><span class="n">${item.count}</span></button>`)
      .join('');
  }
  const t = f.totals;
  if (t.mugs) {
    $('#intro-counts').textContent = `${plural(t.mugs, 'mug')} from ${plural(f.brands.length, 'maker')}${t.collectors ? `, on ${plural(t.collectors, 'shared shelf', 'shared shelves')}` : ''}.`;
  }
}

function paintActive() {
  const chips = [];
  for (const key of ['brand', 'franchise', 'style']) {
    if (view.filters[key]) chips.push(`<button type="button" class="chip" aria-pressed="true" data-clear="${key}">${escHtml(facetName(key, view.filters[key]))} ${ICONS.close()}</button>`);
  }
  if (view.filters.q) chips.push(`<button type="button" class="chip" aria-pressed="true" data-clear="q">"${escHtml(view.filters.q)}" ${ICONS.close()}</button>`);
  $('#activeFilters').innerHTML = chips.join('');
}

function paintGrid() {
  const grid = $('#grid');
  grid.setAttribute('aria-busy', 'false');
  if (!view.cards.length) {
    const filtered = Object.keys(view.filters).some((k) => k !== 'sort');
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}<p>${filtered ? 'No mug matches that. Try fewer filters.' : 'The catalogue is empty so far. Mugs appear here once the admin approves them.'}</p></div>`;
  } else {
    grid.innerHTML = mugGrid(view.cards, { units: getUnits() });
  }
  $('#loadMore').hidden = view.done;
  const label = view.cards.length ? `${plural(view.cards.length, 'mug')}${view.done ? '' : ' so far'}` : '';
  $('#resultsLabel').textContent = label;
}

async function loadPage(session, reset) {
  const token = reset ? ++view.token : view.token;
  if (reset) {
    view.cursor = null;
    view.done = false;
    view.cards = [];
    $('#grid').innerHTML = skeletons(8);
    $('#grid').setAttribute('aria-busy', 'true');
  }
  view.loading = true;
  $('#loadMore').disabled = true;
  try {
    const result = await session.query(FN.catalog.list, {
      paginationOpts: { numItems: PAGE_SIZE, cursor: view.cursor },
      ...view.filters,
    });
    if (token !== view.token) return;
    view.cards = view.cards.concat(result.page);
    view.cursor = result.continueCursor;
    view.done = result.isDone;
    paintGrid();
  } catch (err) {
    console.error(err);
    $('#grid').innerHTML = '<div class="notice notice--warn" role="alert" style="grid-column:1/-1">Could not load the catalogue. Reload to try again.</div>';
  } finally {
    view.loading = false;
    $('#loadMore').disabled = false;
  }
}

function paintUnits() {
  const units = getUnits();
  $$('[data-units]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.units === units)));
}

export async function start() {
  view.filters = readFilters();
  $('#q').value = view.filters.q || '';
  $('#sort').value = view.filters.sort || 'featured';
  paintUnits();
  $('#grid').innerHTML = skeletons(8);

  const session = await connect();
  if (!session.state.connected) {
    $('#grid').innerHTML = notConnected();
    $('#grid').setAttribute('aria-busy', 'false');
    return;
  }

  const apply = (next, push = true) => {
    view.filters = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    writeFilters(view.filters, push);
    paintFacets();
    paintActive();
    loadPage(session, true);
  };

  $('#q').addEventListener('input', debounce(() => apply({ ...view.filters, q: $('#q').value.trim() }, false), 280));
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    apply({ ...view.filters, q: $('#q').value.trim() });
  });
  $('#sort').addEventListener('change', () => apply({ ...view.filters, sort: $('#sort').value === 'featured' ? '' : $('#sort').value }));
  $('#facets').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-kind]');
    if (!button) return;
    const { kind, value } = button.dataset;
    apply({ ...view.filters, [kind]: view.filters[kind] === value ? '' : value });
  });
  $('#activeFilters').addEventListener('click', (e) => {
    const button = e.target.closest('[data-clear]');
    if (!button) return;
    if (button.dataset.clear === 'q') $('#q').value = '';
    apply({ ...view.filters, [button.dataset.clear]: '' });
  });
  $('#facetsToggle').addEventListener('click', () => {
    const rail = $('#facets');
    const open = rail.classList.toggle('open');
    $('#facetsToggle').setAttribute('aria-expanded', String(open));
  });
  $('#loadMore').addEventListener('click', () => loadPage(session, false));
  $$('[data-units]').forEach((b) => b.addEventListener('click', () => {
    setUnits(b.dataset.units);
    paintUnits();
    paintGrid();
  }));
  window.addEventListener('popstate', () => {
    view.filters = readFilters();
    $('#q').value = view.filters.q || '';
    $('#sort').value = view.filters.sort || 'featured';
    paintFacets();
    paintActive();
    loadPage(session, true);
  });

  session.query(FN.catalog.facets, {}).then((facets) => {
    view.facets = facets;
    paintFacets();
    paintActive();
  }).catch((err) => console.error(err));
  paintActive();
  await loadPage(session, true);
}
