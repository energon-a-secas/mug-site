// ── One mug: /mug/?<slug> ─────────────────────────────────────
// Facts, gallery, where it is sold, the visitor's own shelf state and notes,
// collectors' photos, and mugs like it. The slug rides in the query string, so
// the page is a real file and never GitHub Pages' 404 (vitrina's /u/ lesson).

import { FN } from '../backend.js';
import { STYLE_LABELS } from '../../shared/contract.js';
import { connect } from '../session.js';
import { brandHref, mugGrid, tile } from '../render/cards.js';
import { ICONS } from '../render/icons.js';
import { resize, upload } from '../images.js';
import { getUnits, setUnits } from '../prefs.js';
import { $, $$, bareParam, escHtml, formatCapacity, formatPrice, safeHref, showToast, timeAgo } from '../utils.js';
import { gauge, notConnected } from './common.js';

const view = { mug: null, image: 0, session: null, busy: false };

const yesNo = (value, yes, no) => (value === true ? yes : value === false ? no : '');

function factRows(m, units) {
  const rows = [
    ['Style', STYLE_LABELS[m.style] || m.style],
    ['Material', m.material ? m.material[0].toUpperCase() + m.material.slice(1) : ''],
    ['Lid', m.hasLid ? 'Yes' : ''],
    ['Dishwasher', yesNo(m.dishwasherSafe, 'Safe', 'Hand wash only')],
    ['Microwave', yesNo(m.microwaveSafe, 'Safe', 'Not safe')],
    ['Released', m.releaseYear ? String(m.releaseYear) : ''],
    ['SKU', m.sku ? `<span class="mono">${escHtml(m.sku)}</span>` : ''],
    ['Barcode', m.gtin ? `<span class="mono">${escHtml(m.gtin)}</span>` : ''],
  ].filter(([, v]) => v);
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === 'SKU' || k === 'Barcode' ? v : escHtml(v)}</dd>`).join('');
}

function shopLinks(m) {
  const price = m.lastPrice ? `<p class="hint">Last seen at ${escHtml(formatPrice(m.lastPrice))}, ${escHtml(timeAgo(m.lastPrice.at))}.</p>` : '';
  const links = m.links
    .map((l) => `<a href="${escHtml(safeHref(l.url))}" rel="noopener nofollow" target="_blank">${ICONS.external()} ${escHtml(l.label || l.url)}</a>`)
    .join('');
  return links ? `<div class="shop-links"><p class="eyebrow">Where it is sold</p>${links}${price}</div>` : '';
}

function shelfControls(m) {
  const state = m.mine ? m.mine.state : null;
  const button = (value, label, icon) =>
    `<button type="button" data-state="${value}" aria-pressed="${state === value}">${ICONS[icon]()} ${label}</button>`;
  const counts = [];
  if (m.ownedCount) counts.push(`${m.ownedCount} ${m.ownedCount === 1 ? 'collector owns' : 'collectors own'} it`);
  if (m.wantedCount) counts.push(`${m.wantedCount} ${m.wantedCount === 1 ? 'wants' : 'want'} it`);
  return `<div class="shelf-actions">
    <div class="segmented" role="group" aria-label="On your shelf">
      ${button('owned', 'Own it', 'own')}${button('wanted', 'Want it', 'want')}${button('had', 'Had it', 'had')}
    </div>
    <p class="hint" id="shelfHint">${counts.length ? escHtml(counts.join(', ')) + '.' : 'Nobody has shelved it yet.'}</p>
  </div>`;
}

function notesForm(mine) {
  if (!mine) return '';
  const cond = (v, l) => `<option value="${v}" ${mine.condition === v ? 'selected' : ''}>${l}</option>`;
  return `<details class="panel" ${mine.note || mine.pricePaid ? 'open' : ''}>
    <summary style="cursor:pointer;font-weight:600">Your notes</summary>
    <form id="notesForm" class="stack stack--tight" style="margin-top:var(--space-4)">
      <label class="field"><span>Note</span><textarea class="textarea" name="note" maxlength="500">${escHtml(mine.note || '')}</textarea></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-3)">
        <label class="field"><span>Condition</span><select class="select" name="condition"><option value="">Not set</option>${cond('mint', 'Mint')}${cond('boxed', 'Boxed')}${cond('used', 'Used')}${cond('chipped', 'Chipped')}</select></label>
        <label class="field"><span>Price paid</span><input class="input" name="pricePaid" inputmode="decimal" value="${mine.pricePaid ?? ''}"></label>
        <label class="field"><span>Currency</span><input class="input" name="currency" maxlength="3" placeholder="USD" value="${escHtml(mine.currency || '')}"></label>
        <label class="field"><span>Got it on</span><input class="input" type="date" name="acquiredOn" value="${escHtml(mine.acquiredOn || '')}"></label>
      </div>
      <div class="toolbar"><button class="btn btn--primary btn--sm" type="submit">Save notes</button></div>
    </form>
  </details>`;
}

function photoPanel(m) {
  const canAdd = m.mine && m.mine.state !== 'wanted';
  const photos = m.photos
    .map((p) => `<figure class="photo"><img src="${escHtml(p.image.thumb)}" alt="${escHtml(p.caption || `${m.name}, on ${p.name}'s shelf`)}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${p.caption ? `${escHtml(p.caption)}, ` : ''}<a href="/u/?${encodeURIComponent(p.handle)}">${escHtml(p.name)}</a></figcaption></figure>`)
    .join('');
  if (!photos && !canAdd) return '';
  return `<section class="stack stack--tight" aria-labelledby="photos-title">
    <div class="section__header"><h3 class="section__title" id="photos-title">On collectors' shelves</h3>
      ${canAdd ? `<div class="toolbar"><label class="visually-hidden" for="photoCaption">Caption for your photo</label><input class="input" id="photoCaption" maxlength="140" placeholder="Caption (optional)" style="width:auto;min-height:36px"><label class="btn btn--secondary btn--sm" style="cursor:pointer">${ICONS.camera()} Add your photo<input type="file" id="photoInput" accept="image/jpeg,image/png,image/webp" class="visually-hidden"></label></div>` : ''}
    </div>
    ${photos ? `<div class="photos">${photos}</div>` : '<p class="hint">No photos yet. Photos are checked by a person before they appear.</p>'}
  </section>`;
}

