// Every browser, shared, runner and Worker module parses as an ES module.
// node reads a bare .js as CommonJS, so `node --check` on the file itself
// proves nothing (vitrina learned this when a double comma in an import list
// passed it and the browser refused the whole module graph). Each file is
// copied to .mjs first, which makes node parse it as a module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['js', 'shared', 'runner', 'worker/src', 'scripts'];

// Built from code points so this file itself contains none of them.
const c = (n) => String.fromCharCode(n);
const CONTROL = new RegExp(`[${c(0)}-${c(8)}${c(11)}${c(12)}${c(14)}-${c(31)}]`);
const EM_DASH = c(0x2014);

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const FILES = DIRS.flatMap((d) => walk(join(ROOT, d)));

test('every module parses as an ES module', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mug-syntax-'));
  assert.ok(FILES.length > 20, `expected the site's modules, found ${FILES.length}`);
  for (const file of FILES) {
    const copy = join(scratch, relative(ROOT, file).replace(/[\\/]/g, '__').replace(/\.js$/, '.mjs'));
    copyFileSync(file, copy);
    try {
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`${relative(ROOT, file)} does not parse as a module:\n${String(err.stderr)}`);
    }
  }
});

// Vendored fleet kits (js/neorgon-*.js) are checked for parsing above but not
// for prose: their canonical source is packages/neorgon-ui/, which is where a
// fix belongs, the same exemption scripts/no-em-dash.py makes.
const VENDORED = /(^|[\\/])neorgon-[\w-]+\.js$/;

test('no module of ours carries a raw control character or an em dash', () => {
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!CONTROL.test(text), `${relative(ROOT, file)} has a raw control character`);
    if (VENDORED.test(file)) continue;
    assert.ok(!text.includes(EM_DASH), `${relative(ROOT, file)} contains an em dash`);
  }
});
