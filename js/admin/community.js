// ── Community: photos to moderate, shelves to suspend ────────
// A collector's photo stays pending until it is approved here, and only
// then appears on a published shelf (docs/CONTRACTS.md C9). A shelf can be
// suspended by its address; a suspended shelf is not listed or shown.

import { FN } from '../backend.js';
import { failure } from '../session.js';
import { mugHref } from '../render/cards.js';
import { $$, escHtml } from '../utils.js';
import { busy, failureText, httpUrl, loadFailed, outcome, sectionHead, skeletonRows, when } from './ui.js';

/** One pending photo: the picture, its mug and owner, and Approve and Reject. */
export function photoCard(p) {
  const id = escHtml(p.id);
  const src = p.image ? httpUrl(p.image.thumb) || httpUrl(p.image.src) : '';
  const full = p.image ? httpUrl(p.image.src) : '';
  const mugName = p.mug ? p.mug.name : 'a mug no longer in the catalogue';
  const picture = src
    ? `<img src="${escHtml(src)}" alt="${escHtml(`A collector's photo of ${mugName}`)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '<div class="admin-photo__missing">The image cannot be shown.</div>';
  const mug = p.mug ? `<a href="${escHtml(mugHref(p.mug.slug))}" target="_blank" rel="noopener">${escHtml(p.mug.name)}<span class="visually-hidden"> (new tab)</span></a>` : escHtml(mugName);
  const owner = p.owner && p.owner.handle
    ? `<a href="/u/?${escHtml(encodeURIComponent(p.owner.handle))}" target="_blank" rel="noopener">@${escHtml(p.owner.handle)}<span class="visually-hidden"> (new tab)</span></a>`
    : escHtml((p.owner && p.owner.name) || 'a collector without a shelf address');
  const shelf = p.owner ? (p.owner.published ? 'shared shelf' : 'private shelf') : 'no shelf';
  return `<li class="admin-photo" data-id="${id}">
    <figure>
      ${picture}
      ${p.caption ? `<figcaption>${escHtml(p.caption)}</figcaption>` : ''}
    </figure>
    <p class="hint">${mug}, by ${owner} (${escHtml(shelf)}), ${when(p.createdAt)}${full ? ` &middot; <a href="${escHtml(full)}" target="_blank" rel="noopener noreferrer">full size<span class="visually-hidden"> (new tab)</span></a>` : ''}</p>
    <div class="toolbar">
      <button type="button" class="btn btn--primary btn--sm" data-act="approve">Approve<span class="visually-hidden"> the photo of ${escHtml(mugName)}</span></button>
      <button type="button" class="btn btn--danger btn--sm" data-act="reject">Reject<span class="visually-hidden"> the photo of ${escHtml(mugName)}</span></button>
    </div>
    <p class="error-text" data-msg></p>
  </li>`;
}

/** Mounts the moderation queue and the suspend form into el. */
export function mount(el, ctx) {
  let alive = true;
  el.innerHTML = `${sectionHead('Community', 'Photos wait here until you approve them. A shelf that breaks the rules can be suspended by its address.', '<button type="button" class="btn btn--secondary btn--sm" data-act="reload">Refresh</button>')}
    <section class="stack stack--tight" aria-labelledby="com-photos-t">
      <h3 id="com-photos-t" tabindex="-1">Photos to review</h3>
      <div data-flash></div>
      <ul class="admin-photos" data-list aria-busy="true">${skeletonRows(2)}</ul>
    </section>
    <section class="panel stack stack--tight" aria-labelledby="com-suspend-t">
      <h3 id="com-suspend-t">Suspend a shelf</h3>
      <form class="stack stack--tight" data-form="suspend">
        <div class="field">
          <label for="com-handle">Shelf address</label>
          <input class="input" id="com-handle" name="handle" type="text" required autocomplete="off" spellcheck="false" placeholder="collector-name" aria-describedby="com-handle-hint">
          <p class="hint" id="com-handle-hint">The part after /u/? in the shelf's address. A leading @ is fine.</p>
        </div>
        <fieldset>
          <legend class="visually-hidden">What to do</legend>
          <label class="admin-radio"><input type="radio" name="suspended" value="true" checked> Suspend</label>
          <label class="admin-radio"><input type="radio" name="suspended" value="false"> Lift a suspension</label>
        </fieldset>
        <div class="toolbar"><button type="submit" class="btn btn--primary">Apply</button></div>
      </form>
      <div data-out></div>
    </section>`;
  const list = el.querySelector('[data-list]');
  const flash = el.querySelector('[data-flash]');

  async function load() {
    list.setAttribute('aria-busy', 'true');
    try {
      const photos = await ctx.session.query(FN.moderation.pendingPhotos, {});
      if (!alive) return;
      if (photos === null) list.innerHTML = loadFailed('The server answered nothing: this account may no longer be a maintainer.');
      else list.innerHTML = photos.length ? photos.map(photoCard).join('') : '<li class="empty"><p>No photo waits for review.</p></li>';
    } catch (err) {
      console.error(err);
      if (alive) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive) list.setAttribute('aria-busy', 'false');
    }
  }

  async function review(li, button, verdict) {
    const result = await busy(button, () => ctx.session.mutation(FN.moderation.reviewPhoto, { photoId: li.dataset.id, verdict }), { group: li });
    if (!alive || !result) return;
    if (!result.ok) {
      li.querySelector('[data-msg]').textContent = failureText(result);
      ctx.announce(failureText(result));
      return;
    }
    const rows = $$('li[data-id]', list);
    const at = rows.indexOf(li);
    const next = rows[at + 1] || rows[at - 1] || null;
    li.remove();
    const text = verdict === 'approve' ? 'Photo approved. It shows on the collector\'s shelf once the shelf is shared.' : 'Photo rejected and deleted.';
    flash.innerHTML = outcome({ tone: 'ok', text });
    ctx.announce(text);
    ctx.refreshCounts();
    if (next) next.querySelector('[data-act="approve"]')?.focus();
    else {
      list.innerHTML = '<li class="empty"><p>No photo waits for review.</p></li>';
      el.querySelector('#com-photos-t').focus();
    }
  }

  async function suspend(form, button) {
    const handle = form.elements.namedItem('handle').value.trim();
    const suspended = form.elements.namedItem('suspended').value === 'true';
    const result = await busy(button, () => ctx.session.mutation(FN.moderation.suspend, { handle, suspended }), { group: form });
    if (!alive || !result) return;
    const note = result.ok
      ? { tone: 'ok', text: suspended ? `The shelf ${handle} is suspended.` : `The shelf ${handle} is no longer suspended.` }
      : { tone: 'bad', text: failureText(result) };
    el.querySelector('[data-out]').innerHTML = outcome(note);
    ctx.announce(note.text);
    if (result.ok) form.reset();
  }

  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    const li = button.closest('li[data-id]');
    const act = button.dataset.act;
    if (act === 'reload') load();
    else if ((act === 'approve' || act === 'reject') && li) review(li, button, act);
  });
  el.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form="suspend"]');
    if (!form) return;
    event.preventDefault();
    if (form.reportValidity()) suspend(form, event.submitter || form.querySelector('[type="submit"]'));
  });

  load();
  return () => {
    alive = false;
  };
}
