// ── A shared shelf: /u/?<handle> ──────────────────────────────
// Readable by anyone only when publishing is open and the owner published it;
// the owner always sees it, with a notice when nobody else can. "Private" and
// "no such shelf" read the same to everyone else, on purpose.

import { FN } from '../backend.js';
import { connect } from '../session.js';
import { mugGrid } from '../render/cards.js';
import { ICONS } from '../render/icons.js';
import { getUnits } from '../prefs.js';
import { $, bareParam, escHtml, plural } from '../utils.js';
import { notConnected } from './common.js';

const TABS = [
  ['owned', 'Owned'],
  ['wanted', 'Wanted'],
  ['had', 'Once owned'],
];

export async function start() {
  const root = $('#profileRoot');
  const handle = bareParam(location.search);
  const missing = () => {
    root.innerHTML = `<div class="empty">${ICONS.mug()}<p>No shelf to show here. <a href="/community/">See the community</a>.</p></div>`;
    root.setAttribute('aria-busy', 'false');
  };
  if (!handle) return missing();
  const session = await connect();
  if (!session.state.connected) {
    root.innerHTML = notConnected();
    return;
  }
  let tab = 'owned';
  let data = null;
  const paint = () => {
    const units = getUnits();
    const list = data.shelf[tab] || [];
    root.innerHTML = `
      ${data.owner && !data.published ? '<div class="notice notice--warn">Only you can see this shelf. Publish it from <a href="/shelf/">your shelf</a> when you want others to.</div>' : ''}
      <header class="profile-head">
        <p class="eyebrow">Shelf</p>
        <h2>${escHtml(data.name)}</h2>
        <p class="muted">@${escHtml(data.handle)} · ${escHtml(plural(data.ownedCount, 'mug'))} owned${data.wantedCount ? `, ${data.wantedCount} wanted` : ''}</p>
        ${data.bio ? `<p style="max-width:62ch;line-height:1.6">${escHtml(data.bio)}</p>` : ''}
      </header>
      <div class="tabs" role="tablist" aria-label="Shelf">${TABS.map(([key, label]) => `<button type="button" role="tab" data-tab="${key}" aria-selected="${tab === key}">${label} <span class="muted">${(data.shelf[key] || []).length}</span></button>`).join('')}</div>
      <div class="mug-grid">${list.length ? mugGrid(list.map((i) => i.mug), { units }) : `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}<p>Nothing here yet.</p></div>`}</div>
      ${data.photos.length ? `<section class="stack stack--tight"><h3 class="section__title">Photos</h3><div class="photos">${data.photos.map((p) => `<figure class="photo"><img src="${escHtml(p.image.thumb)}" alt="${escHtml(p.caption || p.mug.name)}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${escHtml(p.mug.name)}${p.status && p.status !== 'visible' ? ` (${escHtml(p.status)})` : ''}</figcaption></figure>`).join('')}</div></section>` : ''}`;
    root.setAttribute('aria-busy', 'false');
  };
  const load = async () => {
    try {
      data = await session.query(FN.profiles.byHandle, { handle });
    } catch (err) {
      console.error(err);
      root.innerHTML = '<div class="notice notice--warn" role="alert">Could not load this shelf. Reload to try again.</div>';
      return;
    }
    if (!data) return missing();
    document.title = `${data.name}'s shelf | Mug`;
    paint();
  };
  root.addEventListener('click', (e) => {
    const button = e.target.closest('[data-tab]');
    if (!button || !data) return;
    tab = button.dataset.tab;
    paint();
  });
  let signedIn = session.state.signedIn;
  session.onChange((state) => {
    if (state.signedIn === signedIn) return;
    signedIn = state.signedIn;
    load();
  });
  await load();
}
