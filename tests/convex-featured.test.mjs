// A16: the catalogue's default order puts sculpted and shaped mugs first.
// featuredKey is pure, and createMug and applyMugPatch keep it in step on the
// fake database, which parses the real schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { featuredKey } from '../convex/lib/catalogue.ts';
import { applyMugPatch, createMug } from '../convex/lib/mugCore.ts';
import { createFakeDb } from './support/fakedb.mjs';

const NOW = 1790000000000;

test('sculpted and shaped outrank every other style, newest first within a style', () => {
  const older3d = featuredKey('sculpted', NOW - 1e9);
  const newerPrinted = featuredKey('printed', NOW);
  assert.ok(older3d > newerPrinted, 'a year-old 3D mug still comes before a printed one from today');
  assert.equal(featuredKey('shaped', NOW), featuredKey('sculpted', NOW), 'shaped and sculpted share the top rank');
  assert.ok(featuredKey('relief', NOW) < featuredKey('shaped', NOW - 1e9));
  assert.ok(featuredKey('relief', NOW) > featuredKey('stein', NOW));
  assert.ok(featuredKey('stein', NOW) > featuredKey('travel', NOW));
  assert.ok(featuredKey('sculpted', NOW) > featuredKey('sculpted', NOW - 1), 'newest first within a rank');
  assert.equal(featuredKey(undefined, NOW), featuredKey('other', NOW));
});

test('a created mug carries its key, and a style change moves it', async () => {
  const db = createFakeDb();
  const listing = { name: 'Luna 3D Mug', brand: 'ABYstyle', style: 'printed', source: { platform: 'manual' } };
  const mug = await createMug(db, listing, {}, NOW);
  assert.equal(mug.featured, featuredKey('printed', NOW));
  const moved = await applyMugPatch(db, mug, { style: 'sculpted' }, NOW + 5);
  assert.equal((await db.get(mug._id)).featured, featuredKey('sculpted', NOW), 'publishedAt is kept, only the rank moves');
  assert.equal(moved.featured, featuredKey('sculpted', NOW));
});

test('hiding and republishing a mug dates its key from the republish', async () => {
  const db = createFakeDb();
  const mug = await createMug(db, { name: 'Tiki Mug', style: 'tiki', source: { platform: 'manual' } }, {}, NOW);
  const hidden = await applyMugPatch(db, mug, { status: 'hidden' }, NOW + 10);
  await applyMugPatch(db, hidden, { status: 'published' }, NOW + 20);
  assert.equal((await db.get(mug._id)).featured, featuredKey('tiki', NOW + 20));
});
