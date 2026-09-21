// The admin console's pure renderers and helpers, in plain node: escaping of
// everything a shop or a collector wrote, the "only what changed" edits the
// review and catalogue forms send, bulk approval's limits, the routes, and
// the runner's site URL. tests/syntax.test.mjs covers parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, sectionHash } from '../js/admin/routes.js';
import { badUrlLines, countText, extLink, factsList, httpUrl, outcome } from '../js/admin/ui.js';
import {
  CATALOG_FIELDS, MANUAL_FACTS, REVIEW_FIELDS, editsFrom, imagesEdit, manualListing, mugFields, valuesOf,
} from '../js/admin/mugform.js';
import { BULK_MAX, bulkCandidates, matchBadge, mergeResults, otherItem, pendingItem } from '../js/admin/review-view.js';
import { overviewHtml } from '../js/admin/dashboard.js';
import { manualOutcome, pastePreview, urlOutcome } from '../js/admin/import.js';
import { runnerCommand, scanOutcome, sourceArgs, sourceCard, sourceFormHtml } from '../js/admin/sources-view.js';
import { isActive, runCard } from '../js/admin/runs.js';
import { describeFilters, imageRows, listArgs } from '../js/admin/catalog-view.js';
import { photoCard } from '../js/admin/community.js';
import { siteUrlFor, tokenRow, waitingText } from '../js/admin/runner.js';
import { railCounts } from '../js/admin/context.js';
import { fromPaste } from '../shared/extract/paste.js';

// safeHref resolves against location.origin, which node does not have.
globalThis.location ??= { origin: 'https://mug.neorgon.com', hostname: 'mug.neorgon.com', search: '' };

const EVIL = '<img src=x onerror=alert(1)>';

function pending(overrides = {}, listing = {}) {
  return {
    id: 'st1',
    key: 'shop.example/products/pikachu',
    url: 'https://shop.example/products/pikachu',
    status: 'pending',
    listing: {
      v: 1,
      source: { host: 'shop.example', url: 'https://shop.example/products/pikachu', key: 'shop.example/products/pikachu', platform: 'shopify', via: 'worker', fetchedAt: 1 },
      name: 'Pikachu 3D Mug',
      brand: 'ABYstyle',
      style: 'sculpted',
      capacityMl: 475,
      images: ['https://cdn.shop.example/a.jpg', 'https://cdn.shop.example/b.jpg'],
      tags: [],
      isMug: { verdict: 'yes', reason: 'title says mug' },
      ...listing,
    },
    match: { kind: 'new', fields: [], reason: 'nothing like it in the catalogue', mug: null },
    error: null,
    attempts: 0,
    source: { slug: 'abystyle-eu', name: 'ABYstyle (EU shop)' },
    mug: null,
    createdAt: Date.now() - 3600e3,
    updatedAt: Date.now() - 3600e3,
    ...overrides,
  };
}

/** Every visible form control has a <label for> naming it. */
function assertLabelled(html) {
  const ids = [...html.matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)]
    .filter(([, attrs]) => !/type="hidden"/.test(attrs))
    .map(([, attrs]) => (/\bid="([^"]+)"/.exec(attrs) || [])[1]);
  for (const id of ids) {
    if (id === undefined) continue; // a control wrapped by its label (checkboxes, switches)
    assert.ok(html.includes(`for="${id}"`), `no label for #${id}`);
  }
}

test('routes: sections, params, and anchors that are not sections', () => {
  assert.deepEqual(parseHash(''), { section: 'overview', params: [] });
  assert.deepEqual(parseHash('#review/needsLocal'), { section: 'review', params: ['needsLocal'] });
  assert.deepEqual(parseHash('#catalog/edit/abc%2Fdef'), { section: 'catalog', params: ['edit', 'abc/def'] });
  assert.equal(parseHash('#main'), null, "the skip link's anchor leaves the section alone");
  assert.equal(sectionHash('review', 'pending', 'a b', ''), '#review/pending/a%20b');
});

