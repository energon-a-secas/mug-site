// ── Runs: scans and imports, newest first ────────────────────
// Every scan, URL import, paste and typed-in mug is a run. While a run on
// screen is still discovering or reading pages, the list refreshes every 4
// seconds, patching only the rows that changed so focus and reading place
// survive. It stops when nothing is active, when the tab is hidden, and when
// the section is left (the cleanup mount returns).

import { FN } from '../backend.js';
import { failure } from '../session.js';
import { $$, escHtml } from '../utils.js';
import { badge, busy, extLink, failureText, loadFailed, sectionHead, shortUrl, skeletonRows, toElement, when } from './ui.js';

/** How often the list refreshes while a run is active. */
export const POLL_MS = 4000;

const PAGE = 20;

export const KIND_LABELS = Object.freeze({ scan: 'Scan', url: 'URL import', paste: 'Paste', manual: 'Typed in', runner: 'Runner scan' });

const STATUS = {
  discovering: ['Discovering', 'info'],
  extracting: ['Reading pages', 'info'],
  ready: ['Done', 'ok'],
  failed: ['Failed', 'bad'],
  cancelled: ['Cancelled', 'muted'],
};

const TRIGGERS = { manual: 'started by hand', cron: 'weekly re-scan', runner: 'from the runner' };

const COUNTERS = [
  ['discovered', 'Discovered'],
  ['staged', 'Staged'],
  ['unchanged', 'Unchanged'],
  ['skipped', 'Skipped'],
  ['needsLocal', 'Needs runner'],
  ['failed', 'Failed'],
];

/** A run that is still working: discovering or extracting. */
export function isActive(run) {
  return !!run && (run.status === 'discovering' || run.status === 'extracting');
}

/** One run as a card: status, counters, error, and Cancel while it is active. */
export function runCard(run) {
  const id = escHtml(run._id);
  const title = run.source ? run.source.name : KIND_LABELS[run.kind] || run.kind;
  const [statusLabel, tone] = STATUS[run.status] || [run.status, 'muted'];
  const target = /^https?:\/\//i.test(run.target || '') ? extLink(run.target, shortUrl(run.target)) : escHtml(run.target || '');
  const meta = [escHtml(KIND_LABELS[run.kind] || run.kind), escHtml(TRIGGERS[run.trigger] || run.trigger), `started ${when(run.createdAt)}`, `updated ${when(run.updatedAt)}`]
    .join(' &middot; ');
  const counters = COUNTERS.map(([key, label]) => `<div><dt>${escHtml(label)}</dt><dd>${escHtml(String(run[key] || 0))}</dd></div>`).join('');
  const where = isActive(run) && run.kind === 'scan'
    ? `<p class="hint">Entry page ${escHtml(String(Number(run.entryIndex) + 1))}, listing page ${escHtml(String(run.page))}.</p>`
    : '';
  return `<li class="admin-card" data-id="${id}" data-updated="${escHtml(String(run.updatedAt))}" data-status="${escHtml(run.status)}">
    <div class="admin-card__head">
      <h3 tabindex="-1">${escHtml(title)}</h3>
      <p class="admin-item__badges">${badge(statusLabel, tone)}</p>
    </div>
    <p class="muted">${meta}</p>
    ${target ? `<p class="admin-target">${target}</p>` : ''}
    ${where}
    <dl class="admin-counters">${counters}</dl>
    ${run.error ? `<p class="error-text">${escHtml(run.error)}</p>` : ''}
    ${isActive(run) ? `<div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-act="cancel">Cancel<span class="visually-hidden"> ${escHtml(title)}</span></button></div>` : ''}
  </li>`;
}

