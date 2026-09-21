// ── Import: one mug at a time ────────────────────────────────
// The importer's three doors. A shop URL the Worker reads (Amazon is refused
// by the server, which never fetches it, C11); a paste of what a marketplace
// page shows, previewed here with the same parser Convex runs
// (shared/extract/paste.js), so what you see is what will be staged; and a
// form typed by hand, which can publish in the same step.

import { FN } from '../backend.js';
import { fromPaste } from '../../shared/extract/paste.js';
import { mugHref } from '../render/cards.js';
import { debounce, escHtml } from '../utils.js';
import { badUrlLines, busy, extLink, factsList, failureText, outcome, sectionHead, verdictBadge } from './ui.js';
import { MANUAL_EDITS, MANUAL_FACTS, editsFrom, manualListing, mugFields, readValues, valuesOf } from './mugform.js';
import { sectionHash } from './routes.js';

const STATUS_WORDS = { queued: 'queued to be read', pending: 'waiting for review', needsLocal: 'waiting for the runner' };

/** What importer:fromUrl's answer means, as { tone, text, href, linkText } for outcome(). */
export function urlOutcome(result) {
  if (!result || !result.ok) return { tone: 'bad', text: failureText(result) };
  const id = result.stagingId;
  const at = (tab) => ({ href: sectionHash('review', tab, id), linkText: 'Open it in Review' });
  if (result.existing) {
    return { tone: 'info', text: `That page is already in the queue, ${STATUS_WORDS[result.status] || result.status}.`, ...at(result.status) };
  }
  const why = result.error && result.error.message ? ` (${result.error.message})` : '';
  switch (result.status) {
    case 'pending':
      return { tone: 'ok', text: `Read and staged for review. ${result.match && result.match.reason ? `Match: ${result.match.reason}.` : ''}`.trim(), ...at('pending') };
    case 'needsLocal':
      return result.error
        ? { tone: 'warn', text: `The shop refused the cloud${why}, so the page waits for the runner.`, ...at('needsLocal') }
        : { tone: 'warn', text: 'Cloud fetching is off, so the page waits for the runner.', ...at('needsLocal') };
    case 'unchanged':
      return { tone: 'info', text: 'Already in the catalogue, and the shop page has not changed.' };
    case 'linked':
      return { tone: 'ok', text: 'Linked to a mug already in the catalogue: same barcode, or same brand and SKU.' };
    case 'retry':
      return { tone: 'warn', text: `The shop did not answer${why}. The page stays queued; nothing retries a single import on its own, so reject it there and import it again later.`, ...at('queued') };
    case 'failed':
      return result.error
        ? { tone: 'bad', text: `Could not read it${why}.`, ...at('failed') }
        : { tone: 'warn', text: 'The page was read, but it does not read as a mug, so it was rejected.', ...at('rejected') };
    default:
      return { tone: 'warn', text: 'The queue item closed while the page was being read.' };
  }
}

function stagedOutcome(result) {
  const review = result.stagingId ? { href: sectionHash('review', 'pending', result.stagingId), linkText: 'Review it' } : {};
  const mug = result.mugId ? { href: sectionHash('catalog', 'edit', result.mugId), linkText: 'Open the mug' } : {};
  switch (result.outcome) {
    case 'staged':
      return { tone: 'ok', text: 'Staged for review.', ...review };
    case 'updated':
      return { tone: 'ok', text: 'An open review item for the same product was updated with this.', ...review };
    case 'unchanged':
      return { tone: 'info', text: 'Already in the catalogue, and nothing in this is new.', ...mug };
    case 'linked':
      return { tone: 'ok', text: 'Linked to a mug already in the catalogue.', ...mug };
    case 'skipped': {
      const reason = result.listing && result.listing.isMug ? result.listing.isMug.reason : '';
      return { tone: 'warn', text: `Not staged: it does not read as a mug${reason ? ` (${reason})` : ''}.` };
    }
    default:
      return { tone: 'info', text: 'Done.' };
  }
}

/** What importer:fromPaste's answer means. */
export function pasteOutcome(result) {
  if (!result || !result.ok) return { tone: 'bad', text: failureText(result) };
  return stagedOutcome(result);
}