test('a pending item escapes every value a shop wrote', () => {
  const html = pendingItem(pending({}, {
    name: EVIL,
    brand: EVIL,
    description: '<script>alert(1)</script>',
    images: ['javascript:alert(1)', 'https://cdn.shop.example/a.jpg"><script>alert(2)</script>'],
    source: { host: 'x', url: 'javascript:alert(1)', key: 'k', platform: 'shopify', via: 'worker', fetchedAt: 1 },
  }));
  assert.ok(!html.includes('<img src=x'), 'the name is escaped');
  assert.ok(!/<script/i.test(html), 'no script element survives');
  assert.ok(!html.includes('javascript:'), 'no javascript: URL reaches an attribute or an image');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('never published'), 'the shop description is marked as reference only');
  assertLabelled(html);
});

test('a pending item: tiles with checkboxes, the verdict, the match, and the three answers', () => {
  const html = pendingItem(pending());
  assert.equal((html.match(/type="checkbox" name="img"/g) || []).length, 2);
  assert.ok(html.includes('referrerpolicy="no-referrer"'));
  assert.ok(html.includes('Mug: yes'));
  assert.ok(html.includes('data-act="approve"') && html.includes('data-act="merge"') && html.includes('data-act="reject"'));
  assert.ok(!/\son[a-z]+=/i.test(html), 'no inline event handlers');
});

test('match badges: changed names its fields, similar links the mug', () => {
  const changed = matchBadge({ kind: 'changed', fields: ['capacityMl', 'price'], mugId: 'm1', mug: { id: 'm1', slug: 'joker', name: 'Joker' } });
  assert.match(changed, /Changed: capacity, price/);
  assert.match(changed, /href="\/mug\/\?joker"/);
  const similar = matchBadge({ kind: 'similar', fields: [], mug: { id: 'm2', slug: 'a"b', name: EVIL } });
  assert.ok(similar.includes('href="/mug/?a%22b"'));
  assert.ok(!similar.includes('<img'));
  assert.match(matchBadge({ kind: 'new', fields: [] }), /New/);
});

test('rows in other tabs: the error, Retry only with a URL, no Reject once closed', () => {
  const failed = otherItem(pending({ status: 'failed', listing: null, error: { code: 'UPSTREAM_ERROR', message: EVIL } }));
  assert.ok(failed.includes('data-act="retry"') && failed.includes('data-act="reject"'));
  assert.ok(!failed.includes('<img src=x'));
  assert.ok(!otherItem(pending({ status: 'failed', listing: null, url: null })).includes('data-act="retry"'));
  const approved = otherItem(pending({ status: 'approved', mug: { slug: 'pikachu', name: 'Pikachu' } }));
  assert.ok(!approved.includes('data-act='), 'nothing to do with an approved row');
  assert.match(approved, /Approved as <a href="\/mug\/\?pikachu">/);
});

test('edits: only what changed, typed for cleanEdits, null to clear', () => {
  const initial = valuesOf({ name: 'Pikachu 3D Mug', brand: 'ABYstyle', style: 'sculpted', capacityMl: 475, hasLid: true });
  assert.deepEqual(editsFrom(initial, { ...initial }, REVIEW_FIELDS), {}, 'an untouched form sends nothing');
  const current = { ...initial, brand: '', capacityMl: '500', hasLid: 'unknown', dishwasherSafe: 'no', blurb: '   ', name: ' Pikachu  3D Mug ' };
  assert.deepEqual(editsFrom(initial, current, REVIEW_FIELDS), { brand: null, capacityMl: 500, hasLid: null, dishwasherSafe: false });
  assert.deepEqual(editsFrom(initial, { ...initial, status: 'hidden', material: 'stoneware' }, REVIEW_FIELDS), { status: 'hidden', material: 'stoneware' });
  const mug = valuesOf({ name: 'Joker', style: 'relief', releaseYear: 2021, gtin: '3665361123456', status: 'hidden' });
  assert.equal(mug.status, 'hidden');
  assert.deepEqual(editsFrom(mug, { ...mug, releaseYear: '', gtin: '' }, CATALOG_FIELDS), { releaseYear: null, gtin: null });
});

test('images: unchanged selection sends nothing, a changed one sends the ticked URLs', () => {
  const offered = ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'];
  assert.equal(imagesEdit(offered, offered.slice()), undefined);
  assert.deepEqual(imagesEdit(offered, ['https://a/1.jpg', 'https://a/3.jpg']), ['https://a/1.jpg', 'https://a/3.jpg']);
  assert.deepEqual(imagesEdit(offered, []), []);
});

