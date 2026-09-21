// ── Sources: markup ──────────────────────────────────────────
// Pure functions from sources:list rows to HTML, the form, and the form's
// values to sources:save's arguments. js/admin/sources.js wires them up.

import { escHtml } from '../utils.js';
import { badge, commaList, copyBlock, extLink, hostOf, lines, when } from './ui.js';

/** The four adapters (docs/CONTRACTS.md C2). */
export const ADAPTERS = Object.freeze([
  { value: 'shopify', label: 'Shopify: products.json' },
  { value: 'woocommerce', label: 'WooCommerce: Store API' },
  { value: 'jsonld', label: 'Product pages: JSON-LD' },
  { value: 'manual', label: 'Manual: paste or type' },
]);

const RUN_WORDS = { discovering: 'discovering', extracting: 'reading pages', ready: 'done', failed: 'failed', cancelled: 'cancelled' };

/** The runner command in a use-runner message, else one made from the slug. */
export function runnerCommand(message, slug) {
  const found = /node runner\/mug-runner\.mjs scan \S+/.exec(String(message || ''));
  if (found) return found[0];
  return slug ? `node runner/mug-runner.mjs scan ${slug}` : 'node runner/mug-runner.mjs drain';
}

/** A probe in words: "robots.txt allowed, shopify, HTTP 200". */
export function probeText(probe) {
  if (!probe) return 'not probed yet';
  return [`robots.txt ${probe.robots || 'unknown'}`, probe.platform || '', probe.status ? `HTTP ${probe.status}` : ''].filter(Boolean).join(', ');
}

/** The last scan in words, as markup. */
export function lastRunHtml(run) {
  if (!run) return 'never scanned';
  const counts = `${run.staged || 0} staged, ${run.unchanged || 0} unchanged, ${run.needsLocal || 0} for the runner, ${run.failed || 0} failed`;
  const error = run.error ? `<br><span class="error-text">${escHtml(run.error)}</span>` : '';
  return `${escHtml(RUN_WORDS[run.status] || run.status)}: ${escHtml(counts)}${run.at ? `, ${when(run.at)}` : ''}${error}`;
}

/** What runs:start's answer means, with the runner command to copy when the cloud may not fetch. */
export function scanOutcome(result, source) {
  if (result && result.ok) return { tone: 'ok', text: 'Scan started.', href: '#runs', linkText: 'Follow it in Runs' };
  const code = result && result.code;
  const message = (result && result.message) || 'The scan did not start.';
  if (code === 'use-runner') {
    const command = runnerCommand(message, source && source.slug);
    const words = message.replace(command, '').trim() || 'This shop refuses cloud fetching. On your workstation run:';
    return { tone: 'warn', text: words, extra: copyBlock(command) };
  }
  if (code === 'proxy-not-configured') {
    return { tone: 'warn', text: `${message} On your workstation:`, extra: copyBlock(runnerCommand('', source && source.slug)) };
  }
  return { tone: 'bad', text: message };
}

function listLinks(urls) {
  return `<ul class="admin-links">${urls.map((url) => `<li>${extLink(url, url)}</li>`).join('')}</ul>`;
}

/** One source as a card: facts, last probe and scan, and its actions. Manual sources say so first. */
export function sourceCard(s) {
  const id = escHtml(s._id);
  const manual = s.adapter === 'manual';
  const adapter = ADAPTERS.find((a) => a.value === s.adapter);
  const badges = [
    badge(adapter ? adapter.label : s.adapter, manual ? 'warn' : 'info'),
    manual ? '' : badge(s.fetchVia === 'local' ? 'Runner only' : 'Cloud', s.fetchVia === 'local' ? 'warn' : 'info'),
    s.watch ? badge('Re-scanned weekly', 'ok') : '',
    badge(s.enabled ? 'Enabled' : 'Disabled', s.enabled ? 'ok' : 'bad'),
  ].filter(Boolean).join(' ');
  const facts = [];
  if (s.entryUrls && s.entryUrls.length) facts.push(`<dt>Entry pages</dt><dd>${listLinks(s.entryUrls)}</dd>`);
  if (s.include && s.include.length) facts.push(`<dt>Include</dt><dd>${escHtml(s.include.join(', '))}</dd>`);
  if (s.exclude && s.exclude.length) facts.push(`<dt>Exclude</dt><dd>${escHtml(s.exclude.join(', '))}</dd>`);
  if (!manual) {
    const probe = s.lastProbe;
    facts.push(`<dt>Last probe</dt><dd>${escHtml(probeText(probe))}${probe && probe.at ? `, ${when(probe.at)}` : ''}${probe && probe.note ? `<br><span class="hint">${escHtml(probe.note)}</span>` : ''}</dd>`);
    facts.push(`<dt>Last scan</dt><dd>${lastRunHtml(s.lastRun)}</dd>`);
  }
  const notes = manual
    ? `<div class="notice"><p><strong>Manual: paste or type.</strong> ${escHtml(s.notes || 'Nothing here is fetched; its mugs enter through Import.')}</p></div>`
    : s.notes
      ? `<p class="admin-notes">${escHtml(s.notes)}</p>`
      : '';
  const named = `<span class="visually-hidden"> ${escHtml(s.name)}</span>`;
  const actions = [
    `<button type="button" class="btn btn--secondary btn--sm" data-act="edit">Edit${named}</button>`,
    manual ? '' : `<button type="button" class="btn btn--secondary btn--sm" data-act="probe">Probe${named}</button>`,
    manual ? '' : `<button type="button" class="btn btn--primary btn--sm" data-act="scan">Scan now${named}</button>`,
    `<button type="button" class="btn btn--ghost btn--sm" data-act="delete">Delete${named}</button>`,
  ].filter(Boolean).join('');
  return `<li class="admin-card" data-id="${id}">
    <div class="admin-card__head">
      <h3 id="src-${id}-t" tabindex="-1">${escHtml(s.name)}</h3>
      <p class="admin-item__badges">${badges}</p>
    </div>
    <p class="muted">${s.brand ? `Brand ${escHtml(s.brand)}` : 'No brand set'} &middot; ${extLink(s.baseUrl, hostOf(s.baseUrl) || s.baseUrl)} &middot; <code>${escHtml(s.slug)}</code></p>
    ${notes}
    ${facts.length ? `<dl class="fact-table admin-facts">${facts.join('')}</dl>` : ''}
    <div class="toolbar">${actions}</div>
    <div data-out></div>
  </li>`;
}

