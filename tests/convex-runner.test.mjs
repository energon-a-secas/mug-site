// The runner's image failures (CONTRACTS A9) and the one retry an unreadable
// robots.txt gets (A12), against the real schema on tests/support/fakedb.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './support/fakedb.mjs';
import { normalizeListing } from '../shared/extract/normalize.js';
import { stageListing, stageUrl, applyExtract } from '../convex/lib/stageCore.ts';
import { approveStaging } from '../convex/lib/reviewCore.ts';
import { imageFailure, pendingIndex } from '../convex/lib/runnerCore.ts';
import { imageStateOf } from '../convex/lib/imageState.ts';

const NOW = 1_758_470_400_000;
const A = 'https://cdn.shop.example/a.jpg';
const B = 'https://cdn.shop.example/b.jpg';
const C = 'https://cdn.shop.example/c.jpg';

async function blockedMug(db) {
  const { listing } = normalizeListing({
    source: { platform: 'shopify', via: 'worker', url: 'https://shop.example/products/luna', handle: 'luna' },
    name: 'Sailor Moon Luna Teapot', brand: 'ABYstyle', images: [A, B, C],
  }, { now: NOW });
  const staged = await stageListing(db, { listing, now: NOW });
  const { mugId } = await approveStaging(db, { stagingId: staged.stagingId, subject: 'admin', now: NOW });
  await db.patch(mugId, { imageState: 'blocked' });
  return mugId;
}

test('imageStateOf: what is left decides the state', () => {
  assert.equal(imageStateOf([], [], [], false), 'none');
  assert.equal(imageStateOf([], [A], [], true), 'blocked');
  assert.equal(imageStateOf([], [A], [], false), 'failed');
  assert.equal(imageStateOf([], [], [A], false), 'failed', 'nothing stored and something given up on');
  assert.equal(imageStateOf([{ key: 'o/x' }], [], [A], false), 'thumbs', 'a stored image outranks a failed one');
  assert.equal(imageStateOf([{ key: 'o/x', thumb: 't/x' }], [], [], false), 'ok');
});

test('a runner image failure is found by URL even after positions shift', async () => {
  const db = createFakeDb();
  const mugId = await blockedMug(db);
  // The runner queued B at index 1; A has since landed, so B is at index 0 now.
  await db.patch(mugId, { pendingImages: [B, C] });
  const answer = await imageFailure(db, mugId, 1, B, { code: 'UPSTREAM_BLOCKED', message: '403 from home too' }, NOW);
  assert.equal(answer.ok, true);
  const mug = await db.get(mugId);
  assert.deepEqual(mug.pendingImages, [C], 'B left, C (at the index the runner sent) stayed');
  assert.deepEqual(mug.failedImages, [B]);
  assert.equal(mug.imageState, 'blocked', 'C still waits for the runner');

  await imageFailure(db, mugId, 0, C, { code: 'NOT_AN_IMAGE', message: 'html' }, NOW);
  const after = await db.get(mugId);
  assert.deepEqual(after.pendingImages, []);
  assert.deepEqual(after.failedImages, [B, C]);
  assert.equal(after.imageState, 'failed', 'nothing stored, two given up on');
});

test('without a URL the position is used, and a stale report is refused', async () => {
  const db = createFakeDb();
  const mugId = await blockedMug(db);
  assert.equal(pendingIndex(await db.get(mugId), 2), 2);
  assert.equal((await imageFailure(db, mugId, 2, undefined, { code: 'X', message: 'y' }, NOW)).ok, true);
  assert.deepEqual((await db.get(mugId)).pendingImages, [A, B]);
  assert.equal((await imageFailure(db, mugId, 5, undefined, { code: 'X', message: 'y' }, NOW)).code, 'not-pending');
  assert.equal((await imageFailure(db, mugId, 0, 'https://elsewhere.example/z.jpg', { code: 'X', message: 'y' }, NOW)).code, 'not-pending');
  assert.equal((await imageFailure(db, mugId, 0, A, undefined, NOW)).code, 'bad-body', 'an image item only reports errors here');
});

test('A12: an unreadable robots.txt is retried once; a real Disallow is final', async () => {
  const db = createFakeDb();
  await stageUrl(db, { url: 'https://shop.example/p/one', now: NOW });
  await stageUrl(db, { url: 'https://shop.example/p/two', now: NOW });
  const [one, two] = await db.rows('staging');
  const unreadable = { code: 'ROBOTS_DISALLOWED', message: 'robots.txt answered 503', retryable: true };
  assert.equal((await applyExtract(db, { stagingId: one._id, error: unreadable, now: NOW })).outcome, 'retry');
  assert.equal((await db.get(one._id)).status, 'queued');
  assert.equal((await applyExtract(db, { stagingId: one._id, error: unreadable, now: NOW })).outcome, 'failed', 'one retry only');
  const rule = { code: 'ROBOTS_DISALLOWED', message: 'Disallow: /p/' };
  assert.equal((await applyExtract(db, { stagingId: two._id, error: rule, now: NOW })).outcome, 'failed', 'a real rule is never retried');
});
