// The Worker and Convex deploy separately, and Convex decides what to do with
// a failed fetch by its `code` alone (docs/CONTRACTS.md C3). A code the Worker
// sends that Convex does not know is turned into INTERNAL, which would retry
// a robots refusal. This holds the two lists equal, the resume-forge pattern
// (docs/architecture/cloudflare-workers.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES } from '../worker/src/errors.js';
import { PROXY_CODES } from '../convex/lib/proxy.ts';
import { BLOCKED_CODES, RETRY_CODES } from '../convex/lib/stageCore.ts';
import { FETCH_ERROR_CODES } from '../shared/net/polite.js';

test('Convex knows exactly the codes the Worker can send', () => {
  assert.deepEqual([...PROXY_CODES].sort(), [...ERROR_CODES].sort());
});

test('every code politeFetch can produce is a Worker code', () => {
  for (const code of FETCH_ERROR_CODES) assert.ok(ERROR_CODES.includes(code), code);
});

test('the staging rules only name codes that exist', () => {
  for (const code of [...BLOCKED_CODES, ...RETRY_CODES]) assert.ok(ERROR_CODES.includes(code), code);
});

test('A12: the envelope carries retryable only as a literal true', async () => {
  const { envelope } = await import('../worker/src/errors.js');
  assert.equal(envelope('ROBOTS_DISALLOWED', 'robots.txt answered 503', { retryable: true }).retryable, true);
  assert.equal('retryable' in envelope('ROBOTS_DISALLOWED', 'Disallow: /', {}), false);
  assert.equal('retryable' in envelope('ROBOTS_DISALLOWED', 'x', { retryable: 'yes' }), false, 'only a boolean true passes');
});
