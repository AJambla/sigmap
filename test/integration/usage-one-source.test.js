'use strict';

/**
 * One read path for run history (#773).
 *
 * Four surfaces published a token-reduction figure and no two were comparable:
 *
 *   --health   "no history", 0 runs      read usage.ndjson
 *   gain       2,047 operations, 96.5%   read gain.ndjson
 *   budget     142 ops, session window   read gain.ndjson, windowed
 *   --report   97.6%                     this run only
 *
 * The cause was not arithmetic. `tracking` defaults to FALSE so
 * `.context/usage.ndjson` is never written — and that is the store `--health`,
 * `history` and the dashboard read, while `recordUsage` writes
 * `.context/gain.ndjson` unconditionally. Three surfaces looked empty because
 * they read the one store nobody fills.
 *
 * Differing numbers are still expected: 524 generate runs, 2,047 operations and
 * a session window are different populations. The requirement is that they come
 * from one source and each says which — the same rule #762 established for
 * coverage.
 *
 * Run: node test/integration/usage-one-source.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const GEN = path.join(ROOT, 'gen-context.js');
const SRC = require(path.join(ROOT, 'src', 'tracking', 'usage-source'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/** A repo with a gain log only — the default shape, tracking off. */
function repo({ gain = [], usage = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-usage-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function a(x) { return x; }\nmodule.exports = { a };\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'] }));
  const ctx = path.join(dir, '.context');
  fs.mkdirSync(ctx, { recursive: true });
  if (gain.length) fs.writeFileSync(path.join(ctx, 'gain.ndjson'), gain.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (usage) fs.writeFileSync(path.join(ctx, 'usage.ndjson'), usage.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

const gainRun = (ts, baseline, actual, pct) =>
  ({ ts, v: '8.52.2', op: 'generate', session: ts.slice(0, 10), baselineTokens: baseline, actualTokens: actual, savedPct: pct, ok: true });
const gainAsk = (ts) =>
  ({ ts, v: '8.52.2', op: 'ask', session: ts.slice(0, 10), baselineTokens: 100, actualTokens: 10, savedPct: 90, ok: true });

const run = (dir, args) => {
  try { return execFileSync(process.execPath, [GEN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

// ── the reported defect ─────────────────────────────────────────────────────

test('--health reports runs from the store that is actually written', () => {
  // tracking defaults to false, so usage.ndjson never exists. Before #773 this
  // printed "no history / 0 runs" on a repo with hundreds of gain entries.
  const dir = repo({ gain: [gainRun('2026-09-29T10:00:00.000Z', 1000, 100, 90),
                            gainRun('2026-09-29T11:00:00.000Z', 2000, 100, 95)] });
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.context', 'usage.ndjson')),
      'fixture must not have the tracked store — that is the whole point');
    const out = run(dir, ['--health']);
    assert.ok(!/no history/.test(out), '--health still reports "no history" with a populated gain log');
    assert.ok(/total runs\s+:\s*2\b/.test(out), `expected 2 runs, got: ${out.match(/total runs.*/)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history is non-empty wherever gain is', () => {
  const dir = repo({ gain: [gainRun('2026-09-29T10:00:00.000Z', 1000, 100, 90)] });
  try {
    const out = run(dir, ['history']);
    assert.ok(!/No runs recorded yet/.test(out), 'history claims no runs while gain has one');
    assert.ok(/90%/.test(out), 'the recorded reduction should appear');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history does not print "(last 1 runs)" for an empty log', () => {
  // `Math.max(last.length, 1)` reported one run when there were none.
  const dir = repo({});
  try {
    const out = run(dir, ['history']);
    assert.ok(!/last 1 runs/.test(out), 'empty log still renders as one run');
    assert.ok(/no runs recorded/i.test(out), 'an empty log should say so');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── one source, and every figure names its population ───────────────────────

test('all four surfaces read the one source', () => {
  const dir = repo({ gain: [gainRun('2026-09-29T10:00:00.000Z', 1000, 100, 90),
                            gainRun('2026-09-29T11:00:00.000Z', 1000, 100, 90)] });
  try {
    for (const [label, args, expect] of [
      ['--health', ['--health'], /total runs\s+:\s*2\b/],
      ['history',  ['history'],  /of 2 runs/],
      ['gain',     ['gain'],     /Total operations/],
      ['budget',   ['budget'],   /ops/],
    ]) {
      const out = run(dir, args);
      assert.ok(expect.test(out), `${label} did not reflect the shared source: ${out.slice(0, 200)}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every reduction figure names its baseline and window', () => {
  const dir = repo({ gain: [gainRun('2026-09-29T10:00:00.000Z', 1000, 100, 90)] });
  try {
    const health = run(dir, ['--health']);
    assert.ok(/vs whole-file baseline/.test(health), '--health reduction must name its baseline');
    assert.ok(/mean of \d+ generate run/.test(health), '--health reduction must name its window');
    const hist = run(dir, ['history']);
    assert.ok(/of \d+ runs/.test(hist), 'history must name the window it is showing');
    const gain = run(dir, ['gain']);
    assert.ok(/baseline/i.test(gain), 'gain must name its baseline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── populations stay distinct ───────────────────────────────────────────────

test('ask operations are not counted as generate runs', () => {
  // gain records both; conflating them is how one log described itself as
  // both "2,047" and "525".
  const dir = repo({ gain: [gainRun('2026-09-29T10:00:00.000Z', 1000, 100, 90),
                            gainAsk('2026-09-29T10:05:00.000Z'),
                            gainAsk('2026-09-29T10:06:00.000Z')] });
  try {
    assert.strictEqual(SRC.readRuns(dir).length, 1, 'ask entries leaked into the run population');
    assert.ok(/total runs\s+:\s*1\b/.test(run(dir, ['--health'])), '--health counted ask operations as runs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a field the source store does not record renders as unknown, not zero', () => {
  // gain records no fileCount/overBudget. Rendering them as 0/no is the same
  // defect #764 fixed in `bench --submit`.
  const dir = repo({ gain: [gainRun('2026-09-29T10:00:00.000Z', 1000, 100, 90)] });
  try {
    const [rec] = SRC.readRuns(dir);
    assert.strictEqual(rec.fileCount, null, 'unrecorded fileCount must stay null');
    assert.strictEqual(rec.overBudget, null, 'unrecorded overBudget must stay null');
    assert.ok(/—/.test(run(dir, ['history'])), 'history should render unknown fields as —');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('both stores merge, and a run logged to both is counted once', () => {
  const ts = '2026-09-29T10:00:00.000Z';
  const dir = repo({
    gain:  [gainRun(ts, 1000, 100, 90)],
    usage: [{ ts, version: '8.52.2', fileCount: 4, rawTokens: 1000, finalTokens: 100, reductionPct: 90, overBudget: false }],
  });
  try {
    const runs = SRC.readRuns(dir);
    assert.strictEqual(runs.length, 1, 'the same run was counted twice across stores');
    assert.strictEqual(runs[0].fileCount, 4, 'the richer tracked record should win');
    const d = SRC.describeSource(dir);
    assert.deepStrictEqual(d.stores, ['usage.ndjson', 'gain.ndjson'], 'both stores should be reported');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n  usage-one-source: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
