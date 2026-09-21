// js/backend.js names every Convex function a page may call. This reads the
// real exports in convex/*.ts and fails when a name there is missing or has
// changed kind, so a rename is one failing test instead of a dead button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FN } from '../js/backend.js';

const PUBLIC_KINDS = new Set(['query', 'mutation', 'action']);

function exportsOf(module) {
  const source = readFileSync(new URL(`../convex/${module}.ts`, import.meta.url), 'utf8');
  const found = new Map();
  for (const m of source.matchAll(/export const (\w+) = (query|mutation|action|internalQuery|internalMutation|internalAction)\(/g)) {
    found.set(m[1], m[2]);
  }
  return found;
}

test('every FN name is a public Convex function that exists', () => {
  for (const [module, names] of Object.entries(FN)) {
    const exported = exportsOf(module);
    for (const [key, ref] of Object.entries(names)) {
      assert.equal(ref, `${module}:${key}`, `FN.${module}.${key} must be named ${module}:${key}`);
      assert.ok(exported.has(key), `convex/${module}.ts has no export ${key}`);
      assert.ok(PUBLIC_KINDS.has(exported.get(key)), `${ref} is ${exported.get(key)}: a browser cannot call it`);
    }
  }
});

test('every public function in an admin module checks for an admin first', () => {
  for (const module of ['sources', 'runs', 'staging', 'importer', 'mugs', 'images', 'moderation', 'runnerTokens']) {
    const source = readFileSync(new URL(`../convex/${module}.ts`, import.meta.url), 'utf8');
    for (const m of source.matchAll(/export const (\w+) = (query|mutation|action)\(\{[\s\S]*?handler: async \(ctx[^)]*\) => \{([\s\S]{0,400})/g)) {
      assert.ok(/requireAdmin\(ctx\)|isAdminSubject\(/.test(m[3]), `${module}:${m[1]} must check for an admin before anything else`);
    }
  }
});