function render() {
  const m = view.mug;
  const units = getUnits();
  const images = m.images.length ? m.images : [null];
  const current = images[Math.min(view.image, images.length - 1)];
  const eyebrow = [m.franchise ? `<a href="/?franchise=${encodeURIComponent(m.franchise.slug)}">${escHtml(m.franchise.name)}</a>` : '', m.character ? escHtml(m.character) : ''].filter(Boolean).join(' · ');
  $('#mugRoot').innerHTML = `
    ${m.hidden ? '<div class="notice notice--warn" style="margin-bottom:var(--space-4)">Hidden from the catalogue. Only admins see this page.</div>' : ''}
    <div class="mug-page">
      <div class="gallery">
        ${tile(current, m.name, { eager: true, size: 'full' })}
        ${m.images.length > 1 ? `<div class="gallery__thumbs">${m.images.map((img, i) => `<button type="button" data-image="${i}" aria-current="${i === view.image}" aria-label="Photo ${i + 1} of ${m.images.length}">${tile(img, '')}</button>`).join('')}</div>` : ''}
        ${m.imagesPending ? `<p class="hint">${m.imagesPending} more ${m.imagesPending === 1 ? 'photo is' : 'photos are'} on the way.</p>` : ''}
      </div>
      <div class="facts">
        <div class="stack stack--tight">
          ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}
          <h2>${escHtml(m.name)}</h2>
          <p class="byline">${m.brand ? `<a href="${brandHref(m.brand.slug)}">${escHtml(m.brand.name)}</a>` : '<span class="muted">Maker unknown</span>'}<span class="style-chip">${escHtml(STYLE_LABELS[m.style] || m.style)}</span></p>
        </div>
        ${m.capacityMl ? `<div class="capacity">${gauge(m.capacityMl)}<div><div class="capacity__value">${escHtml(formatCapacity(m.capacityMl, units))}</div><div class="segmented" role="group" aria-label="Units"><button type="button" data-units="ml" aria-pressed="${units === 'ml'}">ml</button><button type="button" data-units="oz" aria-pressed="${units === 'oz'}">oz</button></div></div></div>` : ''}
        ${m.blurb ? `<p style="line-height:1.6;color:var(--text-secondary)">${escHtml(m.blurb)}</p>` : ''}
        <dl class="fact-table">${factRows(m, units)}</dl>
        ${shelfControls(m)}
        ${notesForm(m.mine)}
        ${shopLinks(m)}
        ${m.canEdit ? `<p class="hint"><a href="/admin/#catalog">Edit in admin</a></p>` : ''}
      </div>
    </div>
    <div class="stack stack--loose" style="margin-top:56px">
      ${photoPanel(m)}
      ${m.related.length ? `<section class="stack stack--tight" aria-labelledby="related-title"><h3 class="section__title" id="related-title">${m.franchise ? `More ${escHtml(m.franchise.name)}` : m.brand ? `More from ${escHtml(m.brand.name)}` : 'More like it'}</h3><div class="mug-grid">${mugGrid(m.related, { units })}</div></section>` : ''}
    </div>`;
  $('#mugRoot').setAttribute('aria-busy', 'false');
}

