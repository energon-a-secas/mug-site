// Shelves, profiles and the publishing gate against the real schema
// (docs/CONTRACTS.md C9). Counters must move with every transition, and a
// shelf must stay invisible until both the deployment and its owner say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './support/fakedb.mjs';
import { normalizeListing } from '../shared/extract/normalize.js';
import { stageListing } from '../convex/lib/stageCore.ts';
import { approveStaging } from '../convex/lib/reviewCore.ts';
import { saveMugEdits, cleanEdits } from '../convex/lib/mugCore.ts';
import { setShelfState, updateShelfItem } from '../convex/lib/shelfCore.ts';
import { claimHandle, setPublished, visibleProfile, isListed, profileOf, updateProfile } from '../convex/lib/profilesCore.ts';
import { handleProblem, normalizeHandle } from '../convex/lib/handles.ts';
import { readStat } from '../convex/lib/counters.ts';

const NOW = 1_758_470_400_000;
const OPEN = { PUBLISHING: 'open' };
const CLOSED = {};

async function mug(db, name = 'Pikachu 3D Mug', handle = 'pikachu-3d-mug') {
  const { listing } = normalizeListing({
    source: { platform: 'shopify', via: 'worker', url: `https://shop.example/products/${handle}`, handle },
    name,
    brand: 'ABYstyle',
  }, { now: NOW });
  const staged = await stageListing(db, { listing, now: NOW });
  const approved = await approveStaging(db, { stagingId: staged.stagingId, subject: 'admin', now: NOW });
  return approved.mugId;
}

test('owning, wanting and removing move the mug, profile and community counters together', async () => {
  const db = createFakeDb();
  const id = await mug(db);
  assert.equal((await setShelfState(db, { subject: 'ana', mugId: id, state: 'owned', now: NOW })).changed, true);
  let m = await db.get(id);
  let p = await profileOf(db, 'ana');
  assert.deepEqual([m.ownedCount, m.wantedCount, p.ownedCount, p.wantedCount], [1, 0, 1, 0]);
  assert.equal(await readStat(db, 'owned'), 1);

  assert.equal((await setShelfState(db, { subject: 'ana', mugId: id, state: 'owned', now: NOW })).changed, false, 'no-op is not a write');
  await setShelfState(db, { subject: 'ana', mugId: id, state: 'wanted', now: NOW });
  m = await db.get(id);
  p = await profileOf(db, 'ana');
  assert.deepEqual([m.ownedCount, m.wantedCount, p.ownedCount, p.wantedCount], [0, 1, 0, 1]);

  await setShelfState(db, { subject: 'ana', mugId: id, state: 'had', now: NOW });
  m = await db.get(id);
  assert.deepEqual([m.ownedCount, m.wantedCount], [0, 0], 'a mug you once had counts as neither');

  await setShelfState(db, { subject: 'bo', mugId: id, state: 'owned', now: NOW });
  await setShelfState(db, { subject: 'ana', mugId: id, state: null, now: NOW });
  m = await db.get(id);
  assert.deepEqual([m.ownedCount, m.wantedCount], [1, 0]);
  assert.equal(db.count('shelfItems'), 1);
  assert.equal(await readStat(db, 'owned'), 1);
});

test('a hidden mug can leave a shelf but cannot join one', async () => {
  const db = createFakeDb();
  const id = await mug(db);
  await setShelfState(db, { subject: 'ana', mugId: id, state: 'owned', now: NOW });
  await saveMugEdits(db, await db.get(id), cleanEdits({ status: 'hidden' }).edits, NOW);
  assert.equal((await setShelfState(db, { subject: 'bo', mugId: id, state: 'owned', now: NOW })).code, 'no-mug');
  assert.equal((await setShelfState(db, { subject: 'ana', mugId: id, state: null, now: NOW })).ok, true);
  assert.equal((await setShelfState(db, { subject: 'ana', mugId: 'mugs:999', state: 'owned', now: NOW })).code, 'no-mug');
});

test('shelf writes are rate limited per collector', async () => {
  const db = createFakeDb();
  const id = await mug(db);
  let last;
  for (let i = 0; i < 241; i++) {
    last = await setShelfState(db, { subject: 'ana', mugId: id, state: i % 2 ? 'wanted' : 'owned', now: NOW + i });
  }
  assert.equal(last.code, 'rate-limited');
  assert.match(last.message, /Try again in/);
  assert.equal((await setShelfState(db, { subject: 'bo', mugId: id, state: 'owned', now: NOW })).ok, true, 'limits are per subject');
});

