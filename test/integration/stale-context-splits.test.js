'use strict';

/**
 * Generated split files from a previous strategy must not survive (#555).
 *
 * `.github/context-*.md` splits are discovered by filename pattern at read
 * time, not by consulting the config, so a file left by an earlier `strategy`
 * — or by a module since dropped from `srcDirs` — keeps being merged into the
 * retrieval index and silently steers every query. Observed on a 524-file Java
 * repo: a stale 376 KB `context-mall-mbg.md` held ranks 1, 3 and 4 with
 * generated entities while both files implementing the feature fell outside
 * the top 6 — and `sig-index.json` correctly held zero entries for it.
 *
 * The read side cannot simply filter these out: under `per-module` the splits
 * are the ONLY place signatures live (#534). So the fix is at generate time.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');
const { buildSigIndex } = require(path.join(ROOT, 'src/retrieval/ranker'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

/** A repo with two modules; returns its path. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-stale-'));
  for (const mod of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(dir, 'src', mod), { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, 'src', mod, `f${i}.js`),
        `function ${mod}_fn${i}(a, b) {\n  return a;\n}\nmodule.exports.${mod}_fn${i} = ${mod}_fn${i};\n`);
    }
  }
  return dir;
}

function configure(dir, cfg) {
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify(cfg));
}
function generate(dir) {
  return execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}
function splits(dir) {
  try {
    return fs.readdirSync(path.join(dir, '.github'))
      .filter((f) => /^context-[\w.-]+\.md$/.test(f)).sort();
  } catch (_) { return []; }
}

test('per-module writes split files', () => {
  const dir = repo();
  configure(dir, { srcDirs: ['src/alpha', 'src/beta'], strategy: 'per-module', adapters: ['copilot'] });
  generate(dir);
  assert.ok(splits(dir).length > 0, 'per-module wrote no split files');
});

test('switching to full removes the previous strategy splits', () => {
  const dir = repo();
  configure(dir, { srcDirs: ['src/alpha', 'src/beta'], strategy: 'per-module', adapters: ['copilot'] });
  generate(dir);
  assert.ok(splits(dir).length > 0);

  configure(dir, { srcDirs: ['src/alpha'], strategy: 'full', adapters: ['copilot'] });
  generate(dir);
  assert.deepStrictEqual(splits(dir), [], `stale splits survived: ${splits(dir).join(', ')}`);
});

test('a dropped module stops polluting the retrieval index', () => {
  const dir = repo();
  configure(dir, { srcDirs: ['src/alpha', 'src/beta'], strategy: 'per-module', adapters: ['copilot'] });
  generate(dir);

  configure(dir, { srcDirs: ['src/alpha'], strategy: 'full', adapters: ['copilot'] });
  generate(dir);

  const indexed = [...buildSigIndex(dir).keys()];
  const stale = indexed.filter((f) => /[\\/]beta[\\/]/.test(f));
  assert.deepStrictEqual(stale, [],
    `files from a dropped module are still indexed: ${stale.join(', ')}`);
});

test('hot-cold keeps its own cold file', () => {
  const dir = repo();
  configure(dir, { srcDirs: ['src/alpha', 'src/beta'], strategy: 'hot-cold', adapters: ['copilot'] });
  generate(dir);
  const found = splits(dir);
  assert.ok(!found.length || found.includes('context-cold.md'),
    `hot-cold should keep context-cold.md, got: ${found.join(', ')}`);
});

test('regenerating with the same strategy keeps its splits', () => {
  // The prune must not delete the files the active strategy just wrote.
  const dir = repo();
  configure(dir, { srcDirs: ['src/alpha', 'src/beta'], strategy: 'per-module', adapters: ['copilot'] });
  generate(dir);
  const first = splits(dir);
  generate(dir);
  assert.deepStrictEqual(splits(dir), first, 'a same-strategy regeneration lost its own splits');
  assert.ok(first.length > 0, 'expected per-module splits to exist');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