async function setState(state) {
  const session = view.session;
  if (view.busy) return;
  if (!(await session.requireSignIn({ reason: 'Sign in to keep a shelf of your mugs.' }))) return;
  const next = view.mug.mine && view.mug.mine.state === state ? null : state;
  view.busy = true;
  const result = await session.mutation(FN.shelf.set, { slug: view.mug.slug, state: next });
  view.busy = false;
  if (!result.ok) return showToast(result.message, 'error');
  showToast(next === 'owned' ? 'On your shelf.' : next === 'wanted' ? 'On your want list.' : next === 'had' ? 'Marked as once owned.' : 'Removed from your shelf.');
  await refresh();
}

async function saveNotes(form) {
  const data = Object.fromEntries(new FormData(form));
  const result = await view.session.mutation(FN.shelf.update, {
    slug: view.mug.slug,
    note: data.note || null,
    condition: data.condition || null,
    pricePaid: data.pricePaid ? data.pricePaid : null,
    currency: data.currency || null,
    acquiredOn: data.acquiredOn || null,
  });
  showToast(result.ok ? 'Notes saved.' : result.message, result.ok ? 'info' : 'error');
  if (result.ok) await refresh();
}

async function addPhoto(file) {
  const session = view.session;
  if (!file) return;
  showToast('Preparing your photo...');
  try {
    const { blob } = await resize(file, 1600);
    const url = await session.mutation(FN.photos.uploadUrl, {});
    if (!url.ok) return showToast(url.message, 'error');
    const storageId = await upload(url.uploadUrl, blob);
    const caption = ($('#photoCaption')?.value || '').trim().slice(0, 140);
    const result = await session.mutation(FN.photos.add, { slug: view.mug.slug, storageId, caption });
    showToast(result.ok ? 'Thanks. Your photo appears once a person has checked it.' : result.message, result.ok ? 'info' : 'error');
  } catch (err) {
    console.error(err);
    showToast('That photo could not be uploaded. Try a JPEG or PNG.', 'error');
  }
}

async function refresh() {
  const mug = await view.session.query(FN.catalog.get, { slug: view.mug.slug });
  if (mug) {
    view.mug = mug;
    render();
  }
}

export async function start() {
  const slug = bareParam(location.search);
  const root = $('#mugRoot');
  if (!slug) {
    root.innerHTML = `<div class="empty">${ICONS.mug()}<p>No mug named here. <a href="/">Browse the catalogue</a>.</p></div>`;
    return;
  }
  const session = await connect();
  view.session = session;
  if (!session.state.connected) {
    root.innerHTML = notConnected();
    return;
  }
  let mug;
  try {
    mug = await session.query(FN.catalog.get, { slug });
  } catch (err) {
    console.error(err);
    root.innerHTML = '<div class="notice notice--warn" role="alert">Could not load this mug. Reload to try again.</div>';
    return;
  }
  if (!mug) {
    root.innerHTML = `<div class="empty">${ICONS.mug()}<p>That mug is not in the catalogue. <a href="/">Browse the catalogue</a>.</p></div>`;
    root.setAttribute('aria-busy', 'false');
    return;
  }
  view.mug = mug;
  document.title = `${mug.name} | Mug`;
  $('#crumb').textContent = mug.name;
  render();

  root.addEventListener('click', (e) => {
    const stateBtn = e.target.closest('[data-state]');
    if (stateBtn) return setState(stateBtn.dataset.state);
    const imageBtn = e.target.closest('[data-image]');
    if (imageBtn) {
      view.image = Number(imageBtn.dataset.image);
      render();
      return;
    }
    const unitsBtn = e.target.closest('[data-units]');
    if (unitsBtn) {
      setUnits(unitsBtn.dataset.units);
      render();
    }
  });
  root.addEventListener('submit', (e) => {
    if (e.target.id === 'notesForm') {
      e.preventDefault();
      saveNotes(e.target);
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'photoInput') addPhoto(e.target.files[0]);
  });
  // Signing in or out changes "mine": reload the page's data when it flips.
  let signedIn = session.state.signedIn;
  session.onChange((state) => {
    if (state.signedIn === signedIn) return;
    signedIn = state.signedIn;
    refresh();
  });
  $$('[data-sign-in]').forEach((b) => b.addEventListener('click', () => session.requireSignIn({})));
}