test('bulk approval: new and read as a mug, never edited, at most 25', () => {
  const rows = [
    pending({ id: 'a' }),
    pending({ id: 'b' }, { isMug: { verdict: 'maybe', reason: 'gift set' } }),
    pending({ id: 'c', match: { kind: 'similar', fields: [], reason: 'same words', mug: null } }),
    pending({ id: 'd', match: { kind: 'changed', fields: ['price'], reason: 'price', mug: null } }),
    pending({ id: 'e' }),
  ];
  assert.deepEqual(bulkCandidates(rows, (id) => id === 'e'), { ids: ['a'], more: 0, edited: 1 });
  const many = Array.from({ length: 30 }, (_, i) => pending({ id: `n${i}` }));
  const pick = bulkCandidates(many);
  assert.equal(pick.ids.length, BULK_MAX);
  assert.equal(pick.more, 5);
});

test('merge picker: the queue match first, results escaped', () => {
  const html = mergeResults(
    [{ id: 'm9', slug: 'other', name: EVIL, brand: 'Paladone', status: 'hidden' }],
    { kind: 'similar', mug: { id: 'm1', slug: 'joker', name: 'Joker' } },
  );
  assert.ok(html.indexOf('data-mug="m1"') < html.indexOf('data-mug="m9"'));
  assert.ok(html.includes('the match the queue found'));
  assert.ok(!html.includes('<img src=x'));
  assert.equal(mergeResults([], null), '');
});

test('the mug form labels every control and caps the blurb at 500', () => {
  const html = mugFields(valuesOf({ name: EVIL, blurb: 'hello' }), { idp: 'x', fields: CATALOG_FIELDS });
  assertLabelled(html);
  assert.match(html, /name="blurb"[^>]*maxlength="500"/);
  assert.match(html, /name="name"[^>]*required/);
  assert.ok(html.includes('5 / 500'));
  assert.ok(!html.includes('<img src=x'));
  for (const name of ['hasLid', 'dishwasherSafe', 'microwaveSafe']) {
    assert.match(html, new RegExp(`name="${name}"[^>]*>.*value="unknown".*value="yes".*value="no"`, 's'));
  }
});

test('a typed-in mug: the admin says it is a mug, blanks stay blank for the server to read', () => {
  const values = { ...valuesOf(null, { styleAuto: true }), name: ' Luna  Teapot ', capacityMl: '800', hasLid: 'yes', microwaveSafe: 'no' };
  const listing = manualListing(values, 'https://img.example/1.jpg\n\n https://img.example/2.jpg ', 'https://shop.example/luna');
  assert.deepEqual(listing, {
    name: 'Luna Teapot',
    isMug: { verdict: 'yes', reason: 'entered by hand' },
    images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
    capacityMl: 800,
    hasLid: true,
    microwaveSafe: false,
    source: { url: 'https://shop.example/luna' },
  });
  assert.deepEqual(manualListing({ name: 'X', style: '' }).source, {});
  assert.ok(MANUAL_FACTS.includes('gtin'));
  assert.deepEqual(badUrlLines('https://ok.example/a\nhttp://plain.example/b\nnot a url'), ['http://plain.example/b', 'not a url']);
});

