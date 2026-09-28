'use strict';

/**
 * Adversarial extractor corpus (#702).
 *
 * `--diagnose-extractors` reported **36 fixtures, 36 pass, 0 fail** while ten
 * languages corrupt, truncate or drop declarations on shapes that appear in
 * ordinary code. The corpus was broad (one fixture per language) but shallow:
 * happy-path only, so it could not detect corruption. Worse, the committed
 * `test/expected/ruby.txt` had RATIFIED a duplicate signature — the suite was
 * asserting a bug was correct (#735).
 *
 * This suite closes that. `test/fixtures-adversarial/` exercises the shapes that
 * actually break regex extractors; `test/expected-adversarial/` snapshots what
 * each one produces TODAY; `test/adversarial-defects.json` records which of
 * those lines are wrong, what the correct signature is, and which issue owns it.
 *
 * The ledger is load-bearing in both directions:
 *   - behaviour drifts with no ledger update  → snapshot mismatch, fails
 *   - a language gets FIXED                   → snapshot mismatch, fails, which
 *                                               forces the ledger entry out
 * so `defects: []` is a positive claim, and the ledger cannot rot into fiction.
 *
 * Run: node test/integration/adversarial-fixtures.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures-adversarial');
const EXPECTED = path.join(ROOT, 'test', 'expected-adversarial');
const LEDGER = path.join(ROOT, 'test', 'adversarial-defects.json');

const { extractFile } = require(path.join(ROOT, 'src', 'extractors', 'dispatch'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const fixtures = fs.readdirSync(FIXTURES).sort();
const langOf = (f) => f.replace(/\.[^.]+$/, '');

// ── 1. Snapshots are exact ────────────────────────────────────────────────────

test('every adversarial fixture has a committed snapshot', () => {
  for (const f of fixtures) {
    const snap = path.join(EXPECTED, `${langOf(f)}.txt`);
    assert.ok(fs.existsSync(snap), `missing snapshot for ${f} — run the regen step in the PR body`);
  }
});

for (const f of fixtures) {
  const lang = langOf(f);
  test(`${lang}: output is byte-identical to its snapshot`, () => {
    const src = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    const actual = extractFile(path.join(FIXTURES, f), src).join('\n');
    const expected = fs.readFileSync(path.join(EXPECTED, `${lang}.txt`), 'utf8').replace(/\n$/, '');
    assert.strictEqual(actual, expected,
      `extraction changed for ${lang}.\n`
      + `If this is a FIX, update test/expected-adversarial/${lang}.txt AND remove the\n`
      + `        corresponding entry from test/adversarial-defects.json.`);
  });
}

// ── 2. The ledger describes reality ──────────────────────────────────────────

test('every fixture language is classified in the ledger', () => {
  for (const f of fixtures) {
    assert.ok(ledger.languages[langOf(f)], `${langOf(f)} has no ledger entry`);
  }
});

test('every ledger defect names a kind, an owning issue, and the correct output', () => {
  const KINDS = new Set(['corrupted', 'truncated', 'dropped', 'fidelity']);
  for (const [lang, entry] of Object.entries(ledger.languages)) {
    assert.ok(typeof entry.tier === 'string' && entry.tier, `${lang}: missing tier`);
    assert.ok(Array.isArray(entry.defects), `${lang}: defects must be an array`);
    for (const d of entry.defects) {
      assert.ok(d.case, `${lang}: defect missing case`);
      assert.ok(KINDS.has(d.kind), `${lang}/${d.case}: bad kind "${d.kind}"`);
      assert.ok(Number.isInteger(d.issue), `${lang}/${d.case}: missing owning issue`);
      assert.ok(d.shouldBe, `${lang}/${d.case}: missing shouldBe`);
      assert.ok(d.note, `${lang}/${d.case}: missing note`);
    }
  }
});

test('each declared defect still reproduces in the snapshot', () => {
  for (const [lang, entry] of Object.entries(ledger.languages)) {
    const snapPath = path.join(EXPECTED, `${lang}.txt`);
    if (!fs.existsSync(snapPath)) continue;
    const snap = fs.readFileSync(snapPath, 'utf8');
    for (const d of entry.defects) {
      if (d.kind === 'dropped') {
        // A dropped declaration must be ABSENT from the snapshot.
        assert.ok(!snap.includes(d.case),
          `${lang}/${d.case}: ledger says dropped, but it appears in the snapshot — the defect is fixed, remove the entry`);
      } else {
        assert.ok(snap.includes(d.actual.trim()),
          `${lang}/${d.case}: ledger 'actual' not found in snapshot — ledger is stale.\n        expected to find: ${d.actual.trim()}`);
      }
    }
  }
});

test('a clean language really is clean — no defect lines hiding in its snapshot', () => {
  for (const [lang, entry] of Object.entries(ledger.languages)) {
    if (entry.defects.length) continue;
    const snapPath = path.join(EXPECTED, `${lang}.txt`);
    if (!fs.existsSync(snapPath)) continue;
    const snap = fs.readFileSync(snapPath, 'utf8');
    assert.ok(snap.trim().length, `${lang} claims 0 defects but its snapshot is empty`);
    // Unbalanced parens or a stray arrow are the signatures of corruption.
    for (const line of snap.split('\n').filter(Boolean)) {
      // Delimiters inside a STRING literal are data, not structure — PHP's
      // `function stringDelims($sep = ")")` is correct output, and counting the
      // quoted `)` made the check contradict the very fix it guards.
      const structural = line.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '""');
      const open = (structural.match(/\(/g) || []).length;
      const close = (structural.match(/\)/g) || []).length;
      assert.strictEqual(open, close,
        `${lang} claims 0 defects but a snapshot line is unbalanced: ${line}`);
      // `→` followed LATER by `->` is the defect signature: Swift rendered
      // `func f(cb) → Int, n: Int) -> Int`, splicing the rest of the real
      // parameter list on after the arrow. The reverse order is legitimate —
      // Rust's `Box<dyn Fn(i32) -> i32>) → i32` has the `->` inside the
      // closure TYPE, which is the correct rendering.
      assert.ok(!/→[^→]*->/.test(line),
        `${lang} claims 0 defects but an arrow is followed by a second notation: ${line}`);
    }
  }
});

// ── 3. The corpus is adversarial, not a second happy path ────────────────────

test('the corpus covers the shapes that break regex extractors', () => {
  const all = fixtures.map((f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8')).join('\n');
  const shapes = {
    'nested call in a default': /=\s*[gG]\(1,\s*2\)/,
    'closure/function-typed param': /Fn\(|Function\(|Func<|func\(int\)|\(Int\) ->|Int => Int/,
    'nested generics': /<[^>\n]*<[^>\n]*>/,
    'string literal containing a delimiter': /"\)"/,
    'collection default': /=\s*[[{]/,
  };
  for (const [name, re] of Object.entries(shapes)) {
    assert.ok(re.test(all), `corpus does not exercise: ${name}`);
  }
});

test('at least one control language handles the adversarial cases cleanly', () => {
  const clean = Object.entries(ledger.languages).filter(([, e]) => !e.defects.length).map(([l]) => l);
  assert.ok(clean.length >= 2,
    `expected >=2 clean control languages, got ${clean.length} — without controls the corpus cannot show the defects are real`);
  for (const lang of clean) {
    // A clean language earns it either by using the shared balanced scanner or
    // by being a real AST tier (Python parses with CPython's own ast module).
    const tier = ledger.languages[lang].tier;
    assert.ok(/shared balanced scanner|balanced|^1 — AST/.test(tier),
      `${lang} is clean but its tier explains neither a scanner nor an AST: "${tier}"`);
  }
});

// ── 4. #696: PHP declaration on the <?php line ───────────────────────────────

test('php: a declaration sharing the <?php line now extracts (#696)', () => {
  // Previously yielded NOTHING at all: the top-level scan was anchored at
  // column 0 and the opening tag occupied it.
  const out = extractFile('a.php', '<?php function f($a) { return 1; }');
  const ownLine = extractFile('a.php', '<?php\nfunction f($a) { return 1; }');
  assert.ok(ownLine.length > 0, 'own-line <?php should extract — baseline broken');
  assert.deepStrictEqual(out.map((s) => s.replace(/\s+:\d+-\d+$/, '')), ['function f($a)'],
    'same-line <?php must extract the declaration');
  assert.ok(/:1-1$/.test(out[0]), `anchor must stay on line 1, got "${out[0]}"`);
});

// ── 5. The happy-path corpus must not ratify a bug again ─────────────────────

test('no committed expectation contains a duplicate signature (#735)', () => {
  for (const dir of [path.join(ROOT, 'test', 'expected'), EXPECTED]) {
    for (const f of fs.readdirSync(dir)) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
      const trimmed = lines.map((l) => l.trim());
      const dupes = trimmed.filter((l, i) => trimmed.indexOf(l) !== i && /^(def|function|fun|func) /.test(l));
      assert.strictEqual(dupes.length, 0,
        `${path.basename(dir)}/${f} asserts a duplicated signature as correct: ${[...new Set(dupes)].join(', ')}`);
    }
  }
});

console.log(`\n  adversarial-fixtures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
