'use strict';

/**
 * Token-budget module floor (#743).
 *
 * The budget spent itself strictly best-first across the whole repo, so one
 * module could consume all of it. Measured on akka: `akka-stream` took **all
 * 128 surviving slots** while `akka-actor` (192 files) and `akka-cluster`
 * (28 files) got **zero** — two of three configured `srcDirs` rendered
 * invisible, and every task targeting them failed (hit@5 1.0 → 0.4).
 *
 * Completer extraction makes it worse rather than better: more signatures per
 * file means the leading module exhausts the budget sooner, which is how the
 * v8.51.6 extractor fixes lowered a published number while improving the
 * product.
 *
 * A module may now be thinned but never erased. Two weaker designs were
 * measured and rejected, and the tests below pin the property rather than the
 * tuning: equal round-robin (rails 1.0 → 0.8, gin 1.0 → 0.875) and strictly
 * proportional share (akka 0.4 → 0.2, rails 1.0 → 0.6).
 *
 * Run: node test/integration/budget-module-floor.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const GEN = path.join(ROOT, 'gen-context.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/**
 * Build a repo whose FIRST module is large and signature-dense enough to
 * exhaust a small budget on its own, plus two smaller modules that the old
 * global ordering would have erased entirely.
 */
function makeRepo({ big = 60, small = 12 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-floor-'));
  const write = (mod, i, methods) => {
    const d = path.join(dir, mod, 'src');
    fs.mkdirSync(d, { recursive: true });
    const body = Array.from({ length: methods }, (_, k) =>
      `  ${mod.replace(/-/g, '_')}_m${i}_${k}(a, b) { return a; }`).join('\n');
    fs.writeFileSync(path.join(d, `f${i}.js`), `class C${i} {\n${body}\n}\n`);
  };
  for (let i = 0; i < big; i++) write('mod-big', i, 12);
  for (let i = 0; i < small; i++) write('mod-small', i, 2);
  for (let i = 0; i < small; i++) write('mod-tiny', i, 2);
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({
    srcDirs: ['mod-big', 'mod-small', 'mod-tiny'],
    maxTokens: 4000,
    autoMaxTokens: false,
  }, null, 2));
  return dir;
}

function modulesInContext(dir) {
  const p = path.join(dir, '.github', 'copilot-instructions.md');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/^### (.+)$/gm)) {
    const mod = m[1].split('/')[0];
    out[mod] = (out[mod] || 0) + 1;
  }
  return out;
}

const run = (dir) => execFileSync(process.execPath, [GEN], { cwd: dir, stdio: 'pipe' });

test('no configured module is erased when the budget overflows', () => {
  const dir = makeRepo();
  try {
    run(dir);
    const mods = modulesInContext(dir);
    for (const m of ['mod-big', 'mod-small', 'mod-tiny']) {
      assert.ok((mods[m] || 0) > 0,
        `${m} was erased entirely — budget spent: ${JSON.stringify(mods)}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the budget really did overflow — otherwise the test proves nothing', () => {
  const dir = makeRepo();
  try {
    const out = run(dir).toString() + '';
    const ctx = fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
    const kept = Object.values(modulesInContext(dir)).reduce((a, b) => a + b, 0);
    assert.ok(kept < 84, `expected files to be dropped, kept ${kept} of 84`);
    assert.ok(/omitted|budget/i.test(ctx), 'the artifact should disclose the omission');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the large module still keeps the biggest share', () => {
  // The floor is a foothold, not equal division — a 60-file module must not be
  // levelled with a 12-file one, which is what made round-robin regress.
  const dir = makeRepo();
  try {
    run(dir);
    const mods = modulesInContext(dir);
    assert.ok(mods['mod-big'] >= mods['mod-small'],
      `large module should retain the larger share: ${JSON.stringify(mods)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a single-module repo is unaffected by the floor', () => {
  // The safety property: only genuinely multi-module repos change behaviour.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-floor1-'));
  try {
    const d = path.join(dir, 'src');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < 40; i++) {
      const body = Array.from({ length: 12 }, (_, k) => `  m${i}_${k}(a, b) { return a; }`).join('\n');
      fs.writeFileSync(path.join(d, `f${i}.js`), `class C${i} {\n${body}\n}\n`);
    }
    fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
      JSON.stringify({ srcDirs: ['src'], maxTokens: 4000, autoMaxTokens: false }, null, 2));
    run(dir);
    const mods = modulesInContext(dir);
    assert.deepStrictEqual(Object.keys(mods), ['src'],
      `a single-module repo should yield one module, got ${JSON.stringify(mods)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('output stays deterministic across runs', () => {
  const dir = makeRepo();
  try {
    // The `Updated:` stamp legitimately differs per run; everything else must not.
    const read = () => fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8')
      .replace(/<!-- Updated: [^>]*-->/g, '<!-- Updated -->');
    run(dir);
    const a = read();
    run(dir);
    const b = read();
    assert.strictEqual(a, b, 'budget selection must be reproducible');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n  budget-module-floor: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