test('shelf item details are validated', async () => {
  const db = createFakeDb();
  const id = await mug(db);
  assert.equal((await updateShelfItem(db, { subject: 'ana', mugId: id, patch: { note: 'x' }, now: NOW })).code, 'not-on-shelf');
  await setShelfState(db, { subject: 'ana', mugId: id, state: 'owned', now: NOW });
  assert.equal((await updateShelfItem(db, { subject: 'ana', mugId: id, patch: { condition: 'pristine' }, now: NOW })).code, 'bad-condition');
  assert.equal((await updateShelfItem(db, { subject: 'ana', mugId: id, patch: { acquiredOn: '2026-13-45' }, now: NOW })).code, 'bad-date');
  assert.equal((await updateShelfItem(db, { subject: 'ana', mugId: id, patch: { currency: 'dollars' }, now: NOW })).code, 'bad-currency');
  const ok = await updateShelfItem(db, {
    subject: 'ana', mugId: id,
    patch: { note: `  from${String.fromCharCode(7)} the con  `, condition: 'boxed', pricePaid: '24.5', currency: 'usd', acquiredOn: '2026-08-01' },
    now: NOW,
  });
  assert.equal(ok.ok, true);
  const item = (await db.rows('shelfItems'))[0];
  assert.deepEqual([item.note, item.condition, item.pricePaid, item.currency, item.acquiredOn], ['from the con', 'boxed', 24.5, 'USD', '2026-08-01']);
});

test('handles: normalised, validated, reserved and unique', async () => {
  assert.equal(normalizeHandle('  @Ana-Mugs '), 'ana-mugs');
  assert.equal(normalizeHandle('%40ana'), 'ana');
  assert.equal(handleProblem('ab'), 'handle-invalid');
  assert.equal(handleProblem('12345'), 'handle-invalid');
  assert.equal(handleProblem('a--b'), 'handle-invalid');
  assert.equal(handleProblem('admin'), 'handle-reserved');
  assert.equal(handleProblem('mug-admin'), 'handle-reserved');
  assert.equal(handleProblem('ne0rg0n-fan'), 'handle-reserved');
  assert.equal(handleProblem('abystyle'), 'handle-reserved');
  assert.equal(handleProblem('ana-mugs'), null);

  const db = createFakeDb();
  assert.equal((await claimHandle(db, 'ana', 'Ana-Mugs', NOW)).handle, 'ana-mugs');
  assert.equal((await claimHandle(db, 'bo', 'ana-mugs', NOW)).code, 'handle-taken');
  assert.equal((await claimHandle(db, 'ana', 'ana-mugs', NOW)).ok, true, 'reclaiming your own is fine');
  await claimHandle(db, 'ana', 'ana-two', NOW + 1);
  await claimHandle(db, 'ana', 'ana-three', NOW + 2);
  assert.equal((await claimHandle(db, 'ana', 'ana-four', NOW + 3)).code, 'rate-limited', 'three changes per 30 days');
});

test('publishing is closed until the deployment opens it, and needs a handle', async () => {
  const db = createFakeDb();
  await updateProfile(db, 'ana', { displayName: 'Ana', bio: 'Tiki mugs, mostly.' }, NOW);
  assert.equal((await setPublished(db, 'ana', true, NOW, CLOSED)).code, 'publishing-closed');
  assert.equal((await setPublished(db, 'ana', true, NOW, OPEN)).code, 'no-handle');
  await claimHandle(db, 'ana', 'ana', NOW);
  assert.equal((await setPublished(db, 'ana', true, NOW, OPEN)).published, true);
  assert.equal(await readStat(db, 'collectors'), 1);
  assert.equal((await setPublished(db, 'ana', false, NOW, CLOSED)).published, false, 'unpublishing is always allowed');
  assert.equal(await readStat(db, 'collectors'), 0);
});

test('who sees /u/?handle: the owner always, others only when open, published and not suspended', async () => {
  const db = createFakeDb();
  await claimHandle(db, 'ana', 'ana', NOW);
  assert.equal((await visibleProfile(db, 'ana', 'ana', CLOSED)).owner, true);
  assert.equal(await visibleProfile(db, 'bo', 'ana', OPEN), null, 'not published yet');
  await setPublished(db, 'ana', true, NOW, OPEN);
  assert.equal((await visibleProfile(db, null, '@ANA', OPEN)).owner, false);
  assert.equal(await visibleProfile(db, null, 'ana', CLOSED), null, 'closing the deployment hides every shelf');
  assert.equal(await visibleProfile(db, null, { handle: 'ana' }, OPEN), null, 'a non-string handle is refused, not thrown on');
  const profile = await profileOf(db, 'ana');
  assert.equal(isListed(profile, OPEN), true);
  await db.patch(profile._id, { suspended: true });
  assert.equal(await visibleProfile(db, null, 'ana', OPEN), null);
  assert.equal(isListed(await profileOf(db, 'ana'), OPEN), false);
});
