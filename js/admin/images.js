// ── Images: thumbnails made in this browser ──────────────────
// Free-plan Workers cannot decode images, so thumbnails are made where CPU
// is free: here (docs/CONTRACTS.md C4.4). Each queued original is fetched,
// redrawn at 480 px as WebP, uploaded to Convex storage and handed to
// images:attachThumb, which moves it to R2 when the Worker is set. One image
// at a time, with progress, a Stop button and a list of what failed.

import { FN } from '../backend.js';
import { resize, upload } from '../images.js';
import { failure } from '../session.js';
import { mugHref } from '../render/cards.js';
import { escHtml, plural } from '../utils.js';
import { busy, loadFailed, sectionHead, skeletonRows } from './ui.js';

/** C4.4: 480 px, WebP at 0.8. */
export const THUMB_MAX = 480;
export const THUMB_QUALITY = 0.8;

/** The queue as one job per image: { mugId, name, slug, index, src }. */
export function jobsOf(queue) {
  const jobs = [];
  for (const mug of Array.isArray(queue) ? queue : []) {
    for (const image of mug.images || []) jobs.push({ mugId: mug.mugId, name: mug.name, slug: mug.slug, index: image.index, src: image.src });
  }
  return jobs;
}

/** The queue as a list: each mug, and how many of its images lack a thumbnail. */
export function queueHtml(queue) {
  if (!queue || !queue.length) return '<li class="empty"><p>Every stored image has its thumbnail.</p></li>';
  return queue
    .map((mug) => `<li class="admin-row">
      <div class="admin-row__main">
        <p class="admin-row__title"><a href="${escHtml(mugHref(mug.slug))}" target="_blank" rel="noopener">${escHtml(mug.name)}<span class="visually-hidden"> (new tab)</span></a></p>
        <p class="hint">${escHtml(plural((mug.images || []).length, 'image'))} without a thumbnail</p>
      </div>
    </li>`)
    .join('');
}

/** What failed, one line per image. */
export function failuresHtml(failures) {
  if (!failures.length) return '';
  return `<h3>Not made (${failures.length})</h3>
    <ul class="admin-links">${failures
      .map((f) => `<li><a href="${escHtml(mugHref(f.slug))}" target="_blank" rel="noopener">${escHtml(f.name)}</a>, image ${escHtml(String(f.index + 1))}: ${escHtml(f.message)}</li>`)
      .join('')}</ul>`;
}

async function makeOne(ctx, job) {
  let blob;
  try {
    const res = await fetch(job.src, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`the stored original answered HTTP ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    throw new Error(/HTTP/.test(String(err.message)) ? err.message : 'could not download the stored original');
  }
  let thumb;
  try {
    ({ blob: thumb } = await resize(blob, THUMB_MAX, THUMB_QUALITY));
  } catch {
    throw new Error('this browser could not decode the original');
  }
  const slot = await ctx.session.mutation(FN.images.uploadUrl, {});
  if (!slot.ok) throw new Error(slot.message);
  const storageId = await upload(slot.uploadUrl, thumb);
  const done = await ctx.session.action(FN.images.attachThumb, { mugId: job.mugId, index: job.index, storageId });
  if (!done.ok) throw new Error(done.message);
}

/** Mounts the thumbnail queue and its runner into el. */
export function mount(el, ctx) {
  let alive = true;
  let queue = [];
  let stopping = false;
  el.innerHTML = `${sectionHead('Images', 'Originals are stored; these need thumbnails. Your browser makes them: 480 px WebP, one image at a time.')}
    <div class="toolbar">
      <button type="button" class="btn btn--primary" data-act="make" disabled>Make thumbnails</button>
      <button type="button" class="btn btn--secondary" data-act="stop" hidden>Stop after this image</button>
      <button type="button" class="btn btn--ghost" data-act="reload">Reload the queue</button>
    </div>
    <div class="admin-progress stack stack--tight" data-progress hidden>
      <label for="img-progress" data-progress-text>Starting...</label>
      <progress id="img-progress" max="1" value="0"></progress>
    </div>
    <div data-failures></div>
    <ul class="admin-rows" data-list aria-busy="true">${skeletonRows(2)}</ul>`;
  const make = el.querySelector('[data-act="make"]');
  const stop = el.querySelector('[data-act="stop"]');
  const list = el.querySelector('[data-list]');
  const progress = el.querySelector('[data-progress]');
  const bar = el.querySelector('#img-progress');
  const text = el.querySelector('[data-progress-text]');
  const failuresEl = el.querySelector('[data-failures]');

  async function load() {
    list.setAttribute('aria-busy', 'true');
    try {
      const answer = await ctx.session.query(FN.images.thumbsQueue, {});
      if (!alive) return;
      if (answer === null) {
        list.innerHTML = loadFailed('The server answered nothing: this account may no longer be a maintainer.');
        return;
      }
      queue = answer;
      list.innerHTML = queueHtml(queue);
      const n = jobsOf(queue).length;
      make.disabled = n === 0;
      make.textContent = n ? `Make ${plural(n, 'thumbnail')}` : 'Make thumbnails';
    } catch (err) {
      console.error(err);
      if (alive) list.innerHTML = loadFailed(failure(err).message);
    } finally {
      if (alive) list.setAttribute('aria-busy', 'false');
    }
  }

  async function run() {
    const jobs = jobsOf(queue);
    if (!jobs.length) return;
    const failures = [];
    let made = 0;
    stopping = false;
    stop.hidden = false;
    progress.hidden = false;
    failuresEl.innerHTML = '';
    bar.max = jobs.length;
    ctx.announce(`Making ${plural(jobs.length, 'thumbnail')}.`);
    for (let i = 0; i < jobs.length; i++) {
      if (!alive || stopping) break;
      const job = jobs[i];
      text.textContent = `${i + 1} of ${jobs.length}: ${job.name}, image ${job.index + 1}`;
      try {
        await makeOne(ctx, job);
        made++;
      } catch (err) {
        console.error(err);
        failures.push({ ...job, message: String((err && err.message) || 'it did not work') });
        if (alive) failuresEl.innerHTML = failuresHtml(failures);
      }
      bar.value = i + 1;
    }
    if (!alive) return;
    stop.hidden = true;
    const summary = `Made ${plural(made, 'thumbnail')}${failures.length ? `, ${failures.length} failed` : ''}${stopping ? ', stopped early' : ''}.`;
    text.textContent = summary;
    ctx.announce(summary);
    ctx.refreshCounts();
    await load();
  }

  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'make') {
      // Stop stays usable; Make and Reload wait for the batch.
      const reload = el.querySelector('[data-act="reload"]');
      reload.disabled = true;
      busy(button, run).finally(() => {
        if (!alive) return;
        reload.disabled = false;
        make.disabled = jobsOf(queue).length === 0;
      });
    } else if (act === 'stop') {
      stopping = true;
      stop.hidden = true;
      ctx.announce('Stopping after the image in progress.');
    } else if (act === 'reload') load();
  });

  load();
  return () => {
    alive = false;
    stopping = true;
  };
}
