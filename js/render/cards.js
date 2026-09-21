// ── The mug card, as every list draws it ─────────────────────
// One function, so the catalogue, a brand page, a shelf and the community page
// cannot drift apart. The whole card is one link (its ::after covers the card),
// so there is never an interactive element nested inside another.

import { STYLE_LABELS } from '../../shared/contract.js';
import { escHtml, formatCapacity } from '../utils.js';
import { ICONS } from './icons.js';

export function tile(image, alt, { eager = false, size = 'thumb' } = {}) {
  if (!image) {
    return `<div class="porcelain porcelain--empty" aria-hidden="true">${ICONS.mug()}</div>`;
  }
  const src = size === 'full' ? image.src : image.thumb || image.src;
  const dims = image.w && image.h && size === 'full' ? ` width="${image.w}" height="${image.h}"` : '';
  return `<div class="porcelain"><img src="${escHtml(src)}" alt="${escHtml(alt)}"${dims} loading="${eager ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer"></div>`;
}

export function mugHref(slug) {
  return `/mug/?${encodeURIComponent(slug)}`;
}

export function brandHref(slug) {
  return `/brand/?${encodeURIComponent(slug)}`;
}

/** card: the Card shape from convex/lib/cards.ts. extra: { badge, note } for shelves. */
export function mugCard(card, { units = 'ml', eager = false, badge = '', note = '' } = {}) {
  const meta = [card.brand ? card.brand.name : '', formatCapacity(card.capacityMl, units)].filter(Boolean);
  const counts = [];
  if (card.ownedCount) counts.push(`<span class="count count--own" title="${card.ownedCount} own it">${ICONS.own()}${card.ownedCount}</span>`);
  if (card.wantedCount) counts.push(`<span class="count count--want" title="${card.wantedCount} want it">${ICONS.want()}${card.wantedCount}</span>`);
  return `<article class="mug-card">
    ${tile(card.image, card.name, { eager })}
    <div class="mug-card__body">
      <h3 class="mug-card__name"><a class="mug-card__link" href="${mugHref(card.slug)}">${escHtml(card.name)}</a></h3>
      <p class="mug-card__meta">${meta.map(escHtml).join('<span aria-hidden="true"> · </span>')}</p>
      <div class="mug-card__foot">
        <span class="style-chip style-chip--${escHtml(card.style)}">${escHtml(STYLE_LABELS[card.style] || card.style)}</span>
        ${counts.join('')}
      </div>
      ${note ? `<p class="mug-card__note">${escHtml(note)}</p>` : ''}
    </div>
    ${badge ? `<span class="mug-card__badge">${escHtml(badge)}</span>` : ''}
  </article>`;
}

export function mugGrid(cards, options = {}) {
  return cards.map((card, i) => mugCard(card, { ...options, eager: i < 8 })).join('');
}

/** A row of small tiles, for collector cards. */
export function tileStrip(cards) {
  return `<div class="tile-strip">${cards
    .map((card) => `<a class="tile-strip__item" href="${mugHref(card.slug)}" title="${escHtml(card.name)}">${tile(card.image, card.name)}</a>`)
    .join('')}</div>`;
}
