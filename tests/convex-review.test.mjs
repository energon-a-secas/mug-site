// The review lifecycle against the real schema: stage, match, approve, merge,
// reject, and what a re-scan does to all of it (docs/CONTRACTS.md C7 and A3).
// Cores run on tests/support/fakedb.mjs, which parses convex/schema.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './support/fakedb.mjs';
import { normalizeListing } from '../shared/extract/normalize.js';
import { stageListing, stageUrl, applyExtract } from '../convex/lib/stageCore.ts';
import { approveStaging, mergeStaging, rejectStaging } from '../convex/lib/reviewCore.ts';
import { saveMugEdits, cleanEdits } from '../convex/lib/mugCore.ts';
import { readStat } from '../convex/lib/counters.ts';

const NOW = 1_758_470_400_000;

function listing(overrides = {}, source = {}) {
  const result = normalizeListing({
    source: { platform: 'shopify', via: 'worker', url: 'https://shop.example/products/pikachu-3d-mug', handle: 'pikachu-3d-mug', ...source },
    name: 'Pikachu 3D Mug',
    brand: 'ABYstyle',
    capacityMl: 475,
    price: { amount: 19.99, currency: 'EUR' },
    images: ['https://cdn.shop.example/p1.jpg', 'https://cdn.shop.example/p2.jpg'],
    ...overrides,
  }, { now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.listing;
}

async function run(db) {
  return await db.insert('runs', {
    kind: 'scan', target: 'test', trigger: 'manual', status: 'discovering', entryIndex: 0, page: 1, retries: 0,
    discovered: 0, staged: 0, unchanged: 0, skipped: 0, needsLocal: 0, failed: 0, createdAt: NOW, updatedAt: NOW,
  });
}

test('a new listing is staged, and approving it makes a mug with its counters', async () => {
  const db = createFakeDb();
  const runId = await run(db);
  const staged = await stageListing(db, { listing: listing(), runId, now: NOW });
  assert.equal(staged.outcome, 'staged');
  const row = (await db.rows('staging'))[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.match.kind, 'new');
  assert.equal((await db.get(runId)).staged, 1);

  const approved = await approveStaging(db, { stagingId: row._id, subject: 'admin', now: NOW + 1 });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.created, true);
  assert.equal(approved.scheduleImages, true);
  const mug = await db.get(approved.mugId);
  assert.equal(mug.slug, 'pikachu-3d-mug');
  assert.equal(mug.style, 'sculpted');
  assert.equal(mug.capacityMl, 475);
  assert.equal(mug.imageState, 'pending');
  assert.deepEqual(mug.pendingImages, ['https://cdn.shop.example/p1.jpg', 'https://cdn.shop.example/p2.jpg']);
  assert.deepEqual(mug.lastPrice, { amount: 19.99, currency: 'EUR', at: NOW + 1 });
  assert.equal(mug.links[0].label, 'shop.example');
  const franchise = (await db.rows('franchises'))[0];
  assert.equal(franchise.name, 'Pokemon');
  assert.equal(franchise.mugCount, 1);
  const brand = (await db.rows('brands'))[0];
  assert.equal(brand.name, 'ABYstyle');
  assert.equal(brand.mugCount, 1);
  assert.equal(await readStat(db, 'mugs'), 1);
  assert.equal(await readStat(db, 'style:sculpted'), 1);
  const source = (await db.rows('mugSources'))[0];
  assert.equal(source.key, 'shop.example/products/pikachu-3d-mug');
  assert.equal(source.seen.price, '19.99 EUR');
  assert.equal((await db.get(row._id)).status, 'approved');
});

test('a re-scan of an unchanged page stages nothing, even after the admin renamed the mug (A3)', async () => {
  const db = createFakeDb();
  const first = await stageListing(db, { listing: listing(), now: NOW });
  const approved = await approveStaging(db, { stagingId: first.stagingId, subject: 'admin', now: NOW });
  const mug = await db.get(approved.mugId);
  await saveMugEdits(db, mug, (cleanEdits({ name: 'Pikachu Head Mug' })).edits, NOW + 5);
  assert.equal((await db.get(approved.mugId)).name, 'Pikachu Head Mug');

  const again = await stageListing(db, { listing: listing(), now: NOW + 10 });
  assert.equal(again.outcome, 'unchanged');
  assert.equal(db.count('staging'), 1, 'only the first, approved row');
  assert.equal((await db.rows('mugSources'))[0].lastSeenAt, NOW + 10);
});

test('a price change at the shop is "changed"; approving it updates the price and keeps the curated name', async () => {
  const db = createFakeDb();
  const first = await stageListing(db, { listing: listing(), now: NOW });
  const { mugId } = await approveStaging(db, { stagingId: first.stagingId, subject: 'admin', now: NOW });
  await saveMugEdits(db, await db.get(mugId), cleanEdits({ name: 'Pikachu Head Mug' }).edits, NOW + 1);

  const changed = await stageListing(db, { listing: listing({ price: { amount: 24.99, currency: 'EUR' } }), now: NOW + 2 });
  assert.equal(changed.outcome, 'staged');
  const row = await db.get(changed.stagingId);
  assert.equal(row.match.kind, 'changed');
  assert.deepEqual(row.match.fields, ['price']);

  const result = await approveStaging(db, { stagingId: row._id, subject: 'admin', now: NOW + 3 });
  assert.equal(result.created, false);
  const mug = await db.get(mugId);
  assert.equal(mug.lastPrice.amount, 24.99);
  assert.equal(mug.name, 'Pikachu Head Mug', 'price was the only change, so the name stays');
  assert.equal(db.count('mugs'), 1);
  assert.equal((await db.rows('mugSources'))[0].seen.price, '24.99 EUR');
});

test('the same barcode from another shop links a second source and stages nothing', async () => {
  const db = createFakeDb();
  const first = await stageListing(db, { listing: listing({ gtin: '3665361123453' }), now: NOW });
  // 3665361123453 must verify for this to mean anything.
  assert.equal((await db.get(first.stagingId)).listing.gtin, '3665361123453');
  const { mugId } = await approveStaging(db, { stagingId: first.stagingId, subject: 'admin', now: NOW });

  const other = listing({ gtin: '3665361123453', name: 'Mug 3D Pikachu 460ml' }, { url: 'https://retailer.example/products/abystyle-pikachu', handle: 'abystyle-pikachu' });
  const linked = await stageListing(db, { listing: other, now: NOW + 1 });
  assert.equal(linked.outcome, 'linked');
  assert.equal(linked.mugId, mugId);
  const sources = await db.rows('mugSources');
  assert.deepEqual(sources.map((s) => s.key).sort(), ['retailer.example/products/abystyle-pikachu', 'shop.example/products/pikachu-3d-mug']);
  assert.equal(db.count('staging'), 1);
});

test('same name words without a code are "similar"; approving makes a second mug with a branded slug', async () => {
  const db = createFakeDb();
  const first = await stageListing(db, { listing: listing(), now: NOW });
  await approveStaging(db, { stagingId: first.stagingId, subject: 'admin', now: NOW });

  const lookalike = listing({ brand: 'Paladone', name: 'Pikachu 3D Mug', price: undefined }, { url: 'https://paladone.example/products/pikachu-mug', handle: 'pikachu-mug' });
  const staged = await stageListing(db, { listing: lookalike, now: NOW + 1 });
  const row = await db.get(staged.stagingId);
  assert.equal(row.match.kind, 'similar');
  const result = await approveStaging(db, { stagingId: row._id, subject: 'admin', now: NOW + 2 });
  assert.equal(result.created, true);
  assert.equal(result.slug, 'pikachu-3d-mug-paladone');
  assert.equal(db.count('mugs'), 2);
  assert.equal(await readStat(db, 'mugs'), 2);
});

test('a listing that is not a mug is skipped and counted', async () => {
  const db = createFakeDb();
  const runId = await run(db);
  const plush = listing({ name: 'Pikachu Plush', capacityMl: undefined });
  assert.equal(plush.isMug.verdict, 'no');
  assert.equal((await stageListing(db, { listing: plush, runId, now: NOW })).outcome, 'skipped');
  assert.equal(db.count('staging'), 0);
  assert.equal((await db.get(runId)).skipped, 1);
});

test('a blocked page goes to the runner, and what the runner reads becomes a pending row', async () => {
  const db = createFakeDb();
  const runId = await run(db);
  assert.equal(await stageUrl(db, { url: 'https://shop.example/p/joker-head-3d-mug?ref=x', runId, now: NOW }), 'queued');
  assert.equal(await stageUrl(db, { url: 'https://shop.example/p/joker-head-3d-mug', runId, now: NOW }), 'duplicate');
  const row = (await db.rows('staging'))[0];
  assert.equal(row.key, 'shop.example/p/joker-head-3d-mug');

  const blocked = await applyExtract(db, { stagingId: row._id, error: { code: 'UPSTREAM_BLOCKED', message: '403' }, now: NOW + 1 });
  assert.equal(blocked.outcome, 'needsLocal');
  assert.equal((await db.get(row._id)).status, 'needsLocal');
  assert.equal((await db.get(runId)).needsLocal, 1);

  const read = listing({ name: 'DC Comics Joker Head 3D Mug', brand: 'ABYstyle', price: undefined, capacityMl: undefined }, { platform: 'jsonld', via: 'runner', url: 'https://shop.example/p/joker-head-3d-mug', handle: undefined });
  const done = await applyExtract(db, { stagingId: row._id, listing: read, now: NOW + 2 });
  assert.equal(done.outcome, 'pending');
  const pending = await db.get(row._id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.listing.character, 'Joker');
  assert.equal(pending.attempts, 2);
});

test('the runner failing a page it was sent fails it; retryable errors are retried once', async () => {
  const db = createFakeDb();
  await stageUrl(db, { url: 'https://shop.example/p/a', now: NOW });
  await stageUrl(db, { url: 'https://shop.example/p/b', now: NOW });
  const [a, b] = await db.rows('staging');
  await applyExtract(db, { stagingId: a._id, error: { code: 'UPSTREAM_BLOCKED', message: '403' }, now: NOW });
  assert.equal((await applyExtract(db, { stagingId: a._id, error: { code: 'UPSTREAM_BLOCKED', message: '403 again' }, now: NOW })).outcome, 'failed');

  assert.equal((await applyExtract(db, { stagingId: b._id, error: { code: 'UPSTREAM_TIMEOUT', message: 'slow' }, now: NOW })).outcome, 'retry');
  assert.equal((await db.get(b._id)).status, 'queued');
  assert.equal((await applyExtract(db, { stagingId: b._id, error: { code: 'UPSTREAM_TIMEOUT', message: 'slow' }, now: NOW })).outcome, 'failed');
  assert.equal((await applyExtract(db, { stagingId: b._id, error: { code: 'UPSTREAM_TIMEOUT', message: 'late' }, now: NOW })).outcome, 'not-open');
});

test('robots and not-a-product failures are final, never sent to the runner', async () => {
  const db = createFakeDb();
  await stageUrl(db, { url: 'https://shop.example/p/c', now: NOW });
  const row = (await db.rows('staging'))[0];
  assert.equal((await applyExtract(db, { stagingId: row._id, error: { code: 'ROBOTS_DISALLOWED', message: 'no' }, now: NOW })).outcome, 'failed');
  assert.equal((await db.get(row._id)).error.code, 'ROBOTS_DISALLOWED');
});

test('merging into a chosen mug fills blanks and adds images, and keeps curated fields', async () => {
  const db = createFakeDb();
  const first = await stageListing(db, { listing: listing({ images: [], capacityMl: undefined, material: undefined }), now: NOW });
  const { mugId } = await approveStaging(db, { stagingId: first.stagingId, subject: 'admin', edits: { name: 'Pikachu (curated)' }, now: NOW });
  const before = await db.get(mugId);
  assert.equal(before.imageState, 'none');
  assert.equal(before.capacityMl, undefined);

  const other = listing({ name: 'Mug Pikachu', material: 'ceramic' }, { url: 'https://other.example/products/mug-pikachu', handle: 'mug-pikachu' });
  const staged = await stageListing(db, { listing: other, now: NOW + 1 });
  const merged = await mergeStaging(db, { stagingId: staged.stagingId, mugId, subject: 'admin', now: NOW + 2 });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.scheduleImages, true);
  const after = await db.get(mugId);
  assert.equal(after.name, 'Pikachu (curated)');
  assert.equal(after.capacityMl, 475);
  assert.equal(after.material, 'ceramic');
  assert.equal(after.pendingImages.length, 2);
  assert.equal(after.imageState, 'pending');
  assert.equal(after.links.length, 2);
  assert.equal(db.count('mugs'), 1);
});