/** The add and edit form, hidden until New source or Edit opens it. */
export function sourceFormHtml() {
  const adapters = ADAPTERS.map((a) => `<option value="${a.value}">${escHtml(a.label)}</option>`).join('');
  return `<form class="panel stack stack--tight" data-form="source" aria-labelledby="src-form-t" hidden>
    <h3 id="src-form-t" tabindex="-1" data-form-title>New source</h3>
    <input type="hidden" name="sourceId" value="">
    <div class="admin-grid">
      <div class="field"><label for="src-name">Name</label><input class="input" id="src-name" name="name" type="text" maxlength="80" required autocomplete="off" placeholder="ABYstyle (EU shop)"></div>
      <div class="field"><label for="src-brand">Brand</label><input class="input" id="src-brand" name="brand" type="text" maxlength="80" autocomplete="off" aria-describedby="src-brand-hint"><p class="hint" id="src-brand-hint">The maker. Every listing from this source takes it as its brand.</p></div>
      <div class="field"><label for="src-adapter">Adapter</label><select class="select" id="src-adapter" name="adapter">${adapters}</select></div>
      <div class="field"><label for="src-via">Fetched by</label><select class="select" id="src-via" name="fetchVia" aria-describedby="src-via-hint"><option value="cloud">The cloud (the Worker)</option><option value="local">The runner only</option></select><p class="hint" id="src-via-hint">Pick the runner for a shop that refuses datacenter addresses.</p></div>
      <div class="field field--wide"><label for="src-base">Shop address</label><input class="input" id="src-base" name="baseUrl" type="url" inputmode="url" required autocomplete="off" placeholder="https://shop.example"></div>
      <div class="field field--wide"><label for="src-entries">Entry pages, one per line</label><textarea class="textarea" id="src-entries" name="entryUrls" rows="3" aria-describedby="src-entries-hint"></textarea><p class="hint" id="src-entries-hint">Collection, search or sitemap pages, up to 10. With none, a scan starts from the shop address.</p></div>
      <div class="field"><label for="src-include">Include words, comma separated</label><input class="input" id="src-include" name="include" type="text" autocomplete="off" aria-describedby="src-include-hint"><p class="hint" id="src-include-hint">Empty lets the mug check decide.</p></div>
      <div class="field"><label for="src-exclude">Exclude words, comma separated</label><input class="input" id="src-exclude" name="exclude" type="text" autocomplete="off" placeholder="coaster, keychain"></div>
      <div class="field field--wide"><label for="src-notes">Notes</label><textarea class="textarea" id="src-notes" name="notes" rows="2" maxlength="500" data-counter="src-notes-count" aria-describedby="src-notes-hint"></textarea><p class="hint" id="src-notes-hint">For a manual source, say why it cannot be scanned.</p><p class="hint" id="src-notes-count">0 / 500</p></div>
    </div>
    <div class="toolbar">
      <label class="switch"><input type="checkbox" name="watch"> Re-scan weekly</label>
      <label class="switch"><input type="checkbox" name="enabled" checked> Enabled</label>
    </div>
    <div class="toolbar">
      <button type="submit" class="btn btn--primary">Save source</button>
      <button type="button" class="btn btn--secondary" data-act="cancel-form">Cancel</button>
    </div>
    <div data-form-msg></div>
  </form>`;
}

/** sources:save's arguments from the form's values (checkboxes as booleans). */
export function sourceArgs(values) {
  const args = {
    name: String(values.name || '').trim(),
    brand: String(values.brand || '').trim(),
    adapter: values.adapter,
    baseUrl: String(values.baseUrl || '').trim(),
    entryUrls: lines(values.entryUrls),
    include: commaList(values.include),
    exclude: commaList(values.exclude),
    fetchVia: values.fetchVia === 'local' ? 'local' : 'cloud',
    watch: !!values.watch,
    enabled: !!values.enabled,
    notes: String(values.notes || '').trim(),
  };
  if (values.sourceId) args.id = values.sourceId;
  return args;
}
