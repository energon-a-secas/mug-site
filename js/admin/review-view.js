// ── Review queue: markup ─────────────────────────────────────
// Pure functions from staging:list rows to HTML. js/admin/review.js wires
// them to the page, and tests/admin-render.test.mjs holds them to escaping
// every value a shop, a paste or a scan put into a row.

import { mugHref, tile } from '../render/cards.js';
import { escHtml, plural } from '../utils.js';
import { badge, countText, extLink, factsList, hostOf, httpUrl, shortUrl, verdictBadge, when } from './ui.js';
import { REVIEW_FIELDS, mugFields, valuesOf } from './mugform.js';

/** The tabs, one per staging status. count reads the dashboard's queue counts. */
export const TABS = Object.freeze([
  { status: 'pending', label: 'Pending', count: (d) => d.queue.pending },
  { status: 'needsLocal', label: 'Needs runner', count: (d) => d.queue.needsLocal },
  { status: 'failed', label: 'Failed', count: (d) => d.queue.failed },
  { status: 'queued', label: 'Queued', count: (d) => d.queue.queued },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
]);

/** staging:bulkApprove takes at most this many ids. */
export const BULK_MAX = 25;

const LEADS = {
  pending: 'Approve makes a mug (or updates the one a changed listing belongs to), Merge adds the listing to a mug you pick, Reject closes it. Tick the images to import.',
  needsLocal: 'Pages a shop refused to the cloud. The runner reads them from your own connection: <code>node runner/mug-runner.mjs drain</code>.',
  failed: 'Pages that could not be read. Retry sends one to the runner queue.',
  queued: 'Pages a scan found and has not read yet.',
  approved: 'Listings that became, or updated, a mug. Newest first.',
  rejected: 'Listings you rejected, and pages that turned out not to be mugs.',
};

const EMPTY = {
  pending: 'Nothing waits for review. Scans and imports add listings here.',
  needsLocal: 'No page waits for the runner.',
  failed: 'No page has failed.',
  queued: 'No page is queued.',
  approved: 'Nothing approved yet.',
  rejected: 'Nothing rejected yet.',
};

const FIELD_WORDS = { name: 'name', capacityMl: 'capacity', style: 'style', price: 'price', images: 'images', gtin: 'GTIN', sku: 'SKU' };

/** A tab's count badge contents: the number with words for screen readers, or '' for none. */
export function tabCount(n, cap) {
  return n ? `<span class="visually-hidden">, </span>${escHtml(countText(n, cap))}` : '';
}

/** The tab buttons (role="tab"), manual activation, with dashboard counts where there are any. */
export function tabsHtml(active, dash) {
  return TABS.map((tab) => {
    const on = tab.status === active;
    const n = dash && tab.count ? Number(tab.count(dash)) || 0 : 0;
    return `<button type="button" role="tab" id="tab-${tab.status}" data-tab="${tab.status}" aria-selected="${on}" aria-controls="review-panel" tabindex="${on ? 0 : -1}">${escHtml(tab.label)}<span class="admin-count" data-tab-count="${tab.status}"${n ? '' : ' hidden'}>${tabCount(n, dash && dash.cap)}</span></button>`;
  }).join('');
}

/** What a tab holds, in a sentence (trusted markup). */
export function panelLead(status) {
  return LEADS[status] || '';
}

/** The empty state for a tab. */
export function emptyHtml(status) {
  return `<div class="empty"><p>${escHtml(EMPTY[status] || 'Nothing here.')}</p></div>`;
}

/** How the queue matched the listing: new, changed (which fields) or similar (to which mug). */
export function matchBadge(match) {
  if (!match) return badge('Not matched yet', 'muted');
  const mug = match.mug ? `<a href="${escHtml(mugHref(match.mug.slug))}">${escHtml(match.mug.name)}</a>` : '';
  switch (match.kind) {
    case 'new':
      return badge('New', 'ok');
    case 'changed': {
      const fields = (match.fields || []).map((f) => FIELD_WORDS[f] || f).join(', ');
      return `${badge(`Changed: ${fields || 'details'}`, 'warn')}${mug ? ` <span class="muted">updates ${mug}</span>` : ''}`;
    }
    case 'similar':
      return `${badge('Similar', 'warn')}${mug ? ` <span class="muted">to ${mug}</span>` : ''}`;
    default:
      return badge(match.kind === 'same' ? 'Same' : String(match.kind || 'Unknown'), 'muted');
  }
}

