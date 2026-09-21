// ── Admin console: shared pieces ─────────────────────────────
// Markup helpers every section's renderer uses, pure so node can test the
// renderers (tests/admin-render.test.mjs), and the few DOM helpers every
// section needs: announce a result, hold a button while its request runs,
// copy a command, count a blurb's characters.
//
// Everything here that takes record data escapes it (escHtml) or passes a
// link through httpUrl first. Arguments documented as "trusted markup" are
// for static strings written in this folder, never for data.

import { STYLE_LABELS } from '../../shared/contract.js';
import { escHtml, formatPrice, safeHref, timeAgo } from '../utils.js';

/** A count as the dashboard caps it: at or over the cap it reads "500+". */
export function countText(n, cap = 0) {
  const value = Number(n) || 0;
  return cap && value >= cap ? `${cap}+` : value.toLocaleString('en');
}

/** A small pill. tone is ok, warn, bad, info or muted. */
export function badge(text, tone = 'muted') {
  return `<span class="admin-badge admin-badge--${escHtml(tone)}">${escHtml(text)}</span>`;
}

/** A relative time with the exact one on hover, or '' when there is no time. */
export function when(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  return `<time datetime="${escHtml(date.toISOString())}" title="${escHtml(date.toLocaleString('en'))}">${escHtml(timeAgo(ms, now))}</time>`;
}

/** An absolute http(s) URL from data, or '' for anything else (javascript:, data:, relative, junk). */
export function httpUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return '';
  const href = safeHref(url.trim());
  return href === '#' ? '' : href;
}

/** The host of a URL without "www.", for link text. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A URL shortened for reading: host and path, no query. */
export function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 48 ? `${parsed.pathname.slice(0, 45)}...` : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, '')}${path === '/' ? '' : path}`;
  } catch {
    return String(url || '');
  }
}

/** A link out of the site built from data: http(s) only, a new tab, no referrer. Plain text otherwise. */
export function extLink(url, text) {
  const href = httpUrl(url);
  const label = text || hostOf(url) || String(url || '');
  if (!href) return escHtml(label);
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escHtml(label)}<span class="visually-hidden"> (new tab)</span></a>`;
}

/** A section's heading row. lead and tools are trusted markup. */
export function sectionHead(title, lead = '', tools = '') {
  return `<header class="section__header">
    <div class="section__titles">
      <h2 class="section__title" tabindex="-1">${escHtml(title)}</h2>
      ${lead ? `<p class="section__lead">${lead}</p>` : ''}
    </div>
    ${tools ? `<div class="toolbar">${tools}</div>` : ''}
  </header>`;
}

function safeLink(href) {
  if (!href) return '';
  if (href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))) return href;
  return httpUrl(href);
}

/**
 * A result note: { tone, text, href, linkText, extra }. text is escaped;
 * href is an internal link ('#...' or '/...') or an http(s) URL; extra is
 * trusted markup (a copy block, a button).
 */
export function outcome({ tone = 'info', text = '', href = '', linkText = '', extra = '' } = {}) {
  const warn = tone === 'bad' || tone === 'warn';
  const link = safeLink(href);
  return `<div class="notice${warn ? ' notice--warn' : ''} admin-outcome admin-outcome--${escHtml(tone)}">
    <p>${escHtml(text)}${link ? ` <a href="${escHtml(link)}">${escHtml(linkText || 'Open it')}</a>` : ''}</p>${extra}
  </div>`;
}

/** The sentence a failed { ok: false, message } result carries, or a fallback. */
export function failureText(result, fallback = 'That did not work. Try again.') {
  return result && typeof result.message === 'string' && result.message ? result.message : fallback;
}

/** A notice for a list that could not load, with a retry button. */
export function loadFailed(message) {
  return `<div class="notice notice--warn admin-outcome" role="alert">
    <p>${escHtml(message || 'Could not load this. Check your connection.')}</p>
    <div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-act="reload">Try again</button></div>
  </div>`;
}

/** Grey placeholder rows while a list loads. */
export function skeletonRows(n = 3) {
  return Array.from({ length: n }, () => '<div class="skeleton admin-skeleton" aria-hidden="true"></div>').join('');
}

/** yes or no for a stated flag, '' when the listing does not say. */
export function triText(value) {
  return value === true ? 'yes' : value === false ? 'no' : '';
}

