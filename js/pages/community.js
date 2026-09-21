// ── The community page ───────────────────────────────────────
// Anonymous totals always; anything naming a collector only when publishing
// is open and they chose to share (docs/CONTRACTS.md C9).

import { FN } from '../backend.js';
import { connect } from '../session.js';
import { mugCard, tile, tileStrip, mugHref } from '../render/cards.js';
import { ICONS } from '../render/icons.js';
import { getUnits } from '../prefs.js';
import { $, escHtml, plural, timeAgo } from '../utils.js';
import { notConnected } from './common.js';

function row(title, id, cards, units) {
  if (!cards.length) return '';
  return `<section class="stack stack--tight" aria-labelledby="${id}">
    <h3 class="section__title" id="${id}">${title}</h3>
    <div class="row-scroll">${cards.map((c) => mugCard(c, { units })).join('')}</div>
  </section>`;
}

function collectors(list) {
  if (!list.length) return '';
  return `<section class="stack stack--tight" aria-labelledby="collectors-title">
    <h3 class="section__title" id="collectors-title">Shared shelves</h3>
    <div class="collector-grid">${list
      .map((c) => `<article class="collector">
        <h3><a href="/u/?${encodeURIComponent(c.handle)}">${escHtml(c.name)}</a></h3>
        <p class="hint">@${escHtml(c.handle)} · ${escHtml(plural(c.ownedCount, 'mug'))} owned${c.wantedCount ? `, ${c.wantedCount} wanted` : ''}</p>
        ${c.shelf.length ? tileStrip(c.shelf) : ''}
        ${c.bio ? `<p class="hint">${escHtml(c.bio)}</p>` : ''}
      </article>`)
      .join('')}</div>
  </section>`;
}

function feed(items) {
  if (!items.length) return '';
  return `<section class="stack stack--tight" aria-labelledby="recent-title">
    <h3 class="section__title" id="recent-title">Just shelved</h3>
    <ul class="feed" role="list">${items
      .map((i) => `<li>
        <a href="${mugHref(i.mug.slug)}" aria-hidden="true" tabindex="-1">${tile(i.mug.image, '')}</a>
        <p><a href="/u/?${encodeURIComponent(i.handle)}">${escHtml(i.name)}</a> ${i.state === 'owned' ? 'added' : 'wants'} <a href="${mugHref(i.mug.slug)}">${escHtml(i.mug.name)}</a></p>
        <time datetime="${new Date(i.at).toISOString()}">${escHtml(timeAgo(i.at))}</time>
      </li>`)
      .join('')}</ul>
  </section>`;
}

function photos(list) {
  if (!list.length) return '';
  return `<section class="stack stack--tight" aria-labelledby="photos-title">
    <h3 class="section__title" id="photos-title">From collectors' shelves</h3>
    <div class="photos">${list
      .map((p) => `<figure class="photo"><a href="${mugHref(p.mug.slug)}"><img src="${escHtml(p.image.thumb)}" alt="${escHtml(p.caption || p.mug.name)}" loading="lazy" referrerpolicy="no-referrer"></a><figcaption><a href="/u/?${encodeURIComponent(p.handle)}">${escHtml(p.name)}</a>, ${escHtml(p.mug.name)}</figcaption></figure>`)
      .join('')}</div>
  </section>`;
}

export async function start() {
  const root = $('#communityRoot');
  const session = await connect();
  if (!session.state.connected) {
    root.innerHTML = notConnected();
    return;
  }
  let data;
  try {
    data = await session.query(FN.community.overview, {});
  } catch (err) {
    console.error(err);
    root.innerHTML = '<div class="notice notice--warn" role="alert">Could not load the community page. Reload to try again.</div>';
    return;
  }
  const t = data.totals;
  $('#totals').innerHTML = [
    [t.mugs, 'mugs catalogued'],
    [t.owned, 'on shelves'],
    [t.wanted, 'on want lists'],
    [t.collectors, 'shared shelves'],
  ].map(([n, label]) => `<div class="stat"><b>${Number(n).toLocaleString('en')}</b><span>${label}</span></div>`).join('');

  const units = getUnits();
  const sections = [
    data.publishing
      ? ''
      : `<div class="notice">${ICONS.share()}<div><strong>Shared shelves open soon.</strong> Until then this page shows only anonymous counts. You can already <a href="/shelf/">keep your own shelf</a> and pick its address.</div></div>`,
    collectors(data.collectors),
    feed(data.recent),
    row('Most collected', 'owned-title', data.mostOwned, units),
    row('Most wanted', 'wanted-title', data.mostWanted, units),
    photos(data.photos),
    row('New in the catalogue', 'new-title', data.newest, units),
  ].filter(Boolean);
  root.innerHTML = sections.length ? sections.join('') : `<div class="empty">${ICONS.mug()}<p>Nothing here yet.</p></div>`;
  root.setAttribute('aria-busy', 'false');
}
