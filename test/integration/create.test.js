'use strict';

/**
 * Integration tests for `sigmap create` (Gap 2 capstone — the orchestrator).
 *   orchestrate: ordering / numbering / skip / pass-fail aggregation · CLI
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'gen-context.js');
const { orchestrate, TOTAL, STAGE_NEEDS } = require(path.join(ROOT, 'src/create/orchestrate'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL  ${name}`); console.error(`        ${err.message}`); failed++; }
}

// A consistent conventions result so the scaffold stage can propose.
const consistentConventions = {
  fileNaming: { dominant: 'camelCase', dominantPct: 0.95, total: 10, tier: 'consistent',
    variants: [{ label: 'camelCase', count: 10, pct: 1, examples: ['fooBar.js'] }] },
  exportStyle: { dominant: 'named', dominantPct: 1, total: 10,
    variants: [{ label: 'named', count: 10, pct: 1, examples: ['fooBar.js'] }] },
  testFramework: 'jest',
};

// ── orchestrate (pure) ──────────────────────────────────────────────────────
test('all stages skipped with empty ctx → 4 skipped, NOT ok (#767)', () => {
  const r = orchestrate({}, ROOT);
  assert.strictEqual(r.steps.length, 4);
  assert.strictEqual(r.summary.ran, 0);
  assert.strictEqual(r.summary.skipped, 4);
  assert.strictEqual(r.summary.nothingRan, true);
  assert.strictEqual(r.summary.ok, false); // verified nothing → not a pass
});
test('every skipped stage reports what it needs (#767)', () => {
  const r = orchestrate({}, ROOT);
  for (const st of r.steps) {
    assert.strictEqual(st.skipped, true);
    assert.ok(st.needs && st.needs.length, `${st.name} has no needs text`);
    assert.strictEqual(st.needs, STAGE_NEEDS[st.name]);
  }
});
test('one stage running and passing is ok, nothingRan false (#767)', () => {
  const r = orchestrate({ name: 'user widget', conventions: consistentConventions }, ROOT);
  assert.strictEqual(r.summary.ran, 1);
  assert.strictEqual(r.summary.nothingRan, false);
  assert.strictEqual(r.summary.ok, true);
});
test('mixed pass/fail is not ok even with a passing stage (#767)', () => {
  const r = orchestrate(
    { name: 'user widget', conventions: consistentConventions, plan: 'Edit `src/does-not-exist.js`.' }, ROOT);
  assert.strictEqual(r.summary.ran, 2);
  assert.strictEqual(r.summary.passed, 1);
  assert.strictEqual(r.summary.failed, 1);
  assert.strictEqual(r.summary.ok, false);
});
test('steps are numbered 1/4..4/4 in pipeline order', () => {
  const r = orchestrate({}, ROOT);
  assert.deepStrictEqual(r.steps.map((s) => s.n), [1, 2, 3, 4]);
  assert.deepStrictEqual(r.steps.map((s) => s.name),
    ['scaffold', 'verify-plan', 'verify-ai-output', 'review-pr']);
  assert.ok(r.steps.every((s) => s.total === TOTAL));
});
test('scaffold runs when name + conventions present', () => {
  const r = orchestrate({ name: 'user widget', conventions: consistentConventions }, ROOT);
  const sc = r.steps[0];
  assert.strictEqual(sc.ran, true);
  assert.strictEqual(sc.ok, true);
  assert.strictEqual(sc.detail.proposal.filename, 'userWidget.js');
});
test('verify-plan failure makes summary not ok', () => {
  const r = orchestrate({ plan: 'Edit `src/does-not-exist.js`.' }, ROOT);
  const vp = r.steps[1];
  assert.strictEqual(vp.ran, true);
  assert.strictEqual(vp.ok, false);
  assert.strictEqual(r.summary.ok, false);
  assert.strictEqual(r.summary.failed, 1);
});
test('review-pr runs from changedFiles', () => {
  const r = orchestrate({ changedFiles: [{ path: '.env', status: 'M' }] }, ROOT);
  const rp = r.steps[3];
  assert.strictEqual(rp.ran, true);
  assert.strictEqual(rp.ok, false); // .env is a security finding
});
test('skipped stages never fail the run', () => {
  // scaffold ok, others skipped → ok true
  const r = orchestrate({ name: 'thing', conventions: consistentConventions }, ROOT);
  assert.strictEqual(r.summary.ran, 1);
  assert.strictEqual(r.summary.skipped, 3);
  assert.strictEqual(r.summary.ok, true);
});

// ── #666: the scaffold stage's proposal is an allowlist for verify-plan ─────
test('scaffold-proposed files are introductions for verify-plan (#666)', () => {
  // The plan names the file stage 1 just designed; without the allowlist that
  // is a missing-file error and the pipeline can never reach a passing stage 2.
  const plan = 'Add the helper in `userWidget.js`.';
  const without = orchestrate({ plan }, ROOT);
  assert.strictEqual(without.steps[1].ok, false, 'strict mode still flags it');

  const withScaffold = orchestrate(
    { name: 'user widget', conventions: consistentConventions, plan }, ROOT);
  assert.strictEqual(withScaffold.steps[1].ok, true, JSON.stringify(withScaffold.steps[1].detail.issues));
  assert.strictEqual(withScaffold.summary.ok, true);
});
test('ctx.creates reaches verify-plan (#666)', () => {
  const plan = 'Add `brandNewHelper(...)` to the codebase.';
  assert.strictEqual(orchestrate({ plan }, ROOT).steps[1].ok, false);
  const r = orchestrate({ plan, creates: ['brandNewHelper'] }, ROOT);
  assert.strictEqual(r.steps[1].ok, true, JSON.stringify(r.steps[1].detail.issues));
});

// ── CLI ─────────────────────────────────────────────────────────────────────
function withGitRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-'));
  const g = (a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  try {
    g(['init', '-q']); g(['config', 'user.email', 't@t.t']); g(['config', 'user.name', 'T']);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'fooBar.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'bazQux.js'), 'export const b = 2;\n');
    execFileSync(process.execPath, [SCRIPT], { cwd: dir, stdio: 'ignore' });
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    fn(dir, g);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: create with --name + --plan runs 2 stages (exit 0)', () => {
  withGitRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Reference `src/fooBar.js`.');
    const res = spawnSync('node', [SCRIPT, 'create', 'demo', '--name', 'new thing', '--plan', 'plan.md'],
      { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok(/1\/4 . scaffold/.test(res.stdout), res.stdout);
    assert.ok(/2\/4 . verify-plan/.test(res.stdout));
  });
});
test('CLI: create --json emits the pipeline result', () => {
  withGitRepo((dir) => {
    const res = spawnSync('node', [SCRIPT, 'create', 'demo', '--name', 'thing', '--json'],
      { cwd: dir, encoding: 'utf8' });
    const data = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.strictEqual(data.summary.total, 4);
    assert.strictEqual(data.steps.length, 4);
  });
});
test('CLI: create exits 1 when a ran stage fails', () => {
  withGitRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Call `totallyFakeSymbol(...)` in `src/ghost.js`.');
    const res = spawnSync('node', [SCRIPT, 'create', 'demo', '--plan', 'plan.md'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 1, res.stdout);
    assert.ok(/FAILED/.test(res.stdout));
  });
});


// ── #767: a run that verified nothing is not a pass ─────────────────────────
test('CLI: create with no stage inputs exits non-zero (#767)', () => {
  withGitRepo((dir) => {
    // No --name/--plan/--answer, and HEAD is the base commit, so no diff either.
    const res = spawnSync('node', [SCRIPT, 'create', 'add a widget', '--base', 'HEAD'],
      { cwd: dir, encoding: 'utf8' });
    assert.notStrictEqual(res.status, 0, `expected non-zero, got ${res.status}:\n${res.stdout}`);
    assert.strictEqual(res.status, 2, 'nothing-ran uses the "nothing to do" code');
    assert.ok(/0\/4 ran/.test(res.stdout), res.stdout);
  });
});
test('CLI: create prints what each stage needed when nothing ran (#767)', () => {
  withGitRepo((dir) => {
    const res = spawnSync('node', [SCRIPT, 'create', 'add a widget', '--base', 'HEAD'],
      { cwd: dir, encoding: 'utf8' });
    assert.ok(/nothing ran/.test(res.stdout), res.stdout);
    for (const [stage, needs] of Object.entries(STAGE_NEEDS)) {
      assert.ok(res.stdout.includes(stage), `missing stage ${stage}`);
      assert.ok(res.stdout.includes(needs), `missing needs text for ${stage}`);
    }
  });
});
test('CLI: --json summary.ok matches the exit code in all three outcomes (#767)', () => {
  withGitRepo((dir) => {
    const run = (extra) => {
      const res = spawnSync('node', [SCRIPT, 'create', 'demo', '--base', 'HEAD', '--json', ...extra],
        { cwd: dir, encoding: 'utf8' });
      return { status: res.status, data: JSON.parse(res.stdout.trim().split('\n').pop()) };
    };
    // 0 ran → ok false, non-zero
    const none = run([]);
    assert.strictEqual(none.data.summary.ran, 0);
    assert.strictEqual(none.data.summary.ok, false);
    assert.notStrictEqual(none.status, 0);

    // 1 ran and passed → ok true, exit 0
    const pass = run(['--name', 'thing']);
    assert.strictEqual(pass.data.summary.ok, true);
    assert.strictEqual(pass.status, 0);

    // a ran stage failed → ok false, exit 1
    fs.writeFileSync(path.join(dir, 'bad.md'), 'Edit `src/ghost.js`.');
    const fail = run(['--plan', 'bad.md']);
    assert.strictEqual(fail.data.summary.ok, false);
    assert.strictEqual(fail.status, 1);
  });
});

// ── #666: the create happy path is reachable before the code exists ─────────
test('CLI: create with a plan introducing new symbols passes stage 2 (#666)', () => {
  withGitRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'),
      '# Add a date helper\n\n## Creates\n- `formatDate(date)`\n- `src/util/date.js`\n\nWire it into `src/fooBar.js`.\n');
    const res = spawnSync('node', [SCRIPT, 'create', 'add a date helper', '--plan', 'plan.md', '--base', 'HEAD'],
      { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok(/2\/4 . verify-plan      ok/.test(res.stdout), res.stdout);
  });
});
test('CLI: create --creates forwards the allowlist to stage 2 (#666)', () => {
  withGitRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Add `formatDate(d)` in `src/util/date.js`.');
    const strict = spawnSync('node', [SCRIPT, 'create', 'demo', '--plan', 'plan.md', '--base', 'HEAD'],
      { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(strict.status, 1, strict.stdout);

    const withCreates = spawnSync('node',
      [SCRIPT, 'create', 'demo', '--plan', 'plan.md', '--base', 'HEAD', '--creates', 'formatDate,src/util/date.js'],
      { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(withCreates.status, 0, withCreates.stdout + withCreates.stderr);
  });
});

console.log(`\ncreate: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
