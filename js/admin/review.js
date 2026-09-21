// ── Review: the queue of staged listings ─────────────────────
// Tabs by staging status, 20 rows at a time. A pending listing is approved,
// merged or rejected where it stands; it then leaves the list and focus moves
// to the next one, so a keyboard can work down the queue without hunting.
// Markup lives in review-view.js; this file only talks to Convex and the DOM.

import { FN } from '../backend.js';
import { failure } from '../session.js';
import { mugHref } from '../render/cards.js';
import { $$, debounce, plural } from '../utils.js';
import { busy, failureText, loadFailed, outcome, sectionHead, skeletonRows, toElement } from './ui.js';
import { REVIEW_FIELDS, editsFrom, imagesEdit, readValues, valuesOf } from './mugform.js';
import { BULK_MAX, TABS, bulkCandidates, emptyHtml, itemHtml, mergeResults, offeredImages, panelLead, tabCount, tabsHtml } from './review-view.js';
import { sectionHash } from './routes.js';

const PAGE = 20;

/** Mounts the review queue into el. params: [status, stagingId to focus]. */
export function mount(el, ctx, params = []) {
  const view = {
    status: TABS.some((t) => t.status === params[0]) ? params[0] : 'pending',
    focusId: params[1] || '',
    items: new Map(),
    initial: new Map(),
    cursor: null,
    done: false,
    token: 0,
  };
  const searches = new WeakMap();
  let alive = true;

  el.innerHTML = `${sectionHead('Review', 'Listings from scans, imports and the runner wait here until you answer them.', '<button type="button" class="btn btn--primary btn--sm" data-act="bulk" hidden>Approve all new</button>')}
    <div class="tabs" role="tablist" aria-label="Queue status" data-tabs>${tabsHtml(view.status, ctx.counts)}</div>
    <div class="stack stack--tight" role="tabpanel" id="review-panel" aria-labelledby="tab-${view.status}">
      <p class="muted" data-lead>${panelLead(view.status)}</p>
      <div data-flash></div>
      <div class="admin-list" data-list aria-busy="true"></div>
      <div class="load-more"><button type="button" class="btn btn--secondary" data-act="more" hidden>Show more</button></div>
    </div>`;
  const tabs = el.querySelector('[data-tabs]');
  const panel = el.querySelector('#review-panel');
  const list = el.querySelector('[data-list]');
  const more = el.querySelector('[data-act="more"]');
  const bulk = el.querySelector('[data-act="bulk"]');
  const flash = el.querySelector('[data-flash]');

  const articles = () => $$('article[data-id]', list);
  const nameOf = (article) => view.items.get(article.dataset.id)?.listing?.name || article.querySelector('h3')?.textContent || 'the listing';
  const focusItem = (article) => article.querySelector('h3')?.focus();

  function paintBulk() {
    const all = bulkCandidates([...view.items.values()]);
    const n = all.ids.length + all.more;
    bulk.hidden = view.status !== 'pending' || n === 0;
    bulk.textContent = n > BULK_MAX ? `Approve ${BULK_MAX} new` : `Approve ${n} new`;
  }

  async function load(reset) {
    const token = reset ? ++view.token : view.token;
    if (reset) {
      view.items.clear();
      view.initial.clear();
      view.cursor = null;
      view.done = false;
      list.innerHTML = skeletonRows(3);
      list.setAttribute('aria-busy', 'true');
      more.hidden = true;
      paintBulk();
    }
    more.disabled = true;
    try {
      const result = await ctx.session.query(FN.staging.list, { status: view.status, paginationOpts: { numItems: PAGE, cursor: view.cursor } });
      if (!alive || token !== view.token) return;
      if (reset) list.innerHTML = '';
      for (const item of result.page) {
        view.items.set(item.id, item);
        if (item.status === 'pending' && item.listing) view.initial.set(item.id, valuesOf(item.listing));
      }
      list.insertAdjacentHTML('beforeend', result.page.map(itemHtml).join(''));
      view.cursor = result.continueCursor;
      view.done = result.isDone;
      if (!view.items.size) list.innerHTML = emptyHtml(view.status);
      if (reset && view.focusId) {
        const target = document.getElementById(`item-${view.focusId}`);
        view.focusId = '';
        if (target) {
          target.classList.add('admin-item--hit');
          focusItem(target);
        }
      }
    } catch (err) {
      console.error(err);
      if (!alive || token !== view.token) return;
      list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive && token === view.token) {
        list.setAttribute('aria-busy', 'false');
        more.hidden = view.done;
        more.disabled = false;
        paintBulk();
      }
    }
  }

  function selectTab(status) {
    if (status === view.status) return;
    view.status = status;
    for (const tab of $$('[role="tab"]', tabs)) {
      const on = tab.dataset.tab === status;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `tab-${status}`);
    el.querySelector('[data-lead]').innerHTML = panelLead(status);
    flash.innerHTML = '';
    history.replaceState(null, '', sectionHash('review', status));
    load(true);
  }

  function say(article, message) {
    const slot = article.querySelector('[data-msg]');
    if (slot) slot.textContent = message;
    ctx.announce(message);
  }

  function afterEmpty() {
    list.innerHTML = emptyHtml(view.status);
    tabs.querySelector('[aria-selected="true"]')?.focus();
  }

  /** The row is answered: note it, remove it, move focus to its neighbour. */
  async function closeItem(article, note) {
    const id = article.dataset.id;
    const siblings = articles();
    const at = siblings.indexOf(article);
    const next = siblings[at + 1] || siblings[at - 1] || null;
    article.remove();
    view.items.delete(id);
    view.initial.delete(id);
    flash.innerHTML = outcome({ tone: 'ok', ...note });
    ctx.announce(note.text);
    ctx.refreshCounts();
    paintBulk();
    if (next) {
      focusItem(next);
      return;
    }
    if (!view.done) {
      await load(false);
      const first = articles()[0];
      if (first) focusItem(first);
      else afterEmpty();
      return;
    }
    afterEmpty();
  }

  function editsOf(article) {
    const id = article.dataset.id;
    const item = view.items.get(id);
    const form = article.querySelector('form[data-form="review"]');
    if (!item || !form) return {};
    const edits = editsFrom(view.initial.get(id), readValues(form, REVIEW_FIELDS), REVIEW_FIELDS);
    const picked = $$('input[name="img"]', form).filter((box) => box.checked).map((box) => box.value);
    const images = imagesEdit(offeredImages(item.listing), picked);
    if (images) edits.images = images;
    return edits;
  }

  function valid(article) {
    const form = article.querySelector('form[data-form="review"]');
    if (form.checkValidity()) return true;
    const details = form.querySelector('details[data-edit]');
    if (details) details.open = true;
    form.reportValidity();
    return false;
  }

  async function approve(article, button) {
    if (!article || !valid(article)) return;
    const id = article.dataset.id;
    const edits = editsOf(article);
    const args = { id };
    if (Object.keys(edits).length) args.edits = edits;
    const name = nameOf(article);
    const result = await busy(button, () => ctx.session.mutation(FN.staging.approve, args), { group: article });
    if (!alive || !result) return;
    if (!result.ok) return say(article, failureText(result));
    const text = result.created === false ? `Updated the mug from ${name}.` : `Approved ${name} as a new mug.`;
    await closeItem(article, { text, href: result.slug ? mugHref(result.slug) : '', linkText: 'See its page' });
  }

  async function merge(article, button) {
    if (!article || !valid(article)) return;
    const edits = editsOf(article);
    const args = { id: article.dataset.id, mugId: button.dataset.mug };
    if (Object.keys(edits).length) args.edits = edits;
    const name = nameOf(article);
    const result = await busy(button, () => ctx.session.mutation(FN.staging.merge, args), { group: article });
    if (!alive || !result) return;
    if (!result.ok) return say(article, failureText(result));
    const text = `Merged ${name} into ${button.dataset.name || 'the mug you picked'}.`;
    await closeItem(article, { text, href: result.slug ? mugHref(result.slug) : '', linkText: 'See its page' });
  }

  async function reject(article, button) {
    const name = nameOf(article);
    const result = await busy(button, () => ctx.session.mutation(FN.staging.reject, { id: article.dataset.id }), { group: article });
    if (!alive || !result) return;
    if (!result.ok) return say(article, failureText(result));
    await closeItem(article, { text: `Rejected ${name}.` });
  }

  async function retry(article, button) {
    const id = article.dataset.id;
    const name = nameOf(article);
    const result = await busy(button, () => ctx.session.mutation(FN.staging.retry, { id }), { group: article });
    if (!alive || !result) return;
    if (!result.ok) return say(article, failureText(result));
    if (view.status !== 'needsLocal') {
      await closeItem(article, { text: `Sent ${name} to the runner queue.`, href: sectionHash('review', 'needsLocal', id), linkText: 'See it there' });
      return;
    }
    const item = view.items.get(id);
    if (item) Object.assign(item, { error: null, attempts: 0 });
    const fresh = toElement(itemHtml(item));
    article.replaceWith(fresh);
    focusItem(fresh);
    ctx.announce(`${name} is back in the runner queue with its attempts reset.`);
    ctx.refreshCounts();
  }

  function isEdited(id) {
    const article = document.getElementById(`item-${id}`);
    return article ? Object.keys(editsOf(article)).length > 0 : false;
  }

  async function bulkApprove(button) {
    const pick = bulkCandidates([...view.items.values()], isEdited);
    if (!pick.ids.length) {
      ctx.announce(pick.edited ? 'Every new listing on screen has your edits: approve those one by one.' : 'No listing on screen is both new and read as a mug.');
      return;
    }
    const n = pick.ids.length;
    const notes = [
      pick.edited ? `${plural(pick.edited, 'listing')} you edited will wait for you.` : '',
      pick.more ? `${pick.more} more will wait for the next batch.` : '',
    ].filter(Boolean).join(' ');
    const as = n === 1 ? 'as it is, publishing it as a new mug' : 'as they are, publishing each as a new mug';
    if (!window.confirm(`Approve ${plural(n, 'new listing')} ${as}? ${notes}`.trim())) return;
    const result = await busy(button, () => ctx.session.mutation(FN.staging.bulkApprove, { ids: pick.ids }));
    if (!alive || !result) return;
    if (!result.ok) {
      flash.innerHTML = outcome({ tone: 'bad', text: failureText(result) });
      ctx.announce(failureText(result));
      return;
    }
    const skipped = new Set(result.skipped || []);
    for (const id of pick.ids.filter((x) => !skipped.has(x))) {
      document.getElementById(`item-${id}`)?.remove();
      view.items.delete(id);
      view.initial.delete(id);
    }
    const text = `Approved ${plural(result.approved || 0, 'new mug')}.${skipped.size ? ` ${plural(skipped.size, 'listing')} changed meanwhile and still wait${skipped.size === 1 ? 's' : ''} for you.` : ''}`;
    flash.innerHTML = outcome({ tone: 'ok', text });
    ctx.announce(text);
    ctx.refreshCounts();
    paintBulk();
    if (!articles().length && !view.done) await load(false);
    const first = articles()[0];
    if (first) focusItem(first);
    else afterEmpty();
  }

  async function search(input) {
    const article = input.closest('article[data-id]');
    if (!article) return;
    const item = view.items.get(article.dataset.id);
    const results = article.querySelector('[data-merge-results]');
    const status = article.querySelector('[data-merge-status]');
    const q = input.value.trim();
    const seq = (searches.get(input) || 0) + 1;
    searches.set(input, seq);
    if (q.length < 2) {
      results.innerHTML = mergeResults([], item && item.match);
      status.textContent = 'Type at least two letters to search the catalogue.';
      return;
    }
    status.textContent = 'Searching...';
    let found = [];
    try {
      found = (await ctx.session.query(FN.mugs.pick, { q })) || [];
    } catch (err) {
      console.error(err);
      if (searches.get(input) === seq) status.textContent = failure(err).message;
      return;
    }
    if (!alive || searches.get(input) !== seq) return;
    results.innerHTML = mergeResults(found, item && item.match);
    status.textContent = found.length ? `${plural(found.length, 'mug')} found.` : 'No mug matches that. Try other words.';
  }
  const searchSoon = debounce(search, 280);

  function toggleMerge(article, button) {
    const box = article.querySelector('.admin-merge');
    const open = box.hidden;
    box.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const input = box.querySelector('[data-merge-q]');
    if (!input.value) input.value = nameOf(article);
    input.focus();
    input.select();
    search(input);
  }

  el.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tabs.contains(tab)) {
      selectTab(tab.dataset.tab);
      return;
    }
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    const article = button.closest('article[data-id]');
    const act = button.dataset.act;
    if (act === 'more') load(false);
    else if (act === 'reload') load(true);
    else if (act === 'bulk') bulkApprove(button);
    else if (act === 'merge' && article) toggleMerge(article, button);
    else if (act === 'merge-into' && article) merge(article, button);
    else if (act === 'reject' && article) reject(article, button);
    else if (act === 'retry' && article) retry(article, button);
  });
  el.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form="review"]');
    if (!form) return;
    event.preventDefault();
    approve(form.closest('article[data-id]'), event.submitter || form.querySelector('[data-act="approve"]'));
  });
  el.addEventListener('input', (event) => {
    if (event.target.matches('[data-merge-q]')) searchSoon(event.target);
  });
  tabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const all = $$('[role="tab"]', tabs);
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (at + step + all.length) % all.length;
    all.forEach((tab, i) => {
      tab.tabIndex = i === next ? 0 : -1;
    });
    all[next].focus();
  });

  const offCounts = ctx.onCounts((dash) => {
    for (const tab of TABS) {
      const span = tabs.querySelector(`[data-tab-count="${tab.status}"]`);
      if (!span) continue;
      const n = dash && tab.count ? Number(tab.count(dash)) || 0 : 0;
      span.hidden = !n;
      span.innerHTML = tabCount(n, dash && dash.cap);
    }
  });

  load(true);
  return () => {
    alive = false;
    view.token++;
    offCounts();
  };
}

