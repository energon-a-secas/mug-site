// ── Catalog: every mug, and the editor ───────────────────────
// Search and filter mugs:adminList; open one in the editor (mugs:adminGet),
// change its facts, reorder or remove its images, add image URLs, upload one
// from disk, retry mirroring, and save with mugs:save, which is sent only
// what changed. Routes: #catalog/<imageState> presets the image filter, and
// #catalog/edit/<mugId> opens a mug straight away.

import { FN } from '../backend.js';
import { resize, upload } from '../images.js';
import { failure } from '../session.js';
import { debounce, escHtml } from '../utils.js';
import { badUrlLines, busy, failureText, lines, loadFailed, outcome, sectionHead, skeletonRows, toElement } from './ui.js';
import { CATALOG_FIELDS, editsFrom, readValues, valuesOf } from './mugform.js';
import { IMAGE_STATES, describeFilters, editorHtml, imageRows, listArgs, mugRow, pendingHtml } from './catalog-view.js';
import { sectionHash } from './routes.js';

const PAGE = 24;
const UPLOAD_MAX = 1600;

function frame(imageState) {
  const states = IMAGE_STATES.map((s) => `<option value="${s.value}"${s.value === imageState ? ' selected' : ''}>${escHtml(s.label)}</option>`).join('');
  return `${sectionHead('Catalog', 'Every mug, published or hidden. Edit its facts, order its images, add more.')}
    <section class="panel stack" data-editor aria-labelledby="cat-ed-t" hidden></section>
    <form class="admin-filters" data-form="filters" role="search" aria-label="Find mugs">
      <div class="field"><label for="cat-q">Search</label><input class="input" type="search" id="cat-q" name="q" autocomplete="off" placeholder="Name, maker, character, SKU..."></div>
      <div class="field"><label for="cat-status">Status</label><select class="select" id="cat-status" name="status"><option value="">Any status</option><option value="published">Published</option><option value="hidden">Hidden</option></select></div>
      <div class="field"><label for="cat-images">Images</label><select class="select" id="cat-images" name="imageState"><option value="">Any images</option>${states}</select></div>
    </form>
    <p class="muted" data-describe></p>
    <ul class="admin-rows" data-list aria-busy="true">${skeletonRows(3)}</ul>
    <div class="load-more"><button type="button" class="btn btn--secondary" data-act="more" hidden>Show more</button></div>`;
}

