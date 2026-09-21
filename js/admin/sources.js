// ── Sources: the shop feeds a scan reads ─────────────────────
// List, add, edit, probe, scan and delete. Probe and Scan are hidden on
// manual sources on purpose: a manual source is a shop nothing here may
// fetch (Amazon among them, C11), so there is nothing to probe or scan.

import { FN } from '../backend.js';
import { failure } from '../session.js';
import { $$ } from '../utils.js';
import { busy, failureText, loadFailed, outcome, sectionHead, skeletonRows, toElement } from './ui.js';
import { probeText, scanOutcome, sourceArgs, sourceCard, sourceFormHtml } from './sources-view.js';

function formValues(form) {
  const get = (name) => form.elements.namedItem(name);
  const values = {};
  for (const name of ['sourceId', 'name', 'brand', 'adapter', 'baseUrl', 'entryUrls', 'include', 'exclude', 'fetchVia', 'currency', 'notes']) {
    values[name] = get(name).value;
  }
  values.watch = get('watch').checked;
  values.enabled = get('enabled').checked;
  return values;
}

function fillForm(form, s) {
  const set = (name, value) => {
    form.elements.namedItem(name).value = value;
  };
  set('sourceId', s ? s._id : '');
  set('name', s ? s.name : '');
  set('brand', (s && s.brand) || '');
  set('adapter', s ? s.adapter : 'shopify');
  set('baseUrl', s ? s.baseUrl : '');
  set('entryUrls', s ? s.entryUrls.join('\n') : '');
  set('include', s ? s.include.join(', ') : '');
  set('exclude', s ? s.exclude.join(', ') : '');
  set('fetchVia', s ? s.fetchVia : 'cloud');
  set('currency', (s && s.currency) || '');
  set('notes', (s && s.notes) || '');
  form.elements.namedItem('watch').checked = !!(s && s.watch);
  form.elements.namedItem('enabled').checked = s ? !!s.enabled : true;
  form.elements.namedItem('notes').dispatchEvent(new Event('input', { bubbles: true }));
}

/** Mounts the sources list and form into el. */
export function mount(el, ctx) {
  let alive = true;
  let sources = [];
  let opener = null;
  el.innerHTML = `${sectionHead('Sources', 'Shop feeds a scan reads. A manual source is a shop nothing fetches: its mugs are pasted or typed in.', '<button type="button" class="btn btn--primary btn--sm" data-act="new">New source</button>')}
    ${sourceFormHtml()}
    <div data-flash></div>
    <ul class="admin-list" data-list aria-busy="true">${skeletonRows(2)}</ul>`;
  const form = el.querySelector('form[data-form="source"]');
  const list = el.querySelector('[data-list]');
  const flash = el.querySelector('[data-flash]');
  const find = (id) => sources.find((s) => s._id === id);

  async function load() {
    list.setAttribute('aria-busy', 'true');
    try {
      const answer = await ctx.session.query(FN.sources.list, {});
      if (!alive) return;
      if (answer === null) {
        list.innerHTML = loadFailed('The server answered nothing: this account may no longer be a maintainer.');
        return;
      }
      sources = answer;
      list.innerHTML = sources.length
        ? sources.map(sourceCard).join('')
        : '<li class="empty"><p>No sources yet. Add a shop with New source.</p></li>';
    } catch (err) {
      console.error(err);
      if (alive) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive) list.setAttribute('aria-busy', 'false');
    }
  }

  function openForm(source, from) {
    opener = from || null;
    fillForm(form, source);
    form.querySelector('[data-form-title]').textContent = source ? `Edit ${source.name}` : 'New source';
    form.querySelector('[data-form-msg]').innerHTML = '';
    form.hidden = false;
    form.querySelector('[data-form-title]').focus();
  }

  function closeForm() {
    form.hidden = true;
    if (opener && opener.isConnected) opener.focus();
    else el.querySelector('[data-act="new"]').focus();
    opener = null;
  }

  async function save(button) {
    const args = sourceArgs(formValues(form));
    const result = await busy(button, () => ctx.session.mutation(FN.sources.save, args), { group: form });
    if (!alive || !result) return;
    if (!result.ok) {
      form.querySelector('[data-form-msg]').innerHTML = outcome({ tone: 'bad', text: failureText(result) });
      ctx.announce(failureText(result));
      return;
    }
    form.hidden = true;
    opener = null;
    const text = `Saved ${args.name}.`;
    flash.innerHTML = outcome({ tone: 'ok', text });
    ctx.announce(text);
    await load();
    document.getElementById(`src-${result.id}-t`)?.focus();
  }

  async function probe(li, button) {
    const source = find(li.dataset.id);
    if (!source) return;
    const result = await busy(button, () => ctx.session.action(FN.sources.probe, { id: source._id }), { group: li });
    if (!alive || !result) return;
    if (result.probe) source.lastProbe = result.probe;
    const note = result.ok ? { tone: 'ok', text: `Probed: ${probeText(result.probe)}.` } : { tone: 'bad', text: failureText(result) };
    const fresh = toElement(sourceCard(source));
    li.replaceWith(fresh);
    fresh.querySelector('[data-out]').innerHTML = outcome(note);
    fresh.querySelector('[data-act="probe"]')?.focus();
    ctx.announce(note.text);
  }

  async function scan(li, button) {
    const source = find(li.dataset.id);
    if (!source) return;
    const result = await busy(button, () => ctx.session.mutation(FN.runs.start, { sourceId: source._id }), { group: li });
    if (!alive || !result) return;
    const note = scanOutcome(result, source);
    li.querySelector('[data-out]').innerHTML = outcome(note);
    ctx.announce(note.text);
    if (result.ok) ctx.refreshCounts();
  }

  async function remove(li, button) {
    const source = find(li.dataset.id);
    if (!source) return;
    if (!window.confirm(`Delete the source "${source.name}"? Mugs already in the catalogue stay; only the feed is forgotten.`)) return;
    const result = await busy(button, () => ctx.session.mutation(FN.sources.remove, { id: source._id }), { group: li });
    if (!alive || !result) return;
    if (!result.ok) {
      li.querySelector('[data-out]').innerHTML = outcome({ tone: 'bad', text: failureText(result) });
      ctx.announce(failureText(result));
      return;
    }
    const rows = $$('li[data-id]', list);
    const at = rows.indexOf(li);
    const next = rows[at + 1] || rows[at - 1] || null;
    li.remove();
    sources = sources.filter((s) => s._id !== source._id);
    const text = `Deleted ${source.name}.`;
    flash.innerHTML = outcome({ tone: 'ok', text });
    ctx.announce(text);
    if (next) next.querySelector('h3')?.focus();
    else {
      list.innerHTML = '<li class="empty"><p>No sources yet. Add a shop with New source.</p></li>';
      el.querySelector('[data-act="new"]').focus();
    }
  }

  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    const li = button.closest('li[data-id]');
    const act = button.dataset.act;
    if (act === 'new') openForm(null, button);
    else if (act === 'cancel-form') closeForm();
    else if (act === 'reload') load();
    else if (act === 'edit' && li) openForm(find(li.dataset.id), button);
    else if (act === 'probe' && li) probe(li, button);
    else if (act === 'scan' && li) scan(li, button);
    else if (act === 'delete' && li) remove(li, button);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save(event.submitter || form.querySelector('[type="submit"]'));
  });

  load();
  return () => {
    alive = false;
  };
}
