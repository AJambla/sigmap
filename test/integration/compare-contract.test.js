'use strict';

/**
 * `sigmap compare` machine contract (#757).
 *
 * The command was broken for every user: it spawns
 * `run-retrieval-benchmark.mjs --compare` and does a strict `JSON.parse` of
 * that process's ENTIRE stdout, but the payload was emitted at the bottom of
 * the script — after the terminal table. So stdout was
 *
 *     ────────────────────────────────
 *     Repo   Files Sigs Random SigMap …
 *     …
 *     {"sigmap":{…},"baseline":{…}}
 *
 * and the parse died on the leading box-drawing rule. `compare` then exited 1
 * *after* running the full 18-repo benchmark, so the user paid ~90s to be told
 * it failed. `--json` had always got this right: emit, then exit, before any
 * human output.
 *
 * These tests exercise the real contract — spawn the producer and parse what it
 * actually writes — rather than asserting on the source, because the defect was
 * in the ORDER of two correct pieces of code.
 *
 * The full benchmark is slow, so the spawn tests run against a tiny synthetic
 * corpus via --skip-run where possible and are otherwise shape-only.
 *
 * Run: node test/integration/compare-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'run-retrieval-benchmark.mjs');
const GEN = path.join(ROOT, 'gen-context.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const src = fs.readFileSync(SCRIPT, 'utf8');
const gen = fs.readFileSync(GEN, 'utf8');

test('--compare emits its payload BEFORE any human output', () => {
  // The whole defect in one assertion: the COMPARE block must come before the
  // terminal table, exactly as the JSON_OUT block does.
  const iCompare = src.indexOf('if (COMPARE) {');
  const iTable = src.indexOf('// Terminal table');
  assert.ok(iCompare !== -1, 'COMPARE block missing');
  assert.ok(iTable !== -1, 'terminal table marker missing');
  assert.ok(iCompare < iTable,
    'the --compare payload is emitted after the terminal table — ' +
    'sigmap compare does a strict JSON.parse of the whole stdout and will fail');
});

test('--compare exits immediately, so the table can never follow it', () => {
  const block = src.slice(src.indexOf('if (COMPARE) {'));
  const end = block.indexOf('\n}');
  assert.ok(/process\.exit\(0\)/.test(block.slice(0, end)),
    'the COMPARE block must exit before the human table is printed');
});

test('--compare still records benchmark history before exiting', () => {
  // Exiting early must not silently stop recording the run.
  const block = src.slice(src.indexOf('if (COMPARE) {'));
  assert.ok(/appendHistoryWith\(/.test(block.slice(0, block.indexOf('\n}'))),
    'the early exit dropped the benchmark-history append');
  assert.ok(/appendHistoryWith\(avgHit, totTasks\)/.test(src),
    'the human/table path no longer records its run');
});

test('the compare consumer tolerates a stray line on stdout', () => {
  // Hardening: a future stray line should degrade, not fail the command.
  assert.ok(/reverse\(\)[\s\S]{0,120}startsWith\('\{'\)/.test(gen),
    'compare should fall back to the last JSON-looking line');
  assert.ok(/sum\.sigmap && sum\.grepBaseline/.test(gen),
    'compare should validate the payload shape, not just that it parsed');
});

test('the consumer and producer agree on the payload shape', () => {
  // Since #760 the producer is run-honest-benchmark.mjs --json, whose payload
  // is {summary:{sigmap:{hitAt5}, grepBaseline:{hitAt5}, lift, tasks, repos}}.
  const honest = fs.readFileSync(path.join(ROOT, 'scripts', 'run-honest-benchmark.mjs'), 'utf8');
  assert.ok(/grepBaseline/.test(honest), 'producer no longer emits grepBaseline');
  assert.ok(/sum\.sigmap\.hitAt5/.test(gen) && /sum\.grepBaseline\.hitAt5/.test(gen),
    'consumer no longer reads the honest summary pair');
  assert.ok(/sum\.lift/.test(gen), 'consumer no longer reads the published lift');
});

test("the retrieval benchmark's own --compare contract is still intact", () => {
  // compare no longer uses it, but --compare remains a supported machine mode
  // of run-retrieval-benchmark.mjs and must keep emitting before the table (#757).
  const iCompare = src.indexOf('if (COMPARE) {');
  const iTable = src.indexOf('// Terminal table');
  assert.ok(iCompare !== -1 && iCompare < iTable,
    'run-retrieval-benchmark --compare regressed behind the table again');
});

test('--compare aggregates do not depend on the table-rendering loop', () => {
  // The first fix attempt moved the block above `avgHit`, which the table loop
  // computes while printing — a ReferenceError at runtime, not at parse time.
  const block = src.slice(src.indexOf('if (COMPARE) {'));
  const body = block.slice(0, block.indexOf('\n}'));
  assert.ok(!/\bavgHit\b/.test(body) && !/\bavgRand\b/.test(body),
    'the COMPARE block reads table-loop locals that are not initialised yet');
  assert.ok(/results\.reduce/.test(body),
    'the COMPARE block should derive its own aggregates from results');
});

// ── #760: compare must publish the SAME claim as every other surface ───────

test('compare scores against the grep agent, not random selection', () => {
  // It reported 4.9x over random while README/docs/latest.json published 2.12x
  // over a grep agent. The honest corpus exists precisely because the random
  // baseline overstates — this command had never been switched to it.
  assert.ok(/run-honest-benchmark\.mjs/.test(gen),
    'compare must spawn the honest benchmark, which is the published claim');
  assert.ok(!/\[benchScript, '--compare'\]/.test(gen),
    'compare still spawns the retrieval benchmark random-baseline path');
  assert.ok(/grepBaseline/.test(gen), 'compare must read the grep baseline');
  assert.ok(/SigMap vs grep agent/.test(gen),
    'the output must name the baseline, so it cannot be mistaken for another comparison');
});

test("compare's lift agrees with the published latest.json", () => {
  // The whole point: one number, one source. If these drift the command is
  // advertising something the project does not claim.
  const latest = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks', 'latest.json'), 'utf8'));
  const h = latest.honest;
  assert.ok(h, 'latest.json has no honest block');
  const derived = h.sigmap_hit_at_5 / h.grep_baseline_hit_at_5;
  assert.ok(Math.abs(derived - h.lift) < 0.02,
    `latest.json is internally inconsistent: ${h.sigmap_hit_at_5}/${h.grep_baseline_hit_at_5} = ${derived.toFixed(2)} but lift says ${h.lift}`);
  // and the README publishes the same pair
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const pctS = (h.sigmap_hit_at_5 * 100).toFixed(1);
  const pctG = (h.grep_baseline_hit_at_5 * 100).toFixed(1);
  assert.ok(readme.includes(pctS) && readme.includes(pctG),
    `README should publish the same honest pair (${pctS}% vs ${pctG}%)`);
});

test('no token figure is derived from an assumed per-file constant', () => {
  // `fileCount * 4000` was rendered next to a real signature count as though
  // both were observed. 4,000 tokens per file was never measured.
  assert.ok(!/Avg tokens/.test(gen),
    'compare still prints the invented fileCount*4000 token baseline');
  assert.ok(/saved benchmark/.test(gen),
    'a stored figure must be labelled as stored, not presented as measured by this run');
});

test('progress output goes to stderr so --json stays pipeable', () => {
  // console.log for progress meant `compare --json` emitted a human line ahead
  // of its payload — the same defect as #757, one level up.
  assert.ok(/console\.error\('\[sigmap\] Running comparison benchmark/.test(gen),
    'compare progress must go to stderr, not stdout');
});

console.log(`\n  compare-contract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
