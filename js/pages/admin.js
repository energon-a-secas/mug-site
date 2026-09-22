// ── Admin: the gate and the section router ───────────────────
// The console is for the catalogue's maintainers (ADMIN_SUBJECTS, CONTRACTS
// C9). The gate decides which of four things the page shows: not connected,
// sign in, not a maintainer, or the console. Once the console is up, the
// router mounts one section from location.hash at a time and calls the last
// one's cleanup first, which is how the Runs poller stops when it is left.
// The sections themselves live in js/admin/, loaded only for maintainers.

import { FN } from '../backend.js';
import { connect } from '../session.js';
import { ICONS } from '../render/icons.js';
import { $, $$, escHtml } from '../utils.js';
import { notConnected, signInPrompt } from './common.js';
import { createContext } from '../admin/context.js';
import { parseHash } from '../admin/routes.js';
import { wireCommon } from '../admin/ui.js';

const SECTIONS = {
  overview: () => import('../admin/dashboard.js'),
  review: () => import('../admin/review.js'),
  import: () => import('../admin/import.js'),
  sources: () => import('../admin/sources.js'),
  runs: () => import('../admin/runs.js'),
  catalog: () => import('../admin/catalog.js'),
  images: () => import('../admin/images.js'),
  community: () => import('../admin/community.js'),
  suggestions: () => import('../admin/suggestions.js'),
  runner: () => import('../admin/runner.js'),
};

// The account id is the caller's own (it is inside their sign-in token
// already), shown so the first maintainer can be added without a dashboard.
function notMaintainer(subject) {
  const id = subject ? `<p class="hint">Your account id is <code>${escHtml(subject)}</code>.</p>` : '';
  return `<div class="empty">${ICONS.mug()}
    <p><strong>This page is for the catalogue's maintainers.</strong></p>
    <p class="hint">You are signed in, but this account is not one of them. Maintainers are the accounts listed in the deployment's <code>ADMIN_SUBJECTS</code> setting.</p>
    ${id}
    <a class="btn btn--secondary" href="/">Back to the catalog</a>
  </div>`;
}

function unreachable(retry) {
  return `<div class="notice notice--warn admin-outcome" role="alert">
    <p>Could not check your account with the catalogue.${retry ? '' : ' Reload the page to try again.'}</p>
    ${retry ? '<div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-retry>Try again</button></div>' : ''}
  </div>`;
}

/** Mounts the section location.hash names and returns { stop }. */
function openConsole(session) {
  const rail = $('#adminRail');
  const main = $('#adminMain');
  const ctx = createContext(session, rail);
  let current = null;
  let token = 0;

  const show = async (focus) => {
    const route = parseHash(location.hash) || (current ? null : { section: 'overview', params: [] });
    if (!route) return; // an in-page anchor such as the skip link's #main: stay put
    const mine = ++token;
    current?.leave?.();
    current = null;
    for (const link of $$('a[data-section]', rail)) {
      if (link.dataset.section === route.section) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const active = rail.querySelector('[aria-current="page"]');
    if (active && rail.scrollWidth > rail.clientWidth) {
      const box = rail.getBoundingClientRect();
      const at = active.getBoundingClientRect();
      rail.scrollLeft += at.left - box.left - (box.width - at.width) / 2;
    }
    const el = document.createElement('div');
    el.className = 'admin-section stack';
    main.replaceChildren(el);
    try {
      const section = await SECTIONS[route.section]();
      if (mine !== token) return;
      const leave = await section.mount(el, ctx, route.params);
      if (mine !== token) {
        if (typeof leave === 'function') leave();
        return;
      }
      current = { leave: typeof leave === 'function' ? leave : null };
      if (focus) el.querySelector('h2')?.focus();
    } catch (err) {
      console.error(err);
      if (mine === token) el.innerHTML = '<div class="notice notice--warn" role="alert">This section could not load. Reload the page to try again.</div>';
    }
  };

  const onHash = () => show(true);
  window.addEventListener('hashchange', onHash);
  ctx.refreshCounts();
  show(false);
  return {
    stop() {
      token++;
      current?.leave?.();
      current = null;
      window.removeEventListener('hashchange', onHash);
      main.replaceChildren();
    },
  };
}

/** Called by js/app.js on /admin/. */
export async function start() {
  const gate = $('#adminGate');
  const shell = $('#adminShell');
  wireCommon($('#main'));
  let app = null;

  const showGate = (html) => {
    app?.stop();
    app = null;
    shell.hidden = true;
    gate.hidden = false;
    gate.setAttribute('aria-busy', 'false');
    gate.innerHTML = `<h2 class="section__title">Catalogue admin</h2>${html}`;
  };
  const showConsole = (session) => {
    if (app) return;
    gate.hidden = true;
    shell.hidden = false;
    app = openConsole(session);
  };

  let session;
  try {
    session = await connect();
  } catch (err) {
    console.error(err);
    showGate(unreachable(false));
    return;
  }
  if (!session.state.connected) {
    showGate(notConnected());
    return;
  }

  let seq = 0;
  const check = async () => {
    const mine = ++seq;
    if (!session.state.signedIn) {
      showGate(signInPrompt('Sign in to manage the catalogue.'));
      return;
    }
    let who = null;
    try {
      who = await session.query(FN.admin.whoami, {});
    } catch (err) {
      console.error(err);
      if (mine === seq) showGate(unreachable(true));
      return;
    }
    if (mine !== seq) return;
    if (who && who.isAdmin) showConsole(session);
    else showGate(notMaintainer(who && who.subject));
  };

  gate.addEventListener('click', async (event) => {
    const signIn = event.target.closest('[data-sign-in]');
    if (signIn) {
      signIn.disabled = true;
      try {
        await session.requireSignIn({ reason: 'Sign in with a catalogue maintainer account.' });
      } finally {
        if (signIn.isConnected) signIn.disabled = false;
      }
      check();
      return;
    }
    if (event.target.closest('[data-retry]')) check();
  });
  session.onChange(() => {
    check();
  });
}
