// The stored listing validator (convex/lib/listing.ts) and the normaliser's
// vocabulary (shared/contract.js) describe one shape, C1. A field or a
// literal added on one side only would either be rejected on insert or
// silently never filled; this fails first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LISTING_FIELDS, SOURCE_FIELDS, STYLES, MATERIALS, PLATFORMS, VIAS } from '../shared/contract.js';

const source = readFileSync(new URL('../convex/lib/listing.ts', import.meta.url), 'utf8');

function block(name) {
  const start = source.indexOf(`export const ${name}`);
  assert.ok(start >= 0, `listing.ts has no ${name}`);
  const next = source.indexOf('export const', start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

const literals = (name) => [...block(name).matchAll(/v\.literal\("([^"]+)"\)/g)].map((m) => m[1]);

test('listingValidator has exactly the C1 fields, and its source exactly the source fields', () => {
  const body = block('listingValidator');
  const top = [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual([...top].sort(), [...LISTING_FIELDS].sort());
  const start = body.indexOf('source: v.object({');
  const inner = body.slice(start, body.indexOf('}),', start));
  const sourceFields = [...inner.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual([...sourceFields].sort(), [...SOURCE_FIELDS].sort());
});

test('the vocabularies match literal for literal', () => {
  assert.deepEqual(literals('styleValidator'), [...STYLES]);
  assert.deepEqual(literals('materialValidator'), [...MATERIALS]);
  assert.deepEqual(literals('platformValidator'), [...PLATFORMS]);
  for (const via of VIAS) assert.match(block('listingValidator'), new RegExp(`v\\.literal\\("${via}"\\)`));
});