/** Mounts the catalogue list and editor into el. params: [imageState] or ['edit', mugId]. */
export function mount(el, ctx, params = []) {
  const preset = IMAGE_STATES.some((s) => s.value === params[0]) ? params[0] : '';
  const view = { filters: { q: '', status: '', imageState: preset }, items: [], cursor: null, done: false, token: 0 };
  let ed = null;
  let alive = true;
  el.innerHTML = frame(preset);
  const list = el.querySelector('[data-list]');
  const more = el.querySelector('[data-act="more"]');
  const describe = el.querySelector('[data-describe]');
  const editor = el.querySelector('[data-editor]');
  const filters = el.querySelector('form[data-form="filters"]');

  async function load(reset) {
    const token = reset ? ++view.token : view.token;
    if (reset) {
      view.items = [];
      view.cursor = null;
      list.setAttribute('aria-busy', 'true');
      describe.textContent = describeFilters(view.filters);
    }
    more.disabled = true;
    try {
      const result = await ctx.session.query(FN.mugs.adminList, listArgs(view.filters, view.cursor, PAGE));
      if (!alive || token !== view.token) return;
      view.items = view.items.concat(result.page);
      view.cursor = result.continueCursor;
      view.done = result.isDone;
      const rows = result.page.map(mugRow).join('');
      if (reset) list.innerHTML = rows || '<li class="empty"><p>No mug matches these filters.</p></li>';
      else list.insertAdjacentHTML('beforeend', rows);
    } catch (err) {
      console.error(err);
      if (alive && token === view.token) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive && token === view.token) {
        list.setAttribute('aria-busy', 'false');
        more.hidden = view.done;
        more.disabled = false;
      }
    }
  }

  const applyFilters = () => {
    view.filters = {
      q: filters.elements.namedItem('q').value.trim(),
      status: filters.elements.namedItem('status').value,
      imageState: filters.elements.namedItem('imageState').value,
    };
    load(true);
  };
  const applySoon = debounce(applyFilters, 300);

  const say = (note) => {
    const slot = editor.querySelector('[data-ed-out]');
    if (slot) slot.innerHTML = outcome(note);
    ctx.announce(note.text);
  };

  function renderImages(focus) {
    editor.querySelector('[data-imgs]').innerHTML = imageRows(ed.mug.images || [], ed.order, ed.removed);
    editor.querySelector('[data-pending]').innerHTML = pendingHtml(ed.mug);
    if (!focus) return;
    const row = editor.querySelector(`[data-imgs] li[data-index="${focus.index}"]`);
    const target = row && ([focus.act, ...(focus.fallback || [])].map((act) => row.querySelector(`[data-act="${act}"]:not([disabled])`)).find(Boolean));
    (target || editor.querySelector('#cat-ed-t'))?.focus();
  }

  async function openEditor(id, from) {
    editor.hidden = false;
    editor.innerHTML = skeletonRows(2);
    let mug = null;
    try {
      mug = await ctx.session.query(FN.mugs.adminGet, { id });
    } catch (err) {
      console.error(err);
    }
    if (!alive) return;
    if (!mug) {
      editor.innerHTML = `${outcome({ tone: 'bad', text: 'That mug could not be opened. It may have been removed.' })}<div class="toolbar"><button type="button" class="btn btn--secondary btn--sm" data-act="close">Close</button></div>`;
      ctx.announce('That mug could not be opened.');
      return;
    }
    ed = { id, mug, initial: valuesOf(mug), order: (mug.images || []).map((_, i) => i), removed: [], from: from || null };
    editor.innerHTML = editorHtml(mug, ed);
    history.replaceState(null, '', sectionHash('catalog', 'edit', id));
    editor.querySelector('#cat-ed-t').focus();
  }

  function closeEditor() {
    const from = ed && ed.from;
    const id = ed && ed.id;
    ed = null;
    editor.hidden = true;
    editor.innerHTML = '';
    history.replaceState(null, '', sectionHash('catalog'));
    const back = (from && from.isConnected && from) || (id && list.querySelector(`li[data-id="${CSS.escape(id)}"] [data-act="edit"]`)) || el.querySelector('h2');
    back.focus();
  }

  function moveImage(li, act) {
    const index = Number(li.dataset.index);
    const at = ed.order.indexOf(index);
    if (act === 'img-up' && at > 0) [ed.order[at - 1], ed.order[at]] = [ed.order[at], ed.order[at - 1]];
    if (act === 'img-down' && at >= 0 && at < ed.order.length - 1) [ed.order[at + 1], ed.order[at]] = [ed.order[at], ed.order[at + 1]];
    if (act === 'img-remove' && at >= 0) {
      ed.order.splice(at, 1);
      ed.removed.push(index);
    }
    if (act === 'img-undo') {
      ed.removed = ed.removed.filter((i) => i !== index);
      ed.order.push(index);
    }
    const pos = ed.order.indexOf(index) + 1;
    const words = {
      'img-up': `Image moved to position ${pos}.`,
      'img-down': `Image moved to position ${pos}.`,
      'img-remove': 'Image will be removed when you save.',
      'img-undo': `Image kept, now at position ${pos}.`,
    };
    const fallback = { 'img-up': ['img-down'], 'img-down': ['img-up'], 'img-remove': ['img-undo'], 'img-undo': ['img-remove'] };
    renderImages({ index, act: act === 'img-remove' ? 'img-undo' : act === 'img-undo' ? 'img-remove' : act, fallback: fallback[act] });
    ctx.announce(words[act]);
  }

  // Images changed on the server (an upload, a retry): take them, keep the order being edited.
  async function refreshImages() {
    const current = ed;
    if (!current) return;
    const fresh = await ctx.session.query(FN.mugs.adminGet, { id: current.id });
    if (!alive || ed !== current || !fresh) return;
    const before = current.mug.images.length;
    current.mug = { ...current.mug, images: fresh.images, pendingImages: fresh.pendingImages, imageState: fresh.imageState };
    if (fresh.images.length < before) {
      current.order = fresh.images.map((_, i) => i);
      current.removed = [];
    } else {
      for (let i = before; i < fresh.images.length; i++) current.order.push(i);
    }
    renderImages();
  }

  async function save(form, button) {
    const current = ed;
    const edits = editsFrom(current.initial, readValues(form, CATALOG_FIELDS), CATALOG_FIELDS);
    const addText = form.elements.namedItem('addImages').value;
    const bad = badUrlLines(addText);
    if (bad.length) {
      say({ tone: 'bad', text: `Not an https URL: ${bad[0].slice(0, 80)}` });
      form.elements.namedItem('addImages').focus();
      return;
    }
    const add = lines(addText);
    if (add.length) edits.images = add;
    const count = (current.mug.images || []).length;
    const reordered = current.order.length !== count || current.order.some((index, pos) => index !== pos);
    if (!Object.keys(edits).length && !reordered) {
      say({ tone: 'info', text: 'Nothing has changed, so nothing was sent.' });
      return;
    }
    const args = { id: current.id };
    if (Object.keys(edits).length) args.edits = edits;
    if (reordered) args.imageOrder = current.order.slice();
    const result = await busy(button, () => ctx.session.mutation(FN.mugs.save, args), { group: form });
    if (!alive || ed !== current || !result) return;
    if (!result.ok) {
      say({ tone: 'bad', text: failureText(result) });
      return;
    }
    await openEditor(current.id, current.from);
    say({ tone: 'ok', text: add.length ? 'Saved. The new images are being copied.' : 'Saved.' });
    const mug = ed && ed.mug;
    const row = mug && list.querySelector(`li[data-id="${CSS.escape(current.id)}"]`);
    if (row) {
      const summary = { id: current.id, slug: mug.slug, name: mug.name, brand: mug.brand, style: mug.style, status: mug.status, imageState: mug.imageState, images: mug.images.length, pendingImages: mug.pendingImages.length, ownedCount: mug.ownedCount, wantedCount: mug.wantedCount, updatedAt: mug.updatedAt };
      row.replaceWith(toElement(mugRow(summary)));
    }
  }

  async function retryImages(button) {
    const current = ed;
    const result = await busy(button, () => ctx.session.mutation(FN.images.retry, { mugId: current.id }));
    if (!alive || ed !== current || !result) return;
    say(result.ok ? { tone: 'ok', text: 'Mirroring is scheduled again. Reopen the mug in a moment to see the result.' } : { tone: 'bad', text: failureText(result) });
    if (result.ok) {
      await refreshImages();
      ctx.refreshCounts();
    }
  }

  async function uploadImage(button) {
    const current = ed;
    const input = editor.querySelector('#cat-upload');
    const status = editor.querySelector('[data-upload-status]');
    const file = input.files && input.files[0];
    if (!file) {
      ctx.announce('Choose an image first.');
      input.focus();
      return;
    }
    const step = (text) => {
      if (status.isConnected) status.textContent = text;
    };
    const result = await busy(button, async () => {
      try {
        step('Resizing...');
        const { blob } = await resize(file, UPLOAD_MAX);
        step('Uploading...');
        const slot = await ctx.session.mutation(FN.images.uploadUrl, {});
        if (!slot.ok) return slot;
        const storageId = await upload(slot.uploadUrl, blob);
        step('Storing...');
        return await ctx.session.action(FN.images.addOriginal, { mugId: current.id, storageId });
      } catch (err) {
        console.error(err);
        return { ok: false, message: /createImageBitmap|decode|source/i.test(String(err && err.message)) ? 'That file could not be read as an image.' : 'The upload did not go through. Try again.' };
      }
    });
    if (!alive || ed !== current || !result) return;
    step('');
    if (!result.ok) {
      say({ tone: 'bad', text: failureText(result) });
      return;
    }
    input.value = '';
    await refreshImages();
    say({ tone: 'ok', text: 'Image added at the end. Move it up to make it the cover.' });
  }

  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !el.contains(button)) return;
    const act = button.dataset.act;
    if (act === 'more') load(false);
    else if (act === 'reload') load(true);
    else if (act === 'edit') openEditor(button.closest('li[data-id]').dataset.id, button);
    else if (act === 'close') closeEditor();
    else if (act === 'retry-images' && ed) retryImages(button);
    else if (act === 'upload' && ed) uploadImage(button);
    else if (act.startsWith('img-') && ed) moveImage(button.closest('li[data-index]'), act);
  });
  el.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.form === 'filters') applyFilters();
    else if (form.dataset.form === 'mug' && ed && form.reportValidity()) save(form, event.submitter || form.querySelector('[type="submit"]'));
  });
  filters.addEventListener('input', (event) => {
    if (event.target.name === 'q') applySoon();
  });
  filters.addEventListener('change', (event) => {
    if (event.target.name !== 'q') applyFilters();
  });

  load(true);
  if (params[0] === 'edit' && params[1]) openEditor(params[1]);
  return () => {
    alive = false;
    view.token++;
  };
}