/** The Approve button's words: a changed listing updates its mug, a similar one becomes a second mug. */
export function approveLabel(match) {
  if (match && match.kind === 'changed' && match.mugId) return 'Approve update';
  if (match && match.kind === 'similar') return 'Approve as a new mug';
  return 'Approve';
}

/** The listing's images the page may show: absolute https URLs only. */
export function offeredImages(listing) {
  return (listing && Array.isArray(listing.images) ? listing.images : []).filter((url) => /^https:\/\//i.test(url) && httpUrl(url));
}

function sourceWords(item) {
  if (item.source && item.source.name) return item.source.name;
  const platform = item.listing && item.listing.source ? item.listing.source.platform : '';
  if (platform === 'paste') return 'Pasted';
  if (platform === 'manual') return 'Typed in';
  return 'Imported by URL';
}

// The shop page to link: the listing's own URL, else the row's, and only a real http(s) one.
function shopUrlOf(item) {
  const listed = item.listing && item.listing.source ? item.listing.source.url : '';
  return [listed, item.url].find((url) => httpUrl(url)) || '';
}

function picks(images) {
  if (!images.length) return '<p class="muted">This listing has no images.</p>';
  const boxes = images
    .map((url, i) => `<label class="admin-pick">
        <input type="checkbox" name="img" value="${escHtml(url)}" checked>
        <span class="visually-hidden">Import image ${i + 1} of ${images.length}</span>
        ${tile({ src: url, thumb: url }, '')}
      </label>`)
    .join('');
  return `<fieldset class="admin-picks"><legend>Images to import</legend><div class="admin-picks__grid">${boxes}</div></fieldset>`;
}

/** A pending row: images to tick, facts, match, verdict, the shop's text, an edit form and the three answers. */
export function pendingItem(item) {
  const l = item.listing;
  const id = escHtml(item.id);
  const url = shopUrlOf(item);
  const via = l.source ? `${l.source.platform} via ${l.source.via}` : '';
  const meta = [escHtml(sourceWords(item)), url ? extLink(url, hostOf(url)) : '', escHtml(via), item.createdAt ? `staged ${when(item.createdAt)}` : '']
    .filter(Boolean)
    .join(' &middot; ');
  const reasons = [item.match && item.match.reason ? `Match: ${item.match.reason}.` : '', l.isMug && l.isMug.reason ? `Mug check: ${l.isMug.reason}.` : '']
    .filter(Boolean)
    .join(' ');
  const description = l.description
    ? `<details class="admin-details admin-desc"><summary>The shop's description (for reference, never published)</summary><p>${escHtml(l.description)}</p></details>`
    : '';
  return `<article class="admin-item" id="item-${id}" data-id="${id}" data-status="pending" aria-labelledby="item-${id}-t">
    <header class="admin-item__head">
      <h3 id="item-${id}-t" tabindex="-1">${escHtml(l.name)}</h3>
      <p class="admin-item__badges">${matchBadge(item.match)} ${verdictBadge(l.isMug)}</p>
      <p class="muted admin-item__meta">${meta}</p>
      ${reasons ? `<p class="hint">${escHtml(reasons)}</p>` : ''}
    </header>
    <form class="admin-item__form stack stack--tight" data-form="review">
      <div class="admin-item__body">
        ${picks(offeredImages(l))}
        ${factsList(l)}
      </div>
      ${description}
      <details class="admin-details" data-edit>
        <summary>Edit before approving</summary>
        <div class="admin-grid">${mugFields(valuesOf(l), { idp: `r-${item.id}`, fields: REVIEW_FIELDS })}</div>
        <p class="hint">Only the fields you change are sent.</p>
      </details>
      <div class="toolbar">
        <button type="submit" class="btn btn--primary" data-act="approve">${escHtml(approveLabel(item.match))}</button>
        <button type="button" class="btn btn--secondary" data-act="merge" aria-expanded="false" aria-controls="merge-${id}">Merge into...</button>
        <button type="button" class="btn btn--ghost" data-act="reject">Reject</button>
      </div>
      <p class="error-text" data-msg></p>
    </form>
    <section class="admin-merge stack stack--tight" id="merge-${id}" aria-label="Merge into a mug" hidden>
      <div class="field">
        <label for="merge-q-${id}">Find the mug this listing is</label>
        <input class="input" type="search" id="merge-q-${id}" data-merge-q autocomplete="off">
      </div>
      <p class="hint" data-merge-status aria-live="polite"></p>
      <ul class="admin-merge__list" data-merge-results></ul>
      <p class="hint">Merging keeps the mug's own facts, fills its blanks from the listing and adds the images you ticked.</p>
    </section>
  </article>`;
}

/** A row in any other tab: what it is, its error, and Retry or Reject where they apply. */
export function otherItem(item) {
  const l = item.listing;
  const id = escHtml(item.id);
  const url = shopUrlOf(item);
  const title = (l && l.name) || (url ? shortUrl(url) : '') || item.key || 'Queue item';
  const meta = [
    escHtml(sourceWords(item)),
    url ? extLink(url, hostOf(url)) : '',
    item.attempts ? escHtml(plural(item.attempts, 'attempt')) : '',
    item.updatedAt ? `updated ${when(item.updatedAt)}` : '',
  ].filter(Boolean).join(' &middot; ');
  const notes = [];
  if (item.error) notes.push(`<p class="error-text"><code>${escHtml(item.error.code)}</code> ${escHtml(item.error.message)}</p>`);
  if (item.status === 'approved' && item.mug) notes.push(`<p>Approved as <a href="${escHtml(mugHref(item.mug.slug))}">${escHtml(item.mug.name)}</a>.</p>`);
  if (item.status === 'needsLocal') notes.push('<p class="hint">Waiting for the runner on your workstation.</p>');
  const actions = [];
  if ((item.status === 'needsLocal' || item.status === 'failed') && item.url) {
    actions.push('<button type="button" class="btn btn--secondary btn--sm" data-act="retry">Retry</button>');
  }
  if (item.status !== 'approved' && item.status !== 'rejected') {
    actions.push('<button type="button" class="btn btn--ghost btn--sm" data-act="reject">Reject</button>');
  }
  return `<article class="admin-item admin-item--row" id="item-${id}" data-id="${id}" data-status="${escHtml(item.status)}" aria-labelledby="item-${id}-t">
    <h3 id="item-${id}-t" tabindex="-1">${escHtml(title)}</h3>
    <p class="muted admin-item__meta">${meta}</p>
    ${notes.join('')}
    ${actions.length ? `<div class="toolbar">${actions.join('')}</div>` : ''}
    <p class="error-text" data-msg></p>
  </article>`;
}

/** The right markup for a row of any status. */
export function itemHtml(item) {
  return item.status === 'pending' && item.listing ? pendingItem(item) : otherItem(item);
}

/**
 * Which rows on screen bulk approval may take: pending, matched as new, and
 * read as a mug, never one the admin has edited (isEdited(id)). ids holds at
 * most BULK_MAX; more counts the rest; edited counts the ones left out.
 */
export function bulkCandidates(items, isEdited = () => false) {
  const eligible = [];
  let edited = 0;
  for (const item of items) {
    if (item.status !== 'pending' || !item.match || item.match.kind !== 'new') continue;
    if (!item.listing || !item.listing.isMug || item.listing.isMug.verdict !== 'yes') continue;
    if (isEdited(item.id)) edited++;
    else eligible.push(item.id);
  }
  return { ids: eligible.slice(0, BULK_MAX), more: Math.max(0, eligible.length - BULK_MAX), edited };
}

/** The merge picker's choices: mugs:pick results, with the queue's own match first when it found one. */
export function mergeResults(results, match) {
  const suggested = match && match.mug && (match.kind === 'similar' || match.kind === 'changed') ? match.mug : null;
  const list = (Array.isArray(results) ? results : []).map((m) => ({ ...m, suggested: !!suggested && m.id === suggested.id }));
  if (suggested && !list.some((m) => m.suggested)) list.unshift({ ...suggested, suggested: true });
  return list
    .map((m) => {
      const notes = [m.brand, m.status === 'hidden' ? 'hidden' : '', m.suggested ? 'the match the queue found' : ''].filter(Boolean).join(', ');
      return `<li class="admin-merge__hit">
        <button type="button" class="btn btn--secondary btn--sm" data-act="merge-into" data-mug="${escHtml(m.id)}" data-name="${escHtml(m.name)}">Merge into ${escHtml(m.name)}</button>
        ${notes ? `<span class="muted">${escHtml(notes)}</span>` : ''}
        <a href="${escHtml(mugHref(m.slug))}" target="_blank" rel="noopener">View<span class="visually-hidden"> ${escHtml(m.name)} (new tab)</span></a>
      </li>`;
    })
    .join('');
}
