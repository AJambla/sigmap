'use strict';

/**
 * rank() must be invariant under signature-index insertion order (#596).
 *
 * The index is written recent-commits-first (`diffPriority`), so its insertion
 * order changes with git history depth: a shallow CI checkout hoists nothing
 * while a developer clone hoists the last-10-commits set. The graph hop-1 loop
 * used to evaluate its seed condition (`score > 0`) WHILE mutating scores in
 * place, so a zero-scored file boosted by an earlier-visited seed became a
 * seed itself — but only when it sat after its booster in the index. Same
 * files, same graph, different git depth: graphBoost totals differed by whole
 * multiples of the boost constants and the gate read 72.2% in CI vs 73.3%
 * locally for the same commit.
 *
 * These tests run the SAME index content through rank() in opposite insertion
 * orders and require identical output. The fixture is shaped so the old
 * cascade fires: a (matches query) → b (zero score) → c (zero score). With
 * a,b,c order, b was boosted before being visited and seeded c; with c,b,a
 * order it never did.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { rank } = require(path.join(ROOT, 'src/retrieval/ranker'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const CWD = path.join('/tmp', 'sigmap-order-test');
const abs = (rel) => path.resolve(CWD, rel);

// a matches the query; b, c, e deliberately share no token with it except e,
// which must stay positive to prove legitimate hop-2 boosts still apply.
const ENTRIES = [
  ['src/a.js', ['function alphaParser(input)  :1-10', 'module.exports = { alphaParser }  :12-12']],
  ['src/b.js', ['function quietMiddle(x)  :1-5']],
  ['src/c.js', ['function quietLeaf(y)  :1-5']],
  ['src/e.js', ['function alphaEmitter(ev)  :1-8']],
];

// a → b → {c, e}. No `reverse` map on purpose: with a 4-file graph the 20%
// hub threshold is 1 and every file with an edge would be hub-suppressed.
const GRAPH = {
  forward: new Map([
    [abs('src/a.js'), [abs('src/b.js')]],
    [abs('src/b.js'), [abs('src/c.js'), abs('src/e.js')]],
  ]),
};

function runOrder(entries) {
  const index = new Map(entries);
  return rank('alpha parser', index, { topK: 10, cwd: CWD, graph: GRAPH, learned: false });
}

function byFile(results) {
  const m = new Map();
  for (const r of results) m.set(r.file, r);
  return m;
}

const fwd = runOrder(ENTRIES);
const rev = runOrder([...ENTRIES].reverse());

test('identical results regardless of index insertion order', () => {
  const a = fwd.map((r) => [r.file, r.score]);
  const b = rev.map((r) => [r.file, r.score]);
  assert.deepStrictEqual(a, b,
    `order changed ranking:\n  fwd ${JSON.stringify(a)}\n  rev ${JSON.stringify(b)}`);
});

test('a hop-1-boosted zero-score file does not seed further boosts', () => {
  for (const [label, results] of [['fwd', fwd], ['rev', rev]]) {
    const c = byFile(results).get('src/c.js');
    const boost = (c && c.signals.graphBoost) || 0;
    assert.strictEqual(boost, 0,
      `${label}: src/c.js got graphBoost ${boost} — its only path to a boost is a cascade through zero-scored src/b.js`);
  }
});

test('hop-1 boost on the direct neighbor of a seed still applies', () => {
  for (const [label, results] of [['fwd', fwd], ['rev', rev]]) {
    const b = byFile(results).get('src/b.js');
    assert.ok(b && b.signals.graphBoost > 0,
      `${label}: src/b.js is a direct neighbor of seeded src/a.js and must keep its hop-1 boost`);
  }
});

test('hop-2 boost on a positively-scored file still applies', () => {
  for (const [label, results] of [['fwd', fwd], ['rev', rev]]) {
    const e = byFile(results).get('src/e.js');
    assert.ok(e && e.signals.graphBoost > 0,
      `${label}: src/e.js scores on its own and is 2 hops from the seed — it must keep its hop-2 boost`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