test('reject closes a row once; edits are validated before anything is written', async () => {
  const db = createFakeDb();
  const staged = await stageListing(db, { listing: listing(), now: NOW });
  const bad = await approveStaging(db, { stagingId: staged.stagingId, subject: 'admin', edits: { gtin: '1234567890123' }, now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-gtin');
  assert.equal(db.count('mugs'), 0);
  assert.equal((await approveStaging(db, { stagingId: staged.stagingId, subject: 'admin', edits: { style: 'goblet' }, now: NOW })).code, 'bad-style');

  assert.equal((await rejectStaging(db, { stagingId: staged.stagingId, subject: 'admin', now: NOW })).ok, true);
  assert.equal((await rejectStaging(db, { stagingId: staged.stagingId, subject: 'admin', now: NOW })).code, 'closed');
  assert.equal((await approveStaging(db, { stagingId: staged.stagingId, subject: 'admin', now: NOW })).code, 'not-pending');
});

test('hiding a published mug takes it out of every count, and publishing it again puts it back', async () => {
  const db = createFakeDb();
  const staged = await stageListing(db, { listing: listing(), now: NOW });
  const { mugId } = await approveStaging(db, { stagingId: staged.stagingId, subject: 'admin', now: NOW });
  await saveMugEdits(db, await db.get(mugId), cleanEdits({ status: 'hidden' }).edits, NOW + 1);
  assert.equal(await readStat(db, 'mugs'), 0);
  assert.equal(await readStat(db, 'style:sculpted'), 0);
  assert.equal((await db.rows('brands'))[0].mugCount, 0);
  await saveMugEdits(db, await db.get(mugId), cleanEdits({ status: 'published', style: 'shaped' }).edits, NOW + 2);
  assert.equal(await readStat(db, 'mugs'), 1);
  assert.equal(await readStat(db, 'style:sculpted'), 0);
  assert.equal(await readStat(db, 'style:shaped'), 1);
  assert.equal((await db.rows('brands'))[0].mugCount, 1);
});
