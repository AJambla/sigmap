'use strict';

/**
 * Integration tests for the 2026-09-15 v8.48 full-CLI audit criticals (#709).
 *
 * Tests:
 *  1.  C1 #655: unknown subcommand exits 1 and writes nothing
 *  2.  C1 #655: `bench` without --submit exits 1 and writes nothing
 *  3.  C1 #655: near-miss command suggests the intended one
 *  4.  C1 #655: bare invocation and flag forms still generate
 *  5.  C1 #655: known subcommands are not rejected by the guard
 *  6.  C2 #656: --report --json over budget reports overBudget and exits 1
 *  7.  C2 #656: --report text mode over budget exits 1
 *  8.  C2 #656: under budget exits 0 with overBudget false
 *  9.  C3 #657: penalties decay UP toward 1.0, never deeper
 * 10.  C3 #657: boosts decay DOWN toward 1.0, never below
 * 11.  C3 #657: near-neutral entries are pruned from the store
 * 12.  C4 #658: getImpact renders original-case repo-relative paths
 * 13.  C4 #658: changed-file case survives when the file has no importers
 * 14.  C4 #658: build() exposes realPaths keyed by graph key
 * 15.  C4 #658: CLI --impact --json emits no parent-climbing paths
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const ROOT   = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'gen-context.js');

const { build }     = require('../../src/graph/builder');
const { getImpact } = require('../../src/graph/impact');
const {
  saveWeights,
  loadWeights,
  updateWeights,
} = require('../../src/learning/weights');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

/** A project whose path contains uppercase letters, like every macOS checkout. */
function makeProject(extraConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'SigMap-Audit-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'gen-context.config.json'),
    JSON.stringify(Object.assign({ srcDirs: ['src'] }, extraConfig || {}))
  );
  return dir;
}

/** Every path under `dir`, with contents — a tree fingerprint for write-detection. */
function snapshotTree(dir) {
  const out = [];
  (function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel  = path.relative(dir, full).replace(/\\/g, '/');
      if (e.isDirectory()) { out.push(rel + '/'); walk(full); }
      else out.push(rel + ' ' + fs.readFileSync(full, 'utf8'));
    }
  })(dir);
  return out.join('\n');
}

function cli(dir, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

console.log('[audit-criticals.test.js] v8.48 audit criticals C1-C4 (#655 #656 #657 #658)');
console.log('');

// ---------------------------------------------------------------------------
// C1 - #655: unknown subcommand must not fall through to the generate path
// ---------------------------------------------------------------------------

test('C1: unknown subcommand exits 1 and leaves the tree byte-identical', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');
  const before = snapshotTree(dir);

  for (const args of [['typo'], ['impact', 'src/auth.js'], ['contxt']]) {
    const r = cli(dir, args);
    assert.strictEqual(r.status, 1, `${args.join(' ')} should exit 1, got ${r.status}`);
    assert.match(r.stderr, /unknown command/, `${args.join(' ')} should explain itself`);
  }

  assert.strictEqual(snapshotTree(dir), before, 'unknown command must write nothing');
  fs.rmSync(dir, { recursive: true });
});

test("C1: 'bench' without --submit exits 1 and writes nothing", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');
  const before = snapshotTree(dir);

  const r = cli(dir, ['bench']);
  assert.strictEqual(r.status, 1, 'bench alone should exit 1');
  assert.match(r.stderr, /requires --submit/, 'should name the missing flag');
  assert.strictEqual(snapshotTree(dir), before, 'bench must write nothing');
  fs.rmSync(dir, { recursive: true });
});

test('C1: a near-miss command suggests the intended one', () => {
  const dir = makeProject();
  const r = cli(dir, ['asl', 'login']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Did you mean 'ask'\?/);
  fs.rmSync(dir, { recursive: true });
});

test('C1: bare invocation and flag forms still generate', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');

  const bare = cli(dir, []);
  assert.strictEqual(bare.status, 0, 'bare invocation should still generate');
  assert.ok(fs.existsSync(path.join(dir, '.context')), 'bare run should write context');

  for (const args of [['--query', 'login'], ['--impact', 'src/auth.js'], ['--version']]) {
    const r = cli(dir, args);
    assert.strictEqual(r.status, 0, `${args.join(' ')} should exit 0, got ${r.status}`);
  }
  fs.rmSync(dir, { recursive: true });
});

test('C1: known subcommands are not rejected by the guard', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');
  cli(dir, []); // seed the index so retrieval commands have something to read

  for (const args of [['ask', 'login'], ['weights'], ['status'], ['run']]) {
    const r = cli(dir, args);
    assert.notStrictEqual(r.status, 1,
      `${args.join(' ')} should not be rejected as unknown: ${r.stderr}`);
    assert.doesNotMatch(r.stderr || '', /unknown command/);
  }
  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// C2 - #656: the documented over-budget exit gate must actually fire
// ---------------------------------------------------------------------------

/** A project guaranteed to blow a 10-token budget. */
function makeOverBudgetProject() {
  const dir = makeProject({ maxTokens: 10, autoMaxTokens: false });
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(
      path.join(dir, 'src', `mod${i}.js`),
      `function alpha${i}(a, b, c) {}\nfunction beta${i}(x) {}\n`.repeat(40)
    );
  }
  return dir;
}

test('C2: --report --json over budget reports overBudget AND exits 1', () => {
  const dir = makeOverBudgetProject();
  const r = cli(dir, ['--report', '--json']);
  const payload = JSON.parse(r.stdout.trim().split('\n').pop());

  assert.strictEqual(payload.overBudget, true, 'payload should flag over-budget');
  assert.strictEqual(r.status, 1, 'documented CI gate must exit 1');
  fs.rmSync(dir, { recursive: true });
});

