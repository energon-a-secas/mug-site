// ── Suggestions: collectors' corrections to a mug's labels ───
// Oldest first. Approving applies the proposal through the same path an
// admin's own edit takes (docs/CONTRACTS.md A17), after dropping any field the
// mug already says; rejecting keeps the mug as it is and records why.

import { STYLE_LABELS } from '../../shared/contract.js';
import { FN } from '../backend.js';
import { failure } from '../session.js';
import { mugHref } from '../render/cards.js';
import { FIELD_LABELS } from '../pages/suggest.js';
import { $$, escHtml } from '../utils.js';
import { busy, failureText, loadFailed, outcome, sectionHead, skeletonRows, when } from './ui.js';

const FLAG_WORDS = {
  hasLid: ['Has a lid', 'No lid'],
  dishwasherSafe: ['Safe', 'Hand wash only'],
  microwaveSafe: ['Safe', 'Not safe'],
};

/** One label value as the admin reads it; every string is escaped. */
export function labelValue(field, value) {
  if (value === null || value === undefined || value === '') return '<span class="muted">not set</span>';
  if (field === 'style') return escHtml(STYLE_LABELS[value] || value);
  if (typeof value === 'boolean' && FLAG_WORDS[field]) return escHtml(FLAG_WORDS[field][value ? 0 : 1]);
  if (field === 'capacityMl') return `${escHtml(String(value))} ml`;
  return escHtml(String(value));
}

/** One proposal: the mug, who sent it and when, each label now and suggested, the note, and the two decisions. */
export function suggestionCard(s) {
  const id = escHtml(s.id);
  const mugName = s.mug ? s.mug.name : 'a mug no longer in the catalogue';
  const mug = s.mug
    ? `<a href="${escHtml(mugHref(s.mug.slug))}" target="_blank" rel="noopener">${escHtml(s.mug.name)}<span class="visually-hidden"> (new tab)</span></a>${s.mug.hidden ? ' <span class="muted">(hidden)</span>' : ''}`
    : escHtml(mugName);
  const by = s.by && s.by.handle ? `@${escHtml(s.by.handle)}` : escHtml((s.by && s.by.name) || 'a collector');
  const rows = s.changes
    .map((c) => `<tr><th scope="row">${escHtml(FIELD_LABELS[c.field] || c.field)}</th><td>${labelValue(c.field, c.from)}</td><td>${labelValue(c.field, c.to)}</td></tr>`)
    .join('');
  return `<li class="panel stack stack--tight" data-id="${id}">
    <p><strong>${mug}</strong><br><span class="hint">From ${by}, ${when(s.updatedAt)}</span></p>
    <table class="admin-diff">
      <thead><tr><th scope="col">Label</th><th scope="col">Now</th><th scope="col">Suggested</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${s.note ? `<blockquote class="admin-note">${escHtml(s.note)}</blockquote>` : ''}
    <div class="toolbar">
      <button type="button" class="btn btn--primary btn--sm" data-act="approve">Approve<span class="visually-hidden"> the suggestion for ${escHtml(mugName)}</span></button>
      <button type="button" class="btn btn--danger btn--sm" data-act="reject">Reject<span class="visually-hidden"> the suggestion for ${escHtml(mugName)}</span></button>
      <label class="visually-hidden" for="why-${id}">Reason for rejecting (optional)</label>
      <input class="input" id="why-${id}" data-reason maxlength="200" placeholder="Reason, for the record (optional)" style="width:auto;flex:1;min-width:180px;min-height:36px">
    </div>
    <p class="error-text" data-msg></p>
  </li>`;
}

const EMPTY = '<li class="empty"><p>No suggestion waits for review.</p></li>';

/** Mounts the queue into el. */
export function mount(el, ctx) {
  let alive = true;
  el.innerHTML = `${sectionHead('Suggestions', 'Collectors propose corrections to a mug\'s labels. Nothing changes until you approve; approving applies exactly what is shown as Suggested.', '<button type="button" class="btn btn--secondary btn--sm" data-act="reload">Refresh</button>')}
    <div data-flash></div>
    <ul class="stack stack--tight admin-suggestions" data-list aria-busy="true">${skeletonRows(2)}</ul>`;
  const list = el.querySelector('[data-list]');
  const flash = el.querySelector('[data-flash]');

  async function load() {
    list.setAttribute('aria-busy', 'true');
    try {
      const rows = await ctx.session.query(FN.suggestions.pending, {});
      if (!alive) return;
      if (rows === null) list.innerHTML = loadFailed('The server answered nothing: this account may no longer be a maintainer.');
      else list.innerHTML = rows.length ? rows.map(suggestionCard).join('') : EMPTY;
    } catch (err) {
      console.error(err);
      if (alive) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive) list.setAttribute('aria-busy', 'false');
    }
  }

  async function decide(li, button, approve) {
    const reason = approve ? '' : li.querySelector('[data-reason]').value.trim();
    const args = { id: li.dataset.id, approve, ...(reason ? { reason } : {}) };
    const result = await busy(button, () => ctx.session.mutation(FN.suggestions.decide, args), { group: li });
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
    const text = approve
      ? result.applied && result.applied.length
        ? `Approved: ${result.applied.map((f) => FIELD_LABELS[f] || f).join(', ')} changed on the mug.`
        : 'Approved. The mug already said all of that, so nothing changed.'
      : 'Rejected. The mug is unchanged.';
    flash.innerHTML = outcome({ tone: 'ok', text, ...(approve && result.slug ? { href: mugHref(result.slug), linkText: 'See the mug' } : {}) });
    ctx.announce(text);
    ctx.refreshCounts();
    if (next) next.querySelector('[data-act="approve"]')?.focus();
    else list.innerHTML = EMPTY;
  }

  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    const li = button.closest('li[data-id]');
    if (button.dataset.act === 'reload') load();
    else if (li && (button.dataset.act === 'approve' || button.dataset.act === 'reject')) decide(li, button, button.dataset.act === 'approve');
  });

  load();
  return () => {
    alive = false;
  };
}
