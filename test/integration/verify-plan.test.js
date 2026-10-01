'use strict';

/**
 * Integration tests for `sigmap verify-plan` (Gap 2, step 2).
 *   verifyPlan: missing files / unknown symbols / blast radius / scope · CLI
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'gen-context.js');
const { verifyPlan, extractIntroductions } = require(path.join(ROOT, 'src/plan/verify-plan'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL  ${name}`); console.error(`        ${err.message}`); failed++; }
}

// A small repo with an import chain so blast radius is measurable.
function withRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vplan-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'core.js'),
      'function coreFn(x){ return x; }\nmodule.exports = { coreFn };\n');
    fs.writeFileSync(path.join(dir, 'src', 'a.js'),
      "const { coreFn } = require('./core');\nfunction aFn(){ return coreFn(1); }\nmodule.exports = { aFn };\n");
    fs.writeFileSync(path.join(dir, 'src', 'b.js'),
      "const { coreFn } = require('./core');\nfunction bFn(){ return coreFn(2); }\nmodule.exports = { bFn };\n");
    // generate the index so symbols resolve
    execFileSync(process.execPath, [SCRIPT], { cwd: dir, stdio: 'ignore' });
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── verifyPlan ──────────────────────────────────────────────────────────────
test('clean plan → ok, no errors', () => {
  withRepo((dir) => {
    const plan = 'Update `src/core.js` to adjust `coreFn(...)`.';
    const r = verifyPlan(plan, dir);
    assert.strictEqual(r.summary.ok, true, JSON.stringify(r.issues));
    assert.strictEqual(r.summary.errors, 0);
  });
});
test('missing referenced file → error', () => {
  withRepo((dir) => {
    const r = verifyPlan('Edit `src/does/not/exist.js`.', dir);
    const miss = r.issues.find((i) => i.type === 'missing-file');
    assert.ok(miss, 'flags missing file');
    assert.strictEqual(miss.severity, 'error');
    assert.strictEqual(r.summary.ok, false);
  });
});
test('unknown symbol → error with suggestion', () => {
  withRepo((dir) => {
    const r = verifyPlan('Call `coreFnn(...)` somewhere.', dir); // typo of coreFn
    const unk = r.issues.find((i) => i.type === 'unknown-symbol');
    assert.ok(unk, 'flags unknown symbol');
    assert.strictEqual(unk.suggestion, 'coreFn', 'suggests the near match');
  });
});
test('known symbol → no unknown-symbol issue', () => {
  withRepo((dir) => {
    const r = verifyPlan('Use `coreFn(...)`.', dir);
    assert.ok(!r.issues.some((i) => i.type === 'unknown-symbol'));
  });
});
test('blast radius is computed for existing files', () => {
  withRepo((dir) => {
    const r = verifyPlan('Modify `src/core.js`.', dir);
    const entry = r.blast.find((b) => b.file.endsWith('core.js'));
    assert.ok(entry, 'blast entry present');
    assert.ok(entry.totalImpact >= 2, `core.js has ≥2 dependents, got ${entry.totalImpact}`);
  });
});
test('high blast radius flagged when over threshold', () => {
  withRepo((dir) => {
    const r = verifyPlan('Modify `src/core.js`.', dir, { blastThreshold: 1 });
    assert.ok(r.issues.some((i) => i.type === 'high-blast-radius'), 'flags high blast radius');
  });
});
test('broad scope flagged over threshold', () => {
  withRepo((dir) => {
    const plan = 'Touch `src/core.js`, `src/a.js`, `src/b.js`.';
    const r = verifyPlan(plan, dir, { scopeThreshold: 2 });
    assert.ok(r.issues.some((i) => i.type === 'broad-scope'), 'flags broad scope');
  });
});

// ── #666: introductions (names the plan CREATES, verified in reverse) ───────
test('Creates section is parsed from heading, label and inline forms', () => {
  const heading = extractIntroductions('## Creates\n- `formatDate(d)` — format\n- `src/util/date.js`\n\n## Edits\n- `src/a.js`');
  assert.deepStrictEqual(heading.map((x) => x.name), ['formatDate', 'src/util/date.js']);
  const inline = extractIntroductions('Creates: `formatDate`, `parseDate`\n');
  assert.deepStrictEqual(inline.map((x) => x.name), ['formatDate', 'parseDate']);
  const bold = extractIntroductions('**Creates:**\n  `src/util/date.js`\n');
  assert.deepStrictEqual(bold.map((x) => x.name), ['src/util/date.js']);
});
test('prose beginning with "creates" is not a Creates section', () => {
  assert.deepStrictEqual(extractIntroductions('Creates a new helper for dates.\n- `src/a.js`\n'), []);
  assert.deepStrictEqual(extractIntroductions('Creates new widgets for the UI.\n- `src/a.js`\n'), []);
  assert.deepStrictEqual(extractIntroductions('This step creates: nothing\n'), []);
});
test('a plan introducing new symbols passes — the create happy path (#666)', () => {
  withRepo((dir) => {
    const plan = '# Add a date helper\n\n## Creates\n- `formatDate(date)`\n- `src/util/date.js`\n\nWire it into `src/core.js`.';
    const r = verifyPlan(plan, dir);
    assert.strictEqual(r.summary.ok, true, JSON.stringify(r.issues));
    assert.strictEqual(r.summary.symbolsIntroduced, 1);
    assert.strictEqual(r.summary.filesIntroduced, 1);
  });
});
test('the same plan without the section still fails strictly (#666)', () => {
  withRepo((dir) => {
    const plan = '# Add a date helper\n\nAdd `formatDate(date)` in `src/util/date.js`.';
    const r = verifyPlan(plan, dir);
    assert.strictEqual(r.summary.ok, false);
    assert.ok(r.issues.some((i) => i.type === 'missing-file'));
    assert.ok(r.issues.some((i) => i.type === 'unknown-symbol'));
  });
});
test('introducing a symbol that already exists is flagged (#666)', () => {
  withRepo((dir) => {
    const r = verifyPlan('## Creates\n- `coreFn(x)`\n', dir);
    const redef = r.issues.find((i) => i.type === 'redefines-existing');
    assert.ok(redef, JSON.stringify(r.issues));
    assert.strictEqual(redef.ref, 'coreFn');
    assert.strictEqual(redef.kind, 'symbol');
    assert.strictEqual(redef.severity, 'error');
    assert.strictEqual(r.summary.ok, false);
  });
});
test('introducing a file that already exists is flagged (#666)', () => {
  withRepo((dir) => {
    const r = verifyPlan('## Creates\n- `src/core.js`\n', dir);
    const redef = r.issues.find((i) => i.type === 'redefines-existing');
    assert.ok(redef, JSON.stringify(r.issues));
    assert.strictEqual(redef.kind, 'file');
    assert.strictEqual(r.summary.ok, false);
  });
});
test('opts.creates marks introductions without a plan section (#666)', () => {
  withRepo((dir) => {
    const plan = 'Add `formatDate(d)` in `src/util/date.js`.';
    assert.strictEqual(verifyPlan(plan, dir).summary.ok, false);
    const r = verifyPlan(plan, dir, { creates: ['formatDate', 'src/util/date.js'] });
    assert.strictEqual(r.summary.ok, true, JSON.stringify(r.issues));
  });
});
test('introduced files are not counted in blast radius', () => {
  withRepo((dir) => {
    const r = verifyPlan('## Creates\n- `src/util/date.js`\n\nCalled from `src/core.js`.', dir);
    assert.ok(!r.blast.some((b) => b.file.includes('date.js')), JSON.stringify(r.blast));
  });
});
test('introductions are reported with their existence verdict', () => {
  withRepo((dir) => {
    const r = verifyPlan('## Creates\n- `formatDate(d)`\n- `coreFn(x)`\n', dir);
    const byName = Object.fromEntries(r.introduces.map((i) => [i.name, i.exists]));
    assert.strictEqual(byName.formatDate, false);
    assert.strictEqual(byName.coreFn, true);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────
test('CLI: verify-plan --creates exits 0 on a creation plan (#666)', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Add `formatDate(d)` in `src/util/date.js`.');
    const strict = spawnSync('node', [SCRIPT, 'verify-plan', 'plan.md'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(strict.status, 1, strict.stdout);

    const res = spawnSync('node', [SCRIPT, 'verify-plan', 'plan.md', '--creates', 'formatDate,src/util/date.js'],
      { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok(/2 introduced/.test(res.stdout), res.stdout);
  });
});
test('CLI: verify-plan reports a redefinition in prose (#666)', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), '## Creates\n- `coreFn(x)`\n');
    const res = spawnSync('node', [SCRIPT, 'verify-plan', 'plan.md'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.ok(/already exists: coreFn/.test(res.stdout), res.stdout);
  });
});
test('CLI: verify-plan on a clean plan exits 0', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Update `src/core.js` via `coreFn(...)`.');
    const res = spawnSync('node', [SCRIPT, 'verify-plan', 'plan.md'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(/checks out/.test(res.stdout));
  });
});
test('CLI: verify-plan with errors exits 1', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Edit `src/nope.js` and call `fakeThing(...)`.');
    const res = spawnSync('node', [SCRIPT, 'verify-plan', 'plan.md'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.ok(/missing file|unknown symbol/.test(res.stdout));
  });
});
test('CLI: verify-plan --json emits the result', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Update `src/core.js`.');
    const res = spawnSync('node', [SCRIPT, 'verify-plan', 'plan.md', '--json'], { cwd: dir, encoding: 'utf8' });
    const data = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.ok(data.summary);
    assert.ok(Array.isArray(data.issues));
    assert.ok(Array.isArray(data.blast));
  });
});
test('CLI: verify-plan with no arg exits 1 with usage', () => {
  const res = spawnSync('node', [SCRIPT, 'verify-plan'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(/Usage/.test(res.stderr));
});

console.log(`\nverify-plan: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
