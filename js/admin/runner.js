// ── Runner: tokens and setup for the local runner ────────────
// The runner fetches, from your own connection, the pages and images shops
// refuse to the cloud; robots.txt still binds it (docs/CONTRACTS.md C8, C10).
// A token is shown once, when it is made, and only its hash is kept, so the
// plaintext lives in this section's memory until the section is left.

import { FN } from '../backend.js';
import { failure } from '../session.js';
import { escHtml, plural } from '../utils.js';
import { badge, busy, copyBlock, failureText, loadFailed, outcome, sectionHead, skeletonRows, when } from './ui.js';

/**
 * The runner's MUG_CONVEX_SITE for the page's deployment URL: a cloud
 * https://x.convex.cloud answers HTTP actions at https://x.convex.site, and
 * a local backend on port N answers them on N + 1. null when unknown.
 */
export function siteUrlFor(url) {
  const cloud = /^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/.exec(String(url || ''));
  if (cloud) return `https://${cloud[1]}.convex.site`;
  const local = /^(http:\/\/(?:127\.0\.0\.1|localhost)):(\d{2,5})\/?$/.exec(String(url || ''));
  if (local) return `${local[1]}:${Number(local[2]) + 1}`;
  return null;
}

/** The runner/.env file's two lines. */
export function envText(site, token) {
  return `MUG_CONVEX_SITE=${site || '<the deployment site URL>'}\nMUG_RUNNER_TOKEN=${token || '<the token>'}`;
}

/** What waits for the runner, from the dashboard, in a sentence. */
export function waitingText(dash) {
  if (!dash) return '';
  const pages = Number(dash.queue && dash.queue.needsLocal) || 0;
  const mugs = Number(dash.images && dash.images.blocked) || 0;
  if (!pages && !mugs) return 'Nothing waits for the runner right now.';
  const parts = [pages ? plural(pages, 'page') : '', mugs ? `the images of ${plural(mugs, 'mug')}` : ''].filter(Boolean);
  const sentence = `${parts.join(' and ')} ${pages === 1 && !mugs ? 'waits' : 'wait'} for the runner.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** One token row: label, prefix, when it was made and last used, and Revoke while it is live. */
export function tokenRow(t) {
  const id = escHtml(t.id);
  const state = t.revokedAt ? badge('Revoked', 'muted') : badge('Live', 'ok');
  const used = t.lastUsedAt ? `last used ${when(t.lastUsedAt)}` : 'never used';
  return `<li class="admin-row" data-id="${id}">
    <div class="admin-row__main">
      <p class="admin-row__title"><strong>${escHtml(t.label)}</strong> <code>${escHtml(t.prefix)}...</code> ${state}</p>
      <p class="hint">made ${when(t.createdAt)} &middot; ${used}${t.revokedAt ? ` &middot; revoked ${when(t.revokedAt)}` : ''}</p>
    </div>
    ${t.revokedAt ? '' : `<div class="toolbar"><button type="button" class="btn btn--ghost btn--sm" data-act="revoke">Revoke<span class="visually-hidden"> ${escHtml(t.label)}</span></button></div>`}
  </li>`;
}

function setupHtml(site, token, localSources) {
  const scans = localSources.length
    ? `<p>Sources that only the runner reads:</p>${localSources.map((s) => copyBlock(`node runner/mug-runner.mjs scan ${s.slug}`)).join('')}`
    : `${copyBlock('node runner/mug-runner.mjs scan <source-slug>')}<p class="hint">No source is set to the runner only yet; any source's slug works here.</p>`;
  return `<p>Put these two lines in <code>runner/.env</code> in the repository (it is gitignored):</p>
    ${copyBlock(envText(site, token), 'the two lines')}
    ${site ? '' : '<p class="hint">This page is not connected to a known deployment, so fill in its site URL by hand.</p>'}
    <p>Then, on your workstation, work through every page and image waiting for the runner:</p>
    ${copyBlock('node runner/mug-runner.mjs drain')}
    <p>Or scan one source from your connection:</p>
    ${scans}`;
}

