// A17: collectors propose corrections to a mug's labels; an admin decides.
// The core runs on the fake database, which parses the real schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { featuredKey } from '../convex/lib/catalogue.ts';
import { createMug } from '../convex/lib/mugCore.ts';
import { ensureProfile } from '../convex/lib/profilesCore.ts';
import {
  createSuggestion, currentLabels, decideSuggestion, labelChanges, mySuggestion, pendingSuggestions,
} from '../convex/lib/suggestionsCore.ts';
import { createFakeDb } from './support/fakedb.mjs';

const NOW = 1790000000000;
const ALICE = 'user_alice';
const ADMIN = 'user_admin';

async function setup() {
  const db = createFakeDb();
  const listing = { name: 'Joker Head Mug', brand: 'ABYstyle', style: 'printed', capacityMl: 350, source: { platform: 'manual' } };
  const mug = await createMug(db, listing, {}, NOW);
  return { db, mug };
}

test('labelChanges: labels only, each checked, and only what differs', async () => {
  const { db, mug } = await setup();
  const current = await currentLabels(db, mug);
  assert.equal(labelChanges({ sku: 'X1' }, current).code, 'bad-field', 'a SKU is not a label');
  assert.equal(labelChanges({ style: 'melted' }, current).code, 'bad-style');
  assert.equal(labelChanges({ capacityMl: 9 }, current).code, 'bad-capacity');
  assert.equal(labelChanges({ name: '' }, current).code, 'bad-name', 'a name cannot be cleared');
  assert.equal(labelChanges({ style: 'printed', brand: 'ABYstyle', capacityMl: 350 }, current).code, 'no-change');
  const r = labelChanges({ style: 'sculpted', brand: 'ABYstyle', franchise: 'DC Comics', capacityMl: '' }, current);
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, { style: 'sculpted', franchise: 'DC Comics', capacityMl: null }, 'an emptied field proposes clearing it');
});

test('a proposal waits as pending; a second one from the same collector replaces it', async () => {
  const { db, mug } = await setup();
  const first = await createSuggestion(db, { subject: ALICE, mug, changes: { style: 'sculpted' }, note: 'It is a 3D head', now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.replaced, false);
  const second = await createSuggestion(db, { subject: ALICE, mug, changes: { style: 'shaped', character: 'Joker' }, now: NOW + 1 });
  assert.equal(second.replaced, true);
  assert.equal(second.id, first.id);
  const row = await db.get(first.id);
  assert.deepEqual(row.changes, { style: 'shaped', character: 'Joker' });
  assert.equal(row.note, undefined, 'the replacement carries its own note, or none');
  assert.deepEqual((await mySuggestion(db, mug._id, ALICE)).fields.sort(), ['character', 'style']);
  assert.equal(await mySuggestion(db, mug._id, 'user_bob'), null);
});

test('refused: a hidden mug, a suspended collector, and a day over the allowance', async () => {
  const { db, mug } = await setup();
  await db.patch(mug._id, { status: 'hidden' });
  assert.equal((await createSuggestion(db, { subject: ALICE, mug: await db.get(mug._id), changes: { style: 'tiki' }, now: NOW })).code, 'not-found');
  await db.patch(mug._id, { status: 'published' });
  const profile = await ensureProfile(db, 'user_mallory', NOW);
  await db.patch(profile._id, { suspended: true });
  assert.equal((await createSuggestion(db, { subject: 'user_mallory', mug, changes: { style: 'tiki' }, now: NOW })).code, 'suspended');
  for (let i = 0; i < 30; i++) {
    const r = await createSuggestion(db, { subject: 'user_eager', mug, changes: { capacityMl: 300 + i }, now: NOW + i });
    assert.equal(r.ok, true, `send ${i + 1}`);
  }
  assert.equal((await createSuggestion(db, { subject: 'user_eager', mug, changes: { capacityMl: 400 }, now: NOW + 31 })).code, 'rate-limited');
});

test('approving applies the change the way an admin edit does: style moves the featured key, a new franchise appears', async () => {
  const { db, mug } = await setup();
  const s = await createSuggestion(db, { subject: ALICE, mug, changes: { style: 'sculpted', franchise: 'DC Comics', character: 'Joker' }, now: NOW });
  assert.equal((await db.query('franchises').collect()).length, 0, 'nothing is created before approval');
  const r = await decideSuggestion(db, { id: s.id, approve: true, admin: ADMIN, now: NOW + 100 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied.sort(), ['character', 'franchise', 'style']);
  const after = await db.get(mug._id);
  assert.equal(after.style, 'sculpted');
  assert.equal(after.character, 'Joker');
  assert.equal(after.featured, featuredKey('sculpted', mug.publishedAt));
  const franchises = await db.query('franchises').collect();
  assert.deepEqual(franchises.map((f) => [f.name, f.mugCount]), [['DC Comics', 1]]);
  const row = await db.get(s.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.decidedBy, ADMIN);
  assert.equal((await decideSuggestion(db, { id: s.id, approve: true, admin: ADMIN, now: NOW + 101 })).code, 'decided');
});

test('rejecting records the reason and leaves the mug alone; an already-true proposal approves as a no-op', async () => {
  const { db, mug } = await setup();
  const s = await createSuggestion(db, { subject: ALICE, mug, changes: { style: 'tiki' }, now: NOW });
  const r = await decideSuggestion(db, { id: s.id, approve: false, admin: ADMIN, reason: 'It is not a tiki mug', now: NOW + 5 });
  assert.equal(r.status, 'rejected');
  assert.equal((await db.get(s.id)).reason, 'It is not a tiki mug');
  assert.equal((await db.get(mug._id)).style, 'printed');

  const t = await createSuggestion(db, { subject: 'user_bob', mug, changes: { capacityMl: 400 }, now: NOW + 10 });
  await db.patch(mug._id, { capacityMl: 400 });
  const u = await decideSuggestion(db, { id: t.id, approve: true, admin: ADMIN, now: NOW + 20 });
  assert.equal(u.ok, true);
  assert.deepEqual(u.applied, [], 'the admin already made that change');
});

test("the admin's queue shows each field as it is and as proposed, oldest first", async () => {
  const { db, mug } = await setup();
  const profile = await ensureProfile(db, ALICE, NOW);
  await db.patch(profile._id, { handle: 'alice' });
  await createSuggestion(db, { subject: ALICE, mug, changes: { style: 'sculpted' }, note: 'A 3D head', now: NOW });
  await createSuggestion(db, { subject: 'user_bob', mug, changes: { capacityMl: 450 }, now: NOW + 1 });
  const queue = await pendingSuggestions(db);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue[0].changes, [{ field: 'style', from: 'printed', to: 'sculpted' }]);
  assert.equal(queue[0].by.handle, 'alice');
  assert.equal(queue[0].note, 'A 3D head');
  assert.deepEqual(queue[1].changes, [{ field: 'capacityMl', from: 350, to: 450 }]);
  assert.equal(queue[1].by, null, 'a collector with no profile yet');
  assert.equal(queue[0].mug.slug, mug.slug);
});