/** What importer:manual's answer means: a mug when it was approved, else where the listing went. */
export function manualOutcome(result) {
  if (!result || !result.ok) return { tone: 'bad', text: failureText(result) };
  if (result.slug) {
    return { tone: 'ok', text: result.created === false ? 'Added to the mug it matched.' : 'Added to the catalogue.', href: mugHref(result.slug), linkText: 'See its page' };
  }
  return stagedOutcome(result);
}

/** The live preview of a paste: the listing fromPaste made, or why it made none. */
export function pastePreview(parsed) {
  if (!parsed) return '';
  if (!parsed.ok) return `<div class="notice notice--warn"><p>${escHtml(parsed.message || 'No product could be read from that.')}</p></div>`;
  const l = parsed.listing;
  const link = l.source && l.source.url ? extLink(l.source.url) : 'no product link';
  return `<div class="admin-preview stack stack--tight">
    <p class="eyebrow">Preview</p>
    <p><strong>${escHtml(l.name)}</strong> ${verdictBadge(l.isMug)}</p>
    ${factsList(l)}
    <p class="hint">Key <code>${escHtml(l.source ? l.source.key : '')}</code> &middot; ${link}. The server reads the paste again, with every brand the catalogue knows.</p>
  </div>`;
}

function frame() {
  return `${sectionHead('Import', 'Add one mug at a time: a shop page the Worker reads, a paste from a marketplace page nothing here may fetch, or a form you fill in.')}
    <section class="panel stack stack--tight" aria-labelledby="imp-url-t">
      <h3 id="imp-url-t">From a shop page</h3>
      <form class="admin-inline" data-form="url">
        <div class="field">
          <label for="imp-url">Product page URL</label>
          <input class="input" id="imp-url" name="url" type="url" inputmode="url" required autocomplete="off" placeholder="https://shop.example/products/..." aria-describedby="imp-url-hint">
        </div>
        <button type="submit" class="btn btn--primary">Import</button>
      </form>
      <p class="hint" id="imp-url-hint">The Worker reads the page, robots.txt first. Amazon is never fetched: paste it below instead.</p>
      <div data-out="url"></div>
    </section>
    <section class="panel stack stack--tight" aria-labelledby="imp-paste-t">
      <h3 id="imp-paste-t">Paste from a marketplace</h3>
      <form class="stack stack--tight" data-form="paste">
        <div class="field">
          <label for="imp-paste">What the product page shows</label>
          <textarea class="textarea" id="imp-paste" name="text" rows="7" maxlength="20000" required aria-describedby="imp-paste-hint"></textarea>
          <p class="hint" id="imp-paste-hint">Copy the page's URL onto the first line, then its title and a few detail lines. Amazon links shrink to their /dp/ form.</p>
        </div>
        <div data-preview></div>
        <div class="toolbar"><button type="submit" class="btn btn--primary">Stage it</button></div>
      </form>
      <div data-out="paste"></div>
    </section>
    <section class="panel stack stack--tight" aria-labelledby="imp-man-t">
      <h3 id="imp-man-t">Type it in</h3>
      <form class="stack stack--tight" data-form="manual">
        <div class="admin-grid">${mugFields(valuesOf(null, { styleAuto: true }), { idp: 'man', fields: MANUAL_FACTS, styleAuto: true })}</div>
        <div class="admin-grid">
          <div class="field field--wide">
            <label for="man-images">Image URLs, one per line</label>
            <textarea class="textarea" id="man-images" name="images" rows="3" placeholder="https://..." aria-describedby="man-images-hint"></textarea>
            <p class="hint" id="man-images-hint">https only, up to 12. They are copied once the mug is approved.</p>
          </div>
          <div class="field field--wide">
            <label for="man-shop">Shop page URL</label>
            <input class="input" id="man-shop" name="shopUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://...">
          </div>
          ${mugFields(valuesOf(null), { idp: 'man', fields: MANUAL_EDITS })}
        </div>
        <p class="hint">Blank facts are read from the name where it says them. The blurb and visibility apply when you add the mug straight to the catalogue.</p>
        <div class="toolbar">
          <button type="submit" class="btn btn--primary" name="intent" value="approve">Add to the catalogue</button>
          <button type="submit" class="btn btn--secondary" name="intent" value="stage">Send to review</button>
        </div>
      </form>
      <div data-out="manual" tabindex="-1"></div>
    </section>`;
}