/** Mounts the runs list into el and starts polling when a run is active. */
export function mount(el, ctx) {
  let alive = true;
  let runs = [];
  let cursor = null;
  let done = false;
  let timer = null;
  let polling = false;
  el.innerHTML = `${sectionHead('Runs', 'Every scan and import, newest first, with what each one found.')}
    <p class="hint" data-poll hidden>A scan is running: this list refreshes every 4 seconds.</p>
    <ul class="admin-list" data-list aria-busy="true">${skeletonRows(3)}</ul>
    <div class="load-more"><button type="button" class="btn btn--secondary" data-act="more" hidden>Show more</button></div>`;
  const list = el.querySelector('[data-list]');
  const more = el.querySelector('[data-act="more"]');
  const pollNote = el.querySelector('[data-poll]');

  const schedule = () => {
    const needed = alive && runs.some(isActive);
    if (needed && !timer) timer = setInterval(tick, POLL_MS);
    if (!needed && timer) {
      clearInterval(timer);
      timer = null;
    }
    pollNote.hidden = !timer;
  };

  // Replace only the rows whose run changed; keep focus on the same control.
  const patch = () => {
    const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused ? focused.closest('li[data-id]')?.dataset.id : null;
    const focusAct = focused ? focused.dataset.act : null;
    const rows = new Map($$('li[data-id]', list).map((li) => [li.dataset.id, li]));
    let previous = null;
    for (const run of runs) {
      let li = rows.get(run._id);
      if (!li || li.dataset.updated !== String(run.updatedAt) || li.dataset.status !== run.status) {
        const fresh = toElement(runCard(run));
        if (li) li.replaceWith(fresh);
        li = fresh;
      }
      rows.delete(run._id);
      const slot = previous ? previous.nextElementSibling : list.firstElementChild;
      if (slot !== li) list.insertBefore(li, slot);
      previous = li;
    }
    for (const stale of rows.values()) stale.remove();
    list.querySelector(':scope > .empty, :scope > .skeleton, :scope > .notice')?.remove();
    if (!runs.length) list.innerHTML = '<li class="empty"><p>No runs yet. Start a scan from Sources, or import a mug.</p></li>';
    if (focusId && !list.contains(document.activeElement)) {
      const row = list.querySelector(`li[data-id="${CSS.escape(focusId)}"]`);
      (row && ((focusAct && row.querySelector(`[data-act="${focusAct}"]`)) || row.querySelector('h3')))?.focus();
    }
  };

  async function load(reset) {
    if (reset) {
      cursor = null;
      runs = [];
    }
    more.disabled = true;
    try {
      const result = await ctx.session.query(FN.runs.list, { paginationOpts: { numItems: PAGE, cursor } });
      if (!alive) return;
      runs = reset ? result.page : runs.concat(result.page);
      cursor = result.continueCursor;
      done = result.isDone;
      if (reset) list.innerHTML = '';
      patch();
    } catch (err) {
      console.error(err);
      if (alive && reset) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive) {
        list.setAttribute('aria-busy', 'false');
        more.hidden = done;
        more.disabled = false;
        schedule();
      }
    }
  }

  async function tick() {
    if (!alive || polling || document.hidden) return;
    polling = true;
    const wasActive = new Set(runs.filter(isActive).map((r) => r._id));
    try {
      const result = await ctx.session.query(FN.runs.list, { paginationOpts: { numItems: Math.max(PAGE, runs.length), cursor: null } });
      if (!alive) return;
      runs = result.page;
      cursor = result.continueCursor;
      done = result.isDone;
      patch();
      more.hidden = done;
      const finished = runs.filter((r) => wasActive.has(r._id) && !isActive(r));
      if (finished.length) {
        ctx.announce(finished.length === 1 ? `${finished[0].source ? finished[0].source.name : 'A run'} finished.` : `${finished.length} runs finished.`);
        ctx.refreshCounts();
      }
    } catch (err) {
      console.error(err);
    } finally {
      polling = false;
      schedule();
    }
  }

  async function cancel(li, button) {
    const result = await busy(button, () => ctx.session.mutation(FN.runs.cancel, { runId: li.dataset.id }), { group: li });
    if (!alive || !result) return;
    if (!result.ok) {
      ctx.announce(failureText(result));
      li.insertAdjacentHTML('beforeend', `<p class="error-text">${escHtml(failureText(result))}</p>`);
      return;
    }
    ctx.announce('Scan cancelled.');
    await tick();
    ctx.refreshCounts();
  }

  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    const act = button.dataset.act;
    if (act === 'more') load(false);
    else if (act === 'reload') load(true);
    else if (act === 'cancel') cancel(button.closest('li[data-id]'), button);
  });

  load(true);
  return () => {
    alive = false;
    if (timer) clearInterval(timer);
    timer = null;
  };
}
