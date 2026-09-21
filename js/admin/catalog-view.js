// ── Catalog: markup ──────────────────────────────────────────
// Pure functions for the catalogue editor: what mugs:adminList is asked for
// and how that reads, a row per mug, and the edit panel with its image
// order. js/admin/catalog.js wires them to the page.

import { STYLE_LABELS } from '../../shared/contract.js';
import { mugHref, tile } from '../render/cards.js';
import { escHtml, plural } from '../utils.js';
import { badge, extLink, shortUrl, when } from './ui.js';
import { CATALOG_FACTS, mugFields, valuesOf } from './mugform.js';

/** A mug's imageState, as the filter and the badges name it. */
export const IMAGE_STATES = Object.freeze([
  { value: 'pending', label: 'Mirroring', tone: 'info', words: 'mirroring is scheduled' },
  { value: 'blocked', label: 'Blocked, for the runner', tone: 'warn', words: 'the image host refused the cloud, so the runner fetches them' },
  { value: 'failed', label: 'Failed', tone: 'bad', words: 'mirroring gave up' },
  { value: 'thumbs', label: 'Thumbnails missing', tone: 'warn', words: 'stored, but thumbnails are missing' },
  { value: 'none', label: 'No images', tone: 'muted', words: 'no images' },
  { value: 'ok', label: 'Complete', tone: 'ok', words: 'all stored, with thumbnails' },
]);

const stateOf = (value) => IMAGE_STATES.find((s) => s.value === value) || { label: value, tone: 'muted', words: value };

/**
 * mugs:adminList's arguments for the filters. The server searches when q has
 * two or more characters (status still applies, the image filter does not),
 * else lists by image state (status does not apply), else by status.
 */
export function listArgs(filters, cursor = null, numItems = 24) {
  const args = { paginationOpts: { numItems, cursor } };
  const q = String(filters.q || '').trim();
  if (q.length >= 2) {
    args.q = q;
    if (filters.status) args.status = filters.status;
  } else if (filters.imageState) {
    args.imageState = filters.imageState;
  } else if (filters.status) {
    args.status = filters.status;
  }
  return args;
}

/** What the list shows for these filters, in a sentence, including which filter does not apply. */
export function describeFilters(filters) {
  const q = String(filters.q || '').trim();
  if (q.length >= 2) {
    const scope = filters.status ? `${filters.status} mugs` : 'all mugs';
    return `Searching ${scope} for "${q}".${filters.imageState ? ' The image filter does not apply to a search.' : ''}`;
  }
  const short = q.length === 1 ? ' Type at least two letters to search.' : '';
  if (filters.imageState) {
    return `Mugs whose images are: ${stateOf(filters.imageState).label.toLowerCase()}, newest first.${filters.status ? ' The status filter does not apply here.' : ''}${short}`;
  }
  if (filters.status === 'hidden') return `Hidden mugs, newest first.${short}`;
  return `Published mugs, newest first.${filters.status ? '' : ' Choose Hidden to see the rest.'}${short}`;
}

/** One row of the list: name, maker, state badges, counts, and Edit and Public page. */
export function mugRow(m) {
  const id = escHtml(m.id);
  const state = stateOf(m.imageState);
  const images = `${plural(m.images || 0, 'image')}${m.pendingImages ? `, ${m.pendingImages} waiting` : ''}`;
  const named = `<span class="visually-hidden"> ${escHtml(m.name)}</span>`;
  return `<li class="admin-row" data-id="${id}">
    <div class="admin-row__main">
      <p class="admin-row__title"><strong>${escHtml(m.name)}</strong>${m.brand ? ` <span class="muted">by ${escHtml(m.brand)}</span>` : ''}</p>
      <p class="admin-item__badges">
        ${badge(STYLE_LABELS[m.style] || m.style, 'info')}
        ${badge(m.status === 'hidden' ? 'Hidden' : 'Published', m.status === 'hidden' ? 'warn' : 'ok')}
        ${badge(`Images: ${state.label.toLowerCase()}`, state.tone)}
      </p>
      <p class="hint">${escHtml(images)} &middot; owned by ${escHtml(String(m.ownedCount || 0))} &middot; wanted by ${escHtml(String(m.wantedCount || 0))} &middot; updated ${when(m.updatedAt)}</p>
    </div>
    <div class="toolbar">
      <button type="button" class="btn btn--secondary btn--sm" data-act="edit">Edit${named}</button>
      <a class="btn btn--ghost btn--sm" href="${escHtml(mugHref(m.slug))}" target="_blank" rel="noopener">Public page${named}<span class="visually-hidden"> (new tab)</span></a>
    </div>
  </li>`;
}

/**
 * The stored images in the order being edited: order holds the kept images'
 * original indexes, removed the ones Save will drop (with Undo).
 */