/** Mounts the import forms into el. */
export function mount(el, ctx) {
  let alive = true;
  el.innerHTML = frame();
  const out = (name) => el.querySelector(`[data-out="${name}"]`);
  const pasteBox = el.querySelector('#imp-paste');
  const previewEl = el.querySelector('[data-preview]');
  const brands = new Set();

  const preview = () => {
    const text = pasteBox.value;
    if (!text.trim()) {
      previewEl.innerHTML = '';
      return;
    }
    let parsed;
    try {
      parsed = fromPaste(text, { knownBrands: [...brands], now: Date.now() });
    } catch (err) {
      console.error(err);
      parsed = { ok: false, message: 'The preview could not read that. Staging it still asks the server.' };
    }
    previewEl.innerHTML = pastePreview(parsed);
  };
  const previewSoon = debounce(preview, 250);

  // Brands the preview should recognise, as the server does with its own list.
  Promise.allSettled([ctx.session.query(FN.catalog.facets, {}), ctx.session.query(FN.sources.list, {})]).then(([facets, sources]) => {
    if (facets.status === 'fulfilled' && facets.value) facets.value.brands.forEach((b) => brands.add(b.name));
    if (sources.status === 'fulfilled' && Array.isArray(sources.value)) sources.value.forEach((s) => s.brand && brands.add(s.brand));
    if (alive && pasteBox.value.trim()) preview();
  });

  const show = (name, note) => {
    out(name).innerHTML = outcome(note);
    ctx.announce(note.text);
  };

  async function importUrl(form, button) {
    const url = form.elements.namedItem('url').value.trim();
    const result = await busy(button, () => ctx.session.action(FN.importer.fromUrl, { url }), { group: form });
    if (!alive || !result) return;
    const note = urlOutcome(result);
    if (result.code === 'amazon') note.extra = '<div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-act="to-paste">Paste it instead</button></div>';
    show('url', note);
    if (result.ok) {
      form.reset();
      ctx.refreshCounts();
    }
  }

  async function stagePaste(form, button) {
    const result = await busy(button, () => ctx.session.mutation(FN.importer.fromPaste, { text: pasteBox.value }), { group: form });
    if (!alive || !result) return;
    show('paste', pasteOutcome(result));
    if (result.ok && result.outcome !== 'skipped') {
      form.reset();
      previewEl.innerHTML = '';
      ctx.refreshCounts();
    }
  }

  async function addManual(form, button) {
    const imagesText = form.elements.namedItem('images').value;
    const bad = badUrlLines(imagesText);
    if (bad.length) {
      show('manual', { tone: 'bad', text: `Not an https URL: ${bad[0].slice(0, 80)}` });
      form.elements.namedItem('images').focus();
      return;
    }
    const approve = !button || button.value !== 'stage';
    const values = readValues(form, [...MANUAL_FACTS, ...MANUAL_EDITS]);
    const args = { listing: manualListing(values, imagesText, form.elements.namedItem('shopUrl').value), approve };
    if (approve) {
      const edits = editsFrom(valuesOf(null), values, MANUAL_EDITS);
      if (Object.keys(edits).length) args.edits = edits;
    }
    const result = await busy(button, () => ctx.session.mutation(FN.importer.manual, args), { group: form });
    if (!alive || !result) return;
    show('manual', manualOutcome(result));
    if (result.ok) {
      form.reset();
      form.querySelectorAll('[data-counter]').forEach((box) => box.dispatchEvent(new Event('input', { bubbles: true })));
      out('manual').focus();
      ctx.refreshCounts();
    }
  }

  el.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = event.submitter || form.querySelector('[type="submit"]');
    if (form.dataset.form === 'url') importUrl(form, button);
    else if (form.dataset.form === 'paste') stagePaste(form, button);
    else if (form.dataset.form === 'manual') addManual(form, button);
  });
  el.addEventListener('input', (event) => {
    if (event.target === pasteBox) previewSoon();
  });
  el.addEventListener('click', (event) => {
    if (!event.target.closest('[data-act="to-paste"]')) return;
    const url = el.querySelector('#imp-url').value.trim();
    if (url && !pasteBox.value.includes(url)) pasteBox.value = `${url}\n${pasteBox.value}`.trim();
    pasteBox.focus();
    pasteBox.setSelectionRange(pasteBox.value.length, pasteBox.value.length);
    preview();
  });

  return () => {
    alive = false;
  };
}
