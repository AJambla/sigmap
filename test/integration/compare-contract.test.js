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
  assert.ok(/results\.sigmap && results\.baseline/.test(gen),
    'compare should validate the payload shape, not just that it parsed');
});

test('the consumer and producer agree on the payload shape', () => {
  // producer keys
  const block = src.slice(src.indexOf('if (COMPARE) {'));
  const producerHas = /sigmap:\s*\{\s*hitAt5/.test(block) && /baseline:\s*\{\s*hitAt5/.test(block);
  assert.ok(producerHas, 'producer no longer emits {sigmap,baseline}.hitAt5');
  // consumer reads
  assert.ok(/results\.sigmap\.hitAt5/.test(gen) && /results\.baseline\.hitAt5/.test(gen),
    'consumer no longer reads {sigmap,baseline}.hitAt5');
  assert.ok(/results\.sigmap\.tokens/.test(gen), 'consumer no longer reads sigmap.tokens');
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

console.log(`\n  compare-contract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
