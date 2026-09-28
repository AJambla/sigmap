'use strict';

/**
 * The SigMap commands block reaches the always-on file in every strategy (#754).
 *
 * Reported as "in per-module mode the sigmap commands are not getting added to
 * the copilot instruction file, so the LLM does not pick it up." Reproduced,
 * and it was two strategies rather than one:
 *
 *   per-module  `runPerModuleStrategy` hand-built its overview and never called
 *               `usageBlock()`. The per-module `context-<module>.md` files DID
 *               carry it via `formatOutput` — but those are on-demand. The
 *               overview is the file the IDE actually auto-injects, so an agent
 *               in a per-module repo never learned the CLI existed.
 *   hot-cold    with no recently-changed files, `hotEntries` is empty and the
 *               primary output fell back to a bare HTML comment, skipping
 *               `formatOutput` and therefore the block too. That is precisely
 *               the moment an agent most needs to be told to run `sigmap ask`,
 *               rather than concluding the repo has no context.
 *
 * These tests generate real repos through the built CLI rather than asserting
 * on source, because both defects lived in the wiring, not in the block.
 *
 * Run: node test/integration/usage-block-strategies.test.js
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

const STRATEGIES = ['full', 'per-module', 'index', 'hot-cold'];

/** A two-module repo, generated under one strategy. Returns the primary output. */
function generate(strategy, { commitFiles = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-usage-'));
  for (const mod of ['api', 'web']) {
    const d = path.join(dir, mod, 'src');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(d, `f${i}.js`),
        `function ${mod}${i}(a, b) { return a + b; }\nmodule.exports = { ${mod}${i} };\n`);
    }
  }
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
    JSON.stringify({ srcDirs: ['api', 'web'], strategy }));
  if (commitFiles) {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '.');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'init');
  }
  execFileSync(process.execPath, [GEN], { cwd: dir, stdio: 'pipe' });
  const out = fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ── the reported defect ─────────────────────────────────────────────────────

for (const strategy of STRATEGIES) {
  test(`${strategy}: the always-on file carries the SigMap commands block`, () => {
    const out = generate(strategy);
    assert.ok(out.includes('## SigMap commands'),
      `strategy "${strategy}" produced a primary output with no commands block — ` +
      'an agent reading it never learns the CLI exists');
  });

  test(`${strategy}: the block is directive, not a passive list`, () => {
    const out = generate(strategy);
    assert.ok(/Run these yourself/.test(out),
      `strategy "${strategy}" lists the commands without telling the agent to run them`);
  });

  test(`${strategy}: names the commands that change cost and grounding`, () => {
    const out = generate(strategy);
    for (const cmd of ['sigmap ask', 'sigmap lines', 'sigmap verify', 'sigmap --impact']) {
      assert.ok(out.includes(cmd), `${strategy}: ${cmd} missing from the always-on file`);
    }
  });
}

// ── the two specific wiring holes ───────────────────────────────────────────

test('hot-cold with NO recently-changed files still carries the block', () => {
  // The empty-hot path skipped formatOutput entirely and emitted a bare comment.
  // No git history => nothing counts as "recently changed" => hotEntries is empty,
  // which is the branch that dropped the block. (Committing the files instead
  // would make them recent and exercise the populated path.)
  const out = generate('hot-cold');
  assert.ok(out.includes('## SigMap commands'),
    'the empty-hot stub dropped the block — exactly when the agent most needs it');
  assert.ok(/still indexed|retrieve per question/.test(out),
    'the stub should say the signatures exist and are retrievable, not just that nothing changed');
});

test('hot-cold WITH recent commits takes the populated path and still has the block', () => {
  const out = generate('hot-cold', { commitFiles: true });
  assert.ok(out.includes('## SigMap commands'), 'populated hot output lost the block');
  assert.ok(!/No files changed in the last/.test(out),
    'freshly committed files should count as hot — this should not be the empty stub');
});

test('per-module: the overview gives an agent an actionable next step', () => {
  // It used to close with "Inject the relevant module file into your IDE context
  // window" — something only a human can do.
  const out = generate('per-module');
  assert.ok(!/Inject the relevant module file into your IDE/.test(out),
    'the overview still instructs the agent to do something only a human can do');
  assert.ok(/sigmap ask/.test(out.slice(out.indexOf('## Modules'))),
    'the overview should point at a command that spans all modules');
});

test('per-module: the module table is still present and headed', () => {
  const out = generate('per-module');
  assert.ok(out.includes('## Modules'), 'module table lost its heading');
  assert.ok(/context-api\.md/.test(out) && /context-web\.md/.test(out),
    'module rows missing from the overview');
});

// ── cost, since this ships everywhere ───────────────────────────────────────

test('the block does not dominate the index strategy always-on file', () => {
  // `index` is the flagship token-saving strategy; the block is paid per question.
  const out = generate('index');
  const total = Math.round(out.length / 4);
  assert.ok(total < 900, `index always-on file is ~${total} tokens — the block should not dominate it`);
});

// ── the block must be PAID FOR, not added on top of the budget ─────────────

test('maxTokens is honoured as a total, preamble included', () => {
  // The entry budget never saw the usage block: it reserved a hardcoded
  // `max(200, 10%)` for a preamble the comment described as "~150 tokens".
  // Growing the block to ~224 therefore pushed a maxTokens:500 run to 554 —
  // and only CI caught it, because the margin was thin enough to differ by
  // environment. The reserve is now measured from usageBlock() itself.
  for (const budget of [500, 1000, 4000]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-budget-'));
    try {
      const src = path.join(dir, 'src');
      fs.mkdirSync(src, { recursive: true });
      const line = 'function placeholder() { return 42; }\n';
      for (let i = 0; i < 30; i++) {
        let c = '';
        while (c.length < 1200) c += line;
        fs.writeFileSync(path.join(src, `m${i}.js`), c);
      }
      fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
        JSON.stringify({ maxTokens: budget, autoMaxTokens: false, outputs: ['copilot'], secretScan: false }));
      execFileSync(process.execPath, [GEN], { cwd: dir, stdio: 'pipe' });
      const out = fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
      const tokens = Math.ceil(out.length / 4);
      assert.ok(tokens <= budget,
        `maxTokens:${budget} produced ${tokens} tokens — the fixed preamble is not being reserved`);
      assert.ok(out.includes('## SigMap commands'),
        `maxTokens:${budget} dropped the commands block instead of budgeting for it`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('the budget reserve tracks the block instead of a hardcoded guess', () => {
  // A literal number here would drift the moment the block changes again.
  const gen = fs.readFileSync(GEN, 'utf8');
  assert.ok(/fixedPreamble\s*=\s*estimateTokens\(usageBlock\(\)\)/.test(gen),
    'applyTokenBudget must measure the real usage block, not assume a size');
});

console.log(`\n  usage-block-strategies: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