test('C2: --report text mode over budget also exits 1', () => {
  const dir = makeOverBudgetProject();
  const r = cli(dir, ['--report']);
  assert.strictEqual(r.status, 1, 'text --report shares the JSON semantics');
  assert.match(r.stderr, /exceeds budget/);
  fs.rmSync(dir, { recursive: true });
});

test('C2: under budget exits 0 with overBudget false', () => {
  const dir = makeProject({ maxTokens: 6000, autoMaxTokens: false });
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');

  const r = cli(dir, ['--report', '--json']);
  const payload = JSON.parse(r.stdout.trim().split('\n').pop());

  assert.strictEqual(payload.overBudget, false);
  assert.strictEqual(r.status, 0, 'under-budget runs must stay green');
  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// C3 - #657: decay converges on the neutral 1.0, from both directions
// ---------------------------------------------------------------------------

/** Run N unrelated `learn` calls, returning the weight of `rel` after each. */
function decaySeries(dir, rel, rounds) {
  const series = [];
  for (let i = 0; i < rounds; i++) {
    updateWeights(dir, { goodFiles: [] });
    series.push(loadWeights(dir)[rel]);
  }
  return series;
}

test('C3: a penalty decays UP toward 1.0 and never deeper', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'legacy.js'), 'function legacyFlow() {}\n');
  saveWeights(dir, { 'src/legacy.js': 0.9 });

  const series = decaySeries(dir, 'src/legacy.js', 5);
  let prev = 0.9;
  for (const w of series) {
    assert.ok(w > prev, `penalty must rise toward 1.0, went ${prev} -> ${w}`);
    assert.ok(w <= 1.0, `penalty must not overshoot past 1.0, got ${w}`);
    prev = w;
  }
  fs.rmSync(dir, { recursive: true });
});

test('C3: a boost decays DOWN toward 1.0 and never below', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');
  saveWeights(dir, { 'src/auth.js': 1.15 });

  const series = decaySeries(dir, 'src/auth.js', 5);
  let prev = 1.15;
  for (const w of series) {
    assert.ok(w < prev, `boost must fall toward 1.0, went ${prev} -> ${w}`);
    assert.ok(w >= 1.0, `boost must not cross into penalty territory, got ${w}`);
    prev = w;
  }
  fs.rmSync(dir, { recursive: true });
});

test('C3: near-neutral entries are pruned from the store', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), 'function loginUser(u) {}\n');
  saveWeights(dir, { 'src/auth.js': 1.15 });

  decaySeries(dir, 'src/auth.js', 80);
  assert.strictEqual(loadWeights(dir)['src/auth.js'], undefined,
    'a decayed-out weight should not linger in .context/weights.json');
  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// C4 - #658: graph keys are lowercased; display must recover the real spelling
// ---------------------------------------------------------------------------

/** Mixed-case sources under a mixed-case root - the shape that broke display. */
function makeMixedCaseProject() {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'src', 'userService.js'), 'module.exports = { getUser() {} };\n');
  fs.writeFileSync(path.join(dir, 'src', 'AuthRoutes.js'),  "require('./userService');\n");
  fs.writeFileSync(path.join(dir, 'src', 'App.js'),         "require('./AuthRoutes');\n");
  return dir;
}

test('C4: getImpact renders original-case repo-relative paths', () => {
  const dir   = makeMixedCaseProject();
  const files = ['userService.js', 'AuthRoutes.js', 'App.js'].map((f) => path.join(dir, 'src', f));
  const graph = build(files, dir);
  const impact = getImpact(path.join(dir, 'src', 'userService.js'), graph, { depth: 0, cwd: dir });

  assert.strictEqual(impact.changed, 'src/userService.js', 'changed path must keep its case');
  assert.deepStrictEqual(impact.direct, ['src/AuthRoutes.js']);
  assert.deepStrictEqual(impact.transitive, ['src/App.js']);
  for (const f of [impact.changed, ...impact.direct, ...impact.transitive]) {
    assert.ok(!f.startsWith('..'), `path must not climb out of cwd: ${f}`);
  }
  fs.rmSync(dir, { recursive: true });
});

test('C4: changed-file case survives when the file has no importers', () => {
  const dir   = makeMixedCaseProject();
  const graph = build([path.join(dir, 'src', 'App.js')], dir);
  const impact = getImpact('src/userService.js', graph, { depth: 0, cwd: dir });

  assert.strictEqual(impact.changed, 'src/userService.js');
  assert.strictEqual(impact.totalImpact, 0);
  fs.rmSync(dir, { recursive: true });
});

test('C4: build() exposes realPaths keyed by the lowercased graph key', () => {
  const dir   = makeMixedCaseProject();
  const abs   = path.join(dir, 'src', 'userService.js');
  const graph = build([abs], dir);

  assert.ok(graph.realPaths instanceof Map, 'graph should carry a realPaths map');
  assert.strictEqual(graph.realPaths.get(path.normalize(abs).toLowerCase()), abs);
  fs.rmSync(dir, { recursive: true });
});

test('C4: CLI --impact --json emits no parent-climbing paths', () => {
  const dir = makeMixedCaseProject();
  cli(dir, []);
  const r = cli(dir, ['--impact', 'src/userService.js', '--json']);
  assert.strictEqual(r.status, 0, `--impact should exit 0: ${r.stderr}`);

  const payload = JSON.parse(r.stdout.trim().split('\n').pop());
  const all = [payload.changed, ...payload.direct, ...payload.transitive];
  for (const f of all) {
    assert.ok(!f.includes('..'), `no path should climb out of cwd: ${f}`);
    assert.ok(!/-users-|-home-/i.test(f), `no mangled absolute remnant: ${f}`);
  }
  assert.strictEqual(payload.changed, 'src/userService.js');
  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('');
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
