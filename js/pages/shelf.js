// ── Your shelf: /shelf/ ───────────────────────────────────────
// The signed-in collector's own mugs, the address their shelf is shared at,
// and whether it is shared. Everything here needs an account; signed out, the
// page offers the Auth Kit's sign-in and redraws itself once it succeeds.

import { FN } from '../backend.js';
import { connect } from '../session.js';
import { mugGrid } from '../render/cards.js';
import { ICONS } from '../render/icons.js';
import { getUnits } from '../prefs.js';
import { HANDLE_MESSAGES, handleProblem, normalizeHandle } from '../handles.js';
import { $, escHtml, formatCapacity, plural, showToast } from '../utils.js';
import { notConnected, signInPrompt } from './common.js';

const TABS = [
  ['owned', 'Owned'],
  ['wanted', 'Wanted'],
  ['had', 'Once owned'],
];

const view = { tab: 'owned', data: null, session: null };

function statsRow(s, units) {
  const litres = s.totalMl ? formatCapacity(s.totalMl, units) : '0 ml';
  return `<div class="stat-row">
    <div class="stat"><b>${s.owned}</b><span>owned</span></div>
    <div class="stat"><b>${s.wanted}</b><span>wanted</span></div>
    <div class="stat"><b>${escHtml(litres)}</b><span>of mug, all told</span></div>
    <div class="stat"><b>${s.brands}</b><span>${s.brands === 1 ? 'maker' : 'makers'}</span></div>
  </div>`;
}

function profilePanel(d) {
  const p = d.profile || { handle: null, displayName: null, bio: null, published: false, suspended: false };
  const canPublish = d.publishingOpen && !!p.handle && !p.suspended;
  const why = p.suspended
    ? 'This shelf is suspended and cannot be shared.'
    : !d.publishingOpen
      ? 'Shared shelves are not open yet. Pick your address now; sharing opens later.'
      : !p.handle
        ? 'Pick an address first.'
        : p.published
          ? 'Anyone with the link can see your shelf, and it is listed on the community page.'
          : 'Only you can see your shelf.';
  return `<section class="panel stack" aria-labelledby="profile-title">
    <h3 class="section__title" id="profile-title">Your shelf's page</h3>
    <form id="handleForm" class="stack stack--tight">
      <div class="field"><label for="handleInput">Address</label>
        <div class="toolbar" style="flex-wrap:nowrap"><span class="muted mono" aria-hidden="true">/u/?</span><input class="input" name="handle" id="handleInput" maxlength="31" autocomplete="off" value="${escHtml(p.handle || '')}" aria-describedby="handleHint"><button class="btn btn--secondary btn--sm" type="submit">Save</button></div>
      </div>
      <p class="hint" id="handleHint" aria-live="polite">${escHtml(HANDLE_MESSAGES['handle-invalid'])}</p>
    </form>
    <form id="profileForm" class="stack stack--tight">
      <label class="field"><span>Display name</span><input class="input" name="displayName" maxlength="40" value="${escHtml(p.displayName || '')}"></label>
      <label class="field"><span>About your shelf</span><textarea class="textarea" name="bio" maxlength="280">${escHtml(p.bio || '')}</textarea></label>
      <div class="toolbar"><button class="btn btn--secondary btn--sm" type="submit">Save profile</button></div>
    </form>
    <div class="stack stack--tight">
      <label class="switch"><input type="checkbox" id="publishSwitch" ${p.published ? 'checked' : ''} ${canPublish || p.published ? '' : 'disabled'}> Share my shelf</label>
      <p class="hint">${escHtml(why)}${p.handle ? ` <a href="/u/?${encodeURIComponent(p.handle)}">See it as others will</a>.` : ''}</p>
    </div>
    <details>
      <summary style="cursor:pointer" class="hint">Your data</summary>
      <div class="toolbar" style="margin-top:var(--space-3)">
        <button type="button" class="btn btn--ghost btn--sm" id="exportBtn">Download my shelf (JSON)</button>
        <button type="button" class="btn btn--danger btn--sm" id="deleteBtn">Delete my shelf and profile</button>
      </div>
    </details>
  </section>`;
}