test('overview: tiles link to their sections, counts cap, configuration in words', () => {
  const dash = {
    cap: 500,
    queue: { pending: 500, queued: 0, needsLocal: 3, failed: 0 },
    images: { pending: 1, blocked: 0, failed: 0, thumbs: 7 },
    photosPending: 2,
    activeRuns: 0,
    mugs: 1234,
    config: { proxy: false, imagesBase: `https://img.example/${EVIL}`, publishing: false, admins: 1 },
  };
  const html = overviewHtml(dash);
  assert.ok(html.includes('500+'));
  assert.ok(html.includes('1,234'), 'the mug count is a stat, never capped');
  for (const href of ['#review/pending', '#review/needsLocal', '#images', '#community', '#runs', '#catalog']) assert.ok(html.includes(`href="${href}"`));
  assert.match(html, /Cloud fetching is off; scans need the runner/);
  assert.match(html, /PUBLISHING=open/);
  assert.ok(html.includes('1 account'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!overviewHtml({ ...dash, config: { proxy: true, publishing: true, imagesBase: null, admins: 2 } }).includes('notice--warn'));
  assert.deepEqual(railCounts(dash), { review: 500, runs: 0, images: 7, community: 2, runner: 3 });
  assert.equal(countText(12, 500), '12');
});

test('import outcomes: Amazon refused with the server message, links into Review', () => {
  const amazon = urlOutcome({ ok: false, code: 'amazon', message: 'Amazon is never fetched (robots.txt refuses it).' });
  assert.equal(amazon.tone, 'bad');
  assert.match(amazon.text, /Amazon is never fetched/);
  const staged = urlOutcome({ ok: true, stagingId: 'st9', status: 'pending', match: { kind: 'new', reason: 'nothing like it' }, error: null });
  assert.equal(staged.href, '#review/pending/st9');
  assert.equal(urlOutcome({ ok: true, stagingId: 'st9', status: 'failed', match: null, error: null }).href, '#review/rejected/st9');
  assert.equal(urlOutcome({ ok: true, stagingId: 'st9', status: 'needsLocal', existing: true }).href, '#review/needsLocal/st9');
  assert.equal(manualOutcome({ ok: true, mugId: 'm1', slug: 'luna-teapot', created: true }).href, '/mug/?luna-teapot');
  assert.equal(manualOutcome({ ok: true, outcome: 'unchanged', mugId: 'm1' }).href, '#catalog/edit/m1');
});

test('paste preview: the shared parser, rendered escaped', () => {
  const text = `https://www.amazon.com/dp/B0ABCDEFGH\nPaladone Astro Bot Shaped Mug, 450ml ${EVIL}\nDishwasher safe`;
  const html = pastePreview(fromPaste(text, { now: 1 }));
  assert.ok(html.includes('Preview'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('amazon:B0ABCDEFGH'));
  assert.match(pastePreview({ ok: false, code: 'no-name', message: 'The product has no name.' }), /no name/);
});

test('outcome notes never link to a javascript: URL', () => {
  assert.ok(!outcome({ text: 'x', href: 'javascript:alert(1)', linkText: 'go' }).includes('href='));
  assert.ok(outcome({ text: 'x', href: '#review/pending/a', linkText: 'go' }).includes('href="#review/pending/a"'));
  assert.equal(extLink('javascript:alert(1)', 'shop'), 'shop');
  assert.match(extLink('https://shop.example/p', 'shop'), /rel="noopener noreferrer nofollow"/);
  assert.equal(httpUrl('data:text/html,hi'), '');
  assert.ok(factsList({ brand: EVIL }).includes('&lt;img'));
});

test('sources: the runner command, the form, and save arguments', () => {
  const msg = 'This shop refuses cloud fetching. On your workstation run: node runner/mug-runner.mjs scan silver-buffalo';
  assert.equal(runnerCommand(msg, 'x'), 'node runner/mug-runner.mjs scan silver-buffalo');
  assert.equal(runnerCommand('', 'just-funky'), 'node runner/mug-runner.mjs scan just-funky');
  const note = scanOutcome({ ok: false, code: 'use-runner', message: msg }, { slug: 'silver-buffalo' });
  assert.match(note.extra, /<code class="admin-code">node runner\/mug-runner\.mjs scan silver-buffalo<\/code>/);
  assert.equal(note.text, 'This shop refuses cloud fetching. On your workstation run:');
  assertLabelled(sourceFormHtml());
  assert.deepEqual(sourceArgs({ sourceId: '', name: ' ABY ', brand: '', adapter: 'shopify', baseUrl: 'https://aby.example', entryUrls: 'https://aby.example/c/mugs\n', include: 'mug, tasse,', exclude: '', fetchVia: 'cloud', watch: true, enabled: false, notes: '' }), {
    name: 'ABY', brand: '', adapter: 'shopify', baseUrl: 'https://aby.example', entryUrls: ['https://aby.example/c/mugs'], include: ['mug', 'tasse'], exclude: [], fetchVia: 'cloud', watch: true, enabled: false, notes: '',
  });
  const manual = sourceCard({ _id: 's1', slug: 'amazon', name: 'Amazon', adapter: 'manual', baseUrl: 'https://www.amazon.com', entryUrls: [], include: [], exclude: [], fetchVia: 'cloud', watch: false, enabled: true, notes: EVIL, brand: null, lastRun: null });
  assert.match(manual, /Manual: paste or type/);
  assert.ok(!manual.includes('data-act="probe"') && !manual.includes('data-act="scan"'), 'nothing to probe or scan on a manual source');
  assert.ok(!manual.includes('<img src=x'));
});

test('runs: counters, Cancel while active, the error escaped', () => {
  const run = { _id: 'r1', kind: 'scan', target: 'https://shop.example/c', trigger: 'manual', status: 'extracting', entryIndex: 0, page: 2, discovered: 40, staged: 12, unchanged: 3, skipped: 1, needsLocal: 2, failed: 1, error: EVIL, createdAt: 1, updatedAt: 2, source: { slug: 's', name: 'Shop' } };
  const html = runCard(run);
  assert.ok(isActive(run));
  assert.ok(html.includes('data-act="cancel"'));
  for (const label of ['Discovered', 'Staged', 'Unchanged', 'Skipped', 'Needs runner', 'Failed']) assert.ok(html.includes(label));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!runCard({ ...run, status: 'ready' }).includes('data-act="cancel"'));
});

test('catalog: what is asked for and how it reads', () => {
  assert.deepEqual(listArgs({ q: 'joker', status: 'hidden', imageState: 'failed' }), { paginationOpts: { numItems: 24, cursor: null }, q: 'joker', status: 'hidden' });
  assert.deepEqual(listArgs({ q: '', status: 'hidden', imageState: 'blocked' }), { paginationOpts: { numItems: 24, cursor: null }, imageState: 'blocked' });
  assert.deepEqual(listArgs({ q: 'j', status: '', imageState: '' }, 'c1', 10), { paginationOpts: { numItems: 10, cursor: 'c1' } });
  assert.match(describeFilters({ q: 'joker', imageState: 'failed' }), /image filter does not apply/);
  assert.match(describeFilters({ q: '', status: '', imageState: '' }), /Published mugs/);
  const images = [
    { store: 'r2', hasThumb: true, source: 'javascript:alert(1)', w: 800, h: 800, resolved: { src: 'https://img.example/o/1.jpg', thumb: 'https://img.example/t/1.webp' } },
    { store: 'convex', hasThumb: false, source: null, resolved: null },
  ];
  const rows = imageRows(images, [1, 0], []);
  assert.ok(rows.indexOf('data-index="1"') < rows.indexOf('data-index="0"'), 'rows follow the order being edited');
  assert.match(rows, /data-act="img-up" disabled/);
  assert.ok(!rows.includes('javascript:'));
  assert.match(imageRows(images, [0], [1]), /data-removed/);
});

test('community and runner: photos, tokens, and where the runner talks to', () => {
  const photo = photoCard({ id: 'p1', image: { src: 'javascript:alert(1)', thumb: 'javascript:alert(1)' }, caption: EVIL, createdAt: 1, mug: { slug: 'm', name: 'Mug' }, owner: { handle: 'ana', name: null, published: false } });
  assert.ok(!photo.includes('javascript:'));
  assert.ok(!photo.includes('<img src=x'));
  assert.ok(photo.includes('href="/u/?ana"'));
  assert.equal(siteUrlFor('https://happy-otter-123.convex.cloud'), 'https://happy-otter-123.convex.site');
  assert.equal(siteUrlFor('http://127.0.0.1:3210'), 'http://127.0.0.1:3211');
  assert.equal(siteUrlFor('http://localhost:3210'), 'http://localhost:3211');
  assert.equal(siteUrlFor('https://evil.example'), null);
  assert.ok(!tokenRow({ id: 't1', label: EVIL, prefix: 'mugr_abcd1234', createdAt: 1, lastUsedAt: null, revokedAt: 2 }).includes('data-act="revoke"'));
  assert.equal(waitingText({ queue: { needsLocal: 1 }, images: { blocked: 0 } }), '1 page waits for the runner.');
  assert.equal(waitingText({ queue: { needsLocal: 0 }, images: { blocked: 2 } }), 'The images of 2 mugs wait for the runner.');
});