/** Mounts the token list, the create form and the setup steps into el. */
export function mount(el, ctx) {
  let alive = true;
  let fresh = '';
  let localSources = [];
  const site = siteUrlFor(ctx.session.state.url);
  el.innerHTML = `${sectionHead('Runner', 'The runner reads, from your own connection, what shops refuse to the cloud. robots.txt still binds it.')}
    <p class="notice" data-waiting>${escHtml(waitingText(ctx.counts)) || 'Counting what waits for the runner...'}</p>
    <section class="panel stack stack--tight" aria-labelledby="run-tokens-t">
      <h3 id="run-tokens-t">Tokens</h3>
      <form class="admin-inline" data-form="create">
        <div class="field">
          <label for="run-label">Label</label>
          <input class="input" id="run-label" name="label" type="text" maxlength="60" autocomplete="off" placeholder="My laptop">
        </div>
        <button type="submit" class="btn btn--primary">Create a token</button>
      </form>
      <div data-token tabindex="-1"></div>
      <ul class="admin-rows" data-list aria-busy="true">${skeletonRows(1)}</ul>
    </section>
    <section class="panel stack stack--tight" aria-labelledby="run-setup-t">
      <h3 id="run-setup-t">Set it up</h3>
      <div class="stack stack--tight" data-setup>${setupHtml(site, '', [])}</div>
    </section>`;
  const list = el.querySelector('[data-list]');
  const tokenBox = el.querySelector('[data-token]');
  const setup = el.querySelector('[data-setup]');
  const paintSetup = () => {
    setup.innerHTML = setupHtml(site, fresh, localSources);
  };

  async function load() {
    list.setAttribute('aria-busy', 'true');
    try {
      const tokens = await ctx.session.query(FN.runnerTokens.list, {});
      if (!alive) return;
      if (tokens === null) list.innerHTML = loadFailed('The server answered nothing: this account may no longer be a maintainer.');
      else list.innerHTML = tokens.length ? tokens.map(tokenRow).join('') : '<li class="empty"><p>No token yet. Create one for each machine that runs the runner.</p></li>';
    } catch (err) {
      console.error(err);
      if (alive) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive) list.setAttribute('aria-busy', 'false');
    }
  }

  async function create(form, button) {
    const label = form.elements.namedItem('label').value.trim();
    const result = await busy(button, () => ctx.session.action(FN.runnerTokens.create, { label }), { group: form });
    if (!alive || !result) return;
    if (!result.ok) {
      tokenBox.innerHTML = outcome({ tone: 'bad', text: failureText(result) });
      ctx.announce(failureText(result));
      return;
    }
    fresh = result.token;
    tokenBox.innerHTML = `<div class="notice notice--warn admin-outcome">
      <p><strong>Copy this token now: it is shown once.</strong> Only its hash is kept, so it cannot be shown again; if it is lost, revoke it and make another.</p>
      ${copyBlock(fresh, 'the token')}
    </div>`;
    paintSetup();
    form.reset();
    tokenBox.focus();
    ctx.announce('Token created. It is shown once: copy it now.');
    load();
  }

  async function revoke(li, button) {
    const label = li.querySelector('strong')?.textContent || 'this token';
    if (!window.confirm(`Revoke "${label}"? A runner using it stops working at once.`)) return;
    const result = await busy(button, () => ctx.session.mutation(FN.runnerTokens.revoke, { id: li.dataset.id }), { group: li });
    if (!alive || !result) return;
    const text = result.ok ? `Revoked ${label}.` : failureText(result);
    ctx.announce(text);
    if (result.ok) {
      await load();
      el.querySelector('#run-tokens-t')?.focus();
    }
  }

  el.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form="create"]');
    if (!form) return;
    event.preventDefault();
    create(form, event.submitter || form.querySelector('[type="submit"]'));
  });
  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    if (button.dataset.act === 'reload') load();
    else if (button.dataset.act === 'revoke') revoke(button.closest('li[data-id]'), button);
  });

  ctx.refreshCounts().then((dash) => {
    const box = alive && el.querySelector('[data-waiting]');
    if (box) box.textContent = waitingText(dash) || 'Could not count what waits for the runner.';
  });
  ctx.session.query(FN.sources.list, {}).then((sources) => {
    if (!alive || !Array.isArray(sources)) return;
    localSources = sources.filter((s) => s.fetchVia === 'local' && s.adapter !== 'manual' && s.enabled);
    paintSetup();
  }).catch((err) => console.error(err));
  load();
  return () => {
    alive = false;
    fresh = '';
  };
}