export function imageRows(images, order, removed = []) {
  if (!images.length) return '<li class="muted">No stored images yet.</li>';
  const n = order.length;
  const kept = order.map((index, pos) => {
    const img = images[index];
    if (!img) return '';
    const label = `image ${pos + 1} of ${n}`;
    const facts = [img.store === 'r2' ? 'R2' : 'Convex storage', img.hasThumb ? '' : 'no thumbnail', img.w && img.h ? `${img.w}x${img.h} px` : '']
      .filter(Boolean)
      .join(', ');
    return `<li data-index="${index}">
      <div class="admin-imgs__tile">${tile(img.resolved, '')}</div>
      <div class="admin-imgs__info">
        <p>Image ${pos + 1}${pos === 0 ? ', the cover' : ''}</p>
        <p class="hint">${escHtml(facts)}${img.source ? ` &middot; ${extLink(img.source, 'where it came from')}` : ''}</p>
        <div class="toolbar">
          <button type="button" class="btn btn--secondary btn--sm" data-act="img-up"${pos === 0 ? ' disabled' : ''}>Up<span class="visually-hidden">: ${label}</span></button>
          <button type="button" class="btn btn--secondary btn--sm" data-act="img-down"${pos === n - 1 ? ' disabled' : ''}>Down<span class="visually-hidden">: ${label}</span></button>
          <button type="button" class="btn btn--ghost btn--sm" data-act="img-remove">Remove<span class="visually-hidden">: ${label}</span></button>
        </div>
      </div>
    </li>`;
  });
  const gone = removed.map((index) => {
    const img = images[index];
    if (!img) return '';
    return `<li data-index="${index}" data-removed>
      <div class="admin-imgs__tile">${tile(img.resolved, '')}</div>
      <div class="admin-imgs__info">
        <p>Removed when you save</p>
        <div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-act="img-undo">Undo<span class="visually-hidden">: keep this image</span></button></div>
      </div>
    </li>`;
  });
  return kept.join('') + gone.join('');
}

/** Images not stored yet (remote URLs), their state, and Retry images. */
export function pendingHtml(mug) {
  const pending = Array.isArray(mug.pendingImages) ? mug.pendingImages : [];
  if (!pending.length) return '';
  const state = stateOf(mug.imageState);
  const warn = mug.imageState === 'failed' || mug.imageState === 'blocked';
  return `<div class="notice${warn ? ' notice--warn' : ''} admin-outcome">
    <p>${escHtml(plural(pending.length, 'image'))} not stored yet: ${escHtml(state.words)}.</p>
    <ul class="admin-links">${pending.map((url) => `<li>${extLink(url, shortUrl(url))}</li>`).join('')}</ul>
    <div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-act="retry-images">Retry images</button></div>
  </div>`;
}

function shopPages(mug) {
  const pages = Array.isArray(mug.sources) ? mug.sources : [];
  if (!pages.length) return '';
  const rows = pages
    .map((s) => `<li>${s.url ? extLink(s.url, shortUrl(s.url)) : `<code>${escHtml(s.key)}</code>`} <span class="muted">seen ${when(s.lastSeenAt)}</span></li>`)
    .join('');
  return `<details class="admin-details"><summary>Shop pages it was read from (${pages.length})</summary><ul class="admin-links">${rows}</ul></details>`;
}

/** The edit panel for an adminGet answer. ed carries the image order being edited. */
export function editorHtml(mug, ed) {
  const values = valuesOf(mug);
  const state = stateOf(mug.imageState);
  return `<div class="section__header">
      <div class="section__titles">
        <p class="eyebrow">Editing</p>
        <h3 id="cat-ed-t" tabindex="-1">${escHtml(mug.name)}</h3>
        <p class="admin-item__badges">
          ${badge(mug.status === 'hidden' ? 'Hidden' : 'Published', mug.status === 'hidden' ? 'warn' : 'ok')}
          ${badge(`Images: ${state.label.toLowerCase()}`, state.tone)}
          <span class="muted">owned by ${escHtml(String(mug.ownedCount || 0))}, wanted by ${escHtml(String(mug.wantedCount || 0))}, updated ${when(mug.updatedAt)}</span>
        </p>
      </div>
      <div class="toolbar">
        <a class="btn btn--secondary btn--sm" href="${escHtml(mugHref(mug.slug))}" target="_blank" rel="noopener">Public page<span class="visually-hidden"> (new tab)</span></a>
        <button type="button" class="btn btn--ghost btn--sm" data-act="close">Close</button>
      </div>
    </div>
    <div data-ed-out></div>
    <form class="stack" data-form="mug">
      <fieldset><legend>Facts</legend><div class="admin-grid">${mugFields(values, { idp: 'cat', fields: CATALOG_FACTS })}</div></fieldset>
      <fieldset><legend>Blurb and visibility</legend><div class="admin-grid">${mugFields(values, { idp: 'cat', fields: ['blurb', 'status'] })}</div></fieldset>
      <fieldset>
        <legend>Images</legend>
        <ol class="admin-imgs" data-imgs>${imageRows(mug.images || [], ed.order, ed.removed)}</ol>
        <div data-pending>${pendingHtml(mug)}</div>
        <div class="admin-grid">
          <div class="field field--wide">
            <label for="cat-add">Add image URLs, one per line</label>
            <textarea class="textarea" id="cat-add" name="addImages" rows="2" placeholder="https://..." aria-describedby="cat-add-hint"></textarea>
            <p class="hint" id="cat-add-hint">https only. They are copied after you save.</p>
          </div>
          <div class="field field--wide">
            <label for="cat-upload">Upload an image from this computer</label>
            <div class="admin-inline">
              <input class="admin-file" id="cat-upload" type="file" accept="image/*" aria-describedby="cat-upload-hint">
              <button type="button" class="btn btn--secondary btn--sm" data-act="upload">Upload</button>
            </div>
            <p class="hint" id="cat-upload-hint">Resized to 1600 px in this browser before it is sent, and added after the other images.</p>
            <p class="hint" data-upload-status></p>
          </div>
        </div>
      </fieldset>
      <div class="toolbar"><button type="submit" class="btn btn--primary">Save changes</button></div>
    </form>
    ${shopPages(mug)}`;
}