/** The isMug verdict as a pill: yes, maybe or no. */
export function verdictBadge(isMug) {
  const verdict = isMug && isMug.verdict;
  const tone = verdict === 'yes' ? 'ok' : verdict === 'maybe' ? 'warn' : verdict === 'no' ? 'bad' : 'muted';
  return badge(`Mug: ${verdict || 'unknown'}`, tone);
}

/** A listing's facts as a definition list. Rows the listing does not state are left out. */
export function factsList(listing) {
  const l = listing || {};
  const rows = [
    ['Brand', l.brand],
    ['Franchise', l.franchise],
    ['Character', l.character],
    ['Style', l.style ? STYLE_LABELS[l.style] || l.style : ''],
    ['Capacity', l.capacityMl ? `${l.capacityMl} ml` : ''],
    ['Material', l.material],
    ['Lid', triText(l.hasLid)],
    ['Dishwasher safe', triText(l.dishwasherSafe)],
    ['Microwave safe', triText(l.microwaveSafe)],
    ['SKU', l.sku],
    ['GTIN', l.gtin],
    ['Price', formatPrice(l.price)],
    ['In stock', l.available === true ? 'yes' : l.available === false ? 'no' : ''],
    ['Shop category', l.productType],
    ['Tags', Array.isArray(l.tags) ? l.tags.join(', ') : ''],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!rows.length) return '<p class="muted">The listing states no facts beyond its name.</p>';
  return `<dl class="fact-table admin-facts">${rows.map(([key, value]) => `<dt>${escHtml(key)}</dt><dd>${escHtml(value)}</dd>`).join('')}</dl>`;
}

/** A command or token with a Copy button. what names it for screen readers ("the command"). */
export function copyBlock(text, what = 'the command') {
  return `<div class="admin-copy">
    <code class="admin-code">${escHtml(text)}</code>
    <button type="button" class="btn btn--secondary btn--sm" data-copy>Copy<span class="visually-hidden"> ${escHtml(what)}</span></button>
  </div>`;
}

/** Non-empty trimmed lines. */
export function lines(text) {
  return String(text || '').split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
}

/** A comma list as trimmed, non-empty words. */
export function commaList(text) {
  return String(text || '').split(',').map((word) => word.trim()).filter(Boolean);
}

/** The lines that are not absolute https URLs, so a form can say so before anything is sent. */
export function badUrlLines(text) {
  return lines(text).filter((line) => {
    try {
      return new URL(line).protocol !== 'https:';
    } catch {
      return true;
    }
  });
}

// ── DOM helpers ──────────────────────────────────────────────

/** One element from a markup string. */
export function toElement(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html).trim();
  return template.content.firstElementChild;
}

/** Says message in the page's polite live region, so a screen reader hears each result. */
export function announce(message) {
  const region = document.getElementById('adminLive');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => {
    region.textContent = String(message || '');
  }, 60);
}

/**
 * Runs fn with button disabled (and, with group, every button inside it) so
 * a request cannot be sent twice, and gives focus back afterwards when the
 * button still exists and nothing else took focus meanwhile.
 */
export async function busy(button, fn, { group } = {}) {
  const others = group ? [...group.querySelectorAll('button')] : [];
  const held = [...new Set([button, ...others].filter(Boolean))];
  const before = held.map((b) => b.disabled);
  const hadFocus = button && document.activeElement === button;
  held.forEach((b) => {
    b.disabled = true;
  });
  button?.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    held.forEach((b, i) => {
      if (b.isConnected) b.disabled = before[i];
    });
    button?.removeAttribute('aria-busy');
    const lost = !document.activeElement || document.activeElement === document.body;
    if (hadFocus && button.isConnected && !button.disabled && lost) button.focus();
  }
}

function flashLabel(button, text) {
  const html = button.innerHTML;
  button.textContent = text;
  setTimeout(() => {
    if (button.isConnected) button.innerHTML = html;
  }, 1600);
}

/** One set of listeners for the whole console: Copy buttons and blurb counters. */
export function wireCommon(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const code = button.closest('.admin-copy')?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      flashLabel(button, 'Copied');
      announce('Copied.');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      announce('Selected. Press Control C, or Command C on a Mac, to copy it.');
    }
  });
  root.addEventListener('input', (event) => {
    const box = event.target.closest('[data-counter]');
    if (!box) return;
    const out = document.getElementById(box.dataset.counter);
    if (out) out.textContent = `${box.value.length} / ${box.maxLength}`;
  });
}