function render() {
  const d = view.data;
  const units = getUnits();
  const items = d.items.filter((i) => i.state === view.tab);
  $('#shelfRoot').innerHTML = `
    <header class="profile-head">
      <p class="eyebrow">My shelf</p>
      <h2>${escHtml(d.profile?.displayName || view.session.state.label || 'Your mugs')}</h2>
    </header>
    ${statsRow(d.stats, units)}
    <section class="stack stack--tight">
      <div class="tabs" role="tablist" aria-label="Shelf">${TABS.map(([key, label]) => `<button type="button" role="tab" data-tab="${key}" aria-selected="${view.tab === key}">${label} <span class="muted">${d.stats[key]}</span></button>`).join('')}</div>
      <div class="mug-grid">${items.length
        ? items.map((i) => mugGrid([i.mug], { units, badge: i.hidden ? 'Hidden' : '', note: i.note || '' })).join('')
        : `<div class="empty" style="grid-column:1/-1">${ICONS.mug()}<p>${view.tab === 'owned' ? 'Nothing here yet. Open any mug and press Own it.' : view.tab === 'wanted' ? 'Your want list is empty.' : 'Mugs you sold or broke go here.'}</p><a class="btn btn--secondary btn--sm" href="/">Browse the catalogue</a></div>`}</div>
    </section>
    ${profilePanel(d)}`;
  $('#shelfRoot').setAttribute('aria-busy', 'false');
}

async function load() {
  const session = view.session;
  if (!session.state.signedIn) {
    $('#shelfRoot').innerHTML = signInPrompt('Sign in to keep a shelf of your mugs.');
    $('#shelfRoot').setAttribute('aria-busy', 'false');
    return;
  }
  try {
    view.data = await session.query(FN.shelf.mine, {});
  } catch (err) {
    console.error(err);
    $('#shelfRoot').innerHTML = '<div class="notice notice--warn" role="alert">Could not load your shelf. Reload to try again.</div>';
    return;
  }
  if (!view.data) {
    $('#shelfRoot').innerHTML = signInPrompt('Sign in to keep a shelf of your mugs.');
    return;
  }
  render();
}

function exportShelf() {
  const d = view.data;
  const file = {
    exportedAt: new Date().toISOString(),
    from: 'https://mug.neorgon.com/shelf/',
    profile: d.profile,
    items: d.items.map((i) => ({
      state: i.state, mug: i.mug.name, slug: i.mug.slug, maker: i.mug.brand?.name ?? null,
      note: i.note, condition: i.condition, pricePaid: i.pricePaid, currency: i.currency, acquiredOn: i.acquiredOn,
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'my-mug-shelf.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function start() {
  const session = await connect();
  view.session = session;
  const root = $('#shelfRoot');
  if (!session.state.connected) {
    root.innerHTML = notConnected();
    return;
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-sign-in]')) {
      if (await session.requireSignIn({ reason: 'Sign in to keep a shelf of your mugs.' })) load();
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      view.tab = tab.dataset.tab;
      render();
      return;
    }
    if (e.target.closest('#exportBtn')) return exportShelf();
    if (e.target.closest('#deleteBtn')) {
      if (!window.confirm('Delete your whole shelf, your photos and your address? This cannot be undone.')) return;
      const result = await session.mutation(FN.profiles.deleteMyData, {});
      showToast(result.ok ? `Deleted ${plural(result.removed || 0, 'mug')} from your shelf.` : result.message, result.ok ? 'info' : 'error');
      if (result.ok) load();
    }
  });

  root.addEventListener('input', (e) => {
    if (e.target.id !== 'handleInput') return;
    const handle = normalizeHandle(e.target.value);
    const problem = handle ? handleProblem(handle) : null;
    $('#handleHint').textContent = problem ? HANDLE_MESSAGES[problem] : handle ? `Your shelf will be at mug.neorgon.com/u/?${handle}` : HANDLE_MESSAGES['handle-invalid'];
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      if (form.id === 'handleForm') {
        const handle = normalizeHandle(form.handle.value);
        const problem = handleProblem(handle);
        if (problem) return showToast(HANDLE_MESSAGES[problem], 'error');
        const result = await session.mutation(FN.profiles.claimHandle, { handle });
        showToast(result.ok ? 'Address saved.' : result.message, result.ok ? 'info' : 'error');
      } else if (form.id === 'profileForm') {
        const result = await session.mutation(FN.profiles.update, { displayName: form.displayName.value, bio: form.bio.value });
        showToast(result.ok ? 'Profile saved.' : result.message, result.ok ? 'info' : 'error');
      }
      await load();
    } finally {
      if (button) button.disabled = false;
    }
  });

  root.addEventListener('change', async (e) => {
    if (e.target.id !== 'publishSwitch') return;
    const result = await session.mutation(FN.profiles.setPublished, { published: e.target.checked });
    showToast(result.ok ? (e.target.checked ? 'Your shelf is shared.' : 'Your shelf is private again.') : result.message, result.ok ? 'info' : 'error');
    await load();
  });

  let signedIn = session.state.signedIn;
  session.onChange((state) => {
    if (state.signedIn === signedIn) return;
    signedIn = state.signedIn;
    load();
  });
  await load();
}
