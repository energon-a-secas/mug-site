// convex/lib/handles.ts is canonical and js/handles.js mirrors it for the
// shelf page. One corpus through both: a rule changed on one side fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../convex/lib/handles.ts';
import * as client from '../js/handles.js';

const CORPUS = [
  'ana', 'Ana-Mugs', '@ana', '%40ana', '  ana  ', 'ab', 'a', '', '12345', '123abc', 'a--b', '-ana', 'ana-',
  'admin', 'mug-admin', 'team-mugs', 'official', 'ne0rg0n', 'energon-fan', 'mugbot', 'mug-b0t', 'abystyle',
  'bigmouth-inc', 'shelf', 'u', 'x'.repeat(30), 'x'.repeat(31), 'tiki-tom', 'pikachu4ever', 'cafe-mugs',
];

test('the client mirror agrees with the server on every handle', () => {
  for (const raw of CORPUS) {
    const s = server.normalizeHandle(raw);
    const c = client.normalizeHandle(raw);
    assert.equal(c, s, `normalizeHandle(${JSON.stringify(raw)})`);
    assert.equal(client.handleProblem(c), server.handleProblem(s), `handleProblem(${JSON.stringify(s)})`);
  }
});

test('the reserved lists and messages are identical', () => {
  assert.deepEqual([...client.RESERVED_HANDLES], [...server.RESERVED_HANDLES]);
  assert.deepEqual([...client.ROLE_WORDS], [...server.ROLE_WORDS]);
  assert.deepEqual([...client.BRANDS], [...server.BRANDS]);
  assert.deepEqual({ ...client.HANDLE_MESSAGES }, { ...server.HANDLE_MESSAGES });
  assert.equal(String(client.HANDLE_RE), String(server.HANDLE_RE));
});
