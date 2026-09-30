'use strict';

/**
 * Integration tests for v5.0 features:
 *  1.  judge engine — grounded response scores ≥ 0.25
 *  2.  judge engine — unrelated response scores 0
 *  3.  judge engine — verdict:pass on grounded response
 *  4.  judge engine — verdict:fail on unrelated response
 *  5.  sigmap judge --response --context --json → valid JSON with score/verdict/reasons
 *  6.  sigmap judge --response --context → exits 0 (grounded)
 *  7.  sigmap judge --response --context --threshold 0.99 → exits 1 (ungrounded at high threshold)
 *  8.  sigmap judge missing args → exits 1
 *  9.  config extends local file — maxTokens overridden from base
 * 10.  config extends local file — user value overrides base
 * 11.  sigmap history --json → valid JSON array
 * 12.  sigmap history → exits 0 (even with no log entries)
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawnSync } = require('child_process');

const ROOT   = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'gen-context.js');

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

console.log('[v500-features.test.js] v5.0 judge engine, config extends, history sparklines');
console.log('');

// ── Unit tests for judge engine ──────────────────────────────────────────────

const { groundedness, claimGrounding, judge } = require('../../../src/judge/judge-engine');

// 1. grounded response scores ≥ 0.25
test('judge: grounded response scores ≥ 0.25', () => {
  const response = 'The rank function sorts files by relevance score using token overlap.';
  const context  = 'function rank(query, sigIndex) sorts results by score using tokenized query tokens';
  const score = groundedness(response, context);
  assert.ok(score >= 0.25, `expected score >= 0.25, got ${score}`);
});

// 2. unrelated response scores 0 (or very low)
test('judge: unrelated response scores ≤ 0.1', () => {
  const response = 'The weather in Paris today is sunny and warm.';
  const context  = 'function rank(query, sigIndex) { return sorted; } function buildSigIndex(cwd)';
  const score = groundedness(response, context);
  assert.ok(score <= 0.1, `expected score <= 0.1, got ${score}`);
});

// 3. verdict:pass on grounded
test('judge: verdict:pass on grounded response', () => {
  const response = 'The rank function sorts files by relevance score and token overlap.';
  const context  = 'function rank(query, sigIndex) sorts results by relevance score using tokens';
  const { verdict } = judge(response, context, { threshold: 0.25 });
  assert.strictEqual(verdict, 'pass', `expected pass, got ${verdict}`);
});

// 4. verdict:fail on unrelated response
test('judge: verdict:fail on unrelated response', () => {
  const response = 'The weather in Paris today is sunny and warm.';
  const context  = 'function rank(query, sigIndex) { return sorted; } function buildSigIndex(cwd)';
  const { verdict } = judge(response, context, { threshold: 0.25 });
  assert.strictEqual(verdict, 'fail', `expected fail, got ${verdict}`);
});

// ── Claim-level grounding (v8.10) ────────────────────────────────────────────

// A1. ungrounded backtick symbol claim is detected
test('claimGrounding: hallucinated `foo()` symbol flagged ungrounded', () => {
  const response = 'The rank function calls `computeQuantumScore()` to rank results.';
  const context  = 'function rank(query, sigIndex) sorts results by relevance score';
  const c = claimGrounding(response, context);
  assert.strictEqual(c.total, 1, `expected 1 claim, got ${c.total}`);
  assert.strictEqual(c.ungrounded.length, 1, `expected 1 ungrounded, got ${JSON.stringify(c.ungrounded)}`);
  assert.strictEqual(c.ungrounded[0].value, 'computeQuantumScore');
});

// A2. a symbol the context DOES mention is grounded
test('claimGrounding: `rank()` present in context is grounded', () => {
  const response = 'Call `rank()` to sort results.';
  const context  = 'function rank(query, sigIndex) sorts results by relevance score';
  const c = claimGrounding(response, context);
  assert.strictEqual(c.total, 1);
  assert.strictEqual(c.grounded, 1, `expected grounded, got ${JSON.stringify(c)}`);
  assert.strictEqual(c.ungrounded.length, 0);
});

// A3. plain prose (no concrete claims) yields no claims — verdict unaffected
test('claimGrounding: plain prose produces zero claims', () => {
  const c = claimGrounding('The rank function sorts files by relevance.', 'function rank sorts results');
  assert.strictEqual(c.total, 0, `expected 0 claims, got ${JSON.stringify(c)}`);
});

// A4. a hallucinated symbol flips the verdict to fail EVEN WHEN lexical score
//     would pass — the core weakness the old token-overlap judge could not catch
test('judge: hallucinated symbol fails a lexically-passing answer', () => {
  const response = 'The rank function sorts results by relevance score using `computeQuantumScore()`.';
  const context  = 'function rank(query, sigIndex) sorts results by relevance score using tokens';
  const result   = judge(response, context, { threshold: 0.25 });
  assert.ok(result.score >= 0.25, `precondition: lexical score should pass, got ${result.score}`);
  assert.strictEqual(result.verdict, 'fail', `expected fail on hallucinated symbol, got ${result.verdict}`);
  assert.ok(result.reasons.some((r) => r.includes('computeQuantumScore')), `expected reason to name the symbol: ${JSON.stringify(result.reasons)}`);
  assert.ok(result.claims && result.claims.ungrounded.length === 1, 'expected claims.ungrounded to be populated');
});

// ── CLI tests ─────────────────────────────────────────────────────────────────

// Create temp files for CLI tests
const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-'));
const respFile = path.join(tmpDir, 'response.txt');
const ctxFile  = path.join(tmpDir, 'context.txt');
const unrelFile = path.join(tmpDir, 'unrelated.txt');

fs.writeFileSync(respFile,  'The rank function sorts files by relevance score and token overlap.');
fs.writeFileSync(ctxFile,   'function rank(query, sigIndex) sorts results by relevance score using tokens');
fs.writeFileSync(unrelFile, 'The weather in Paris today is sunny and warm.');

// 5. sigmap judge --json → valid JSON
test('sigmap judge --json → valid JSON with score/verdict/reasons', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', respFile, '--context', ctxFile, '--json'], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); }
  catch (e) { throw new Error(`invalid JSON: ${r.stdout.slice(0, 200)}`); }
  assert.ok('score'   in parsed, 'missing score');
  assert.ok('verdict' in parsed, 'missing verdict');
  assert.ok('reasons' in parsed, 'missing reasons');
  assert.ok(Array.isArray(parsed.reasons), 'reasons not array');
  assert.strictEqual(typeof parsed.score, 'number', 'score not a number');
});

// 6. sigmap judge → exits 0 (grounded)
test('sigmap judge → exits 0 on grounded response', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', respFile, '--context', ctxFile], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
});

// 7. sigmap judge --threshold 0.99 → exits 1
test('sigmap judge --threshold 0.99 → exits 1 on high threshold', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', unrelFile, '--context', ctxFile, '--threshold', '0.99', '--json'], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.verdict, 'fail', `expected fail, got ${parsed.verdict}`);
});

// 8. sigmap judge missing args → exits 1
test('sigmap judge missing --response → exits 1', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--context', ctxFile], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
});

// ── config extends tests ──────────────────────────────────────────────────────

const { loadConfig } = require('../../../src/config/loader');
const extendsTmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-ext-'));

// 9. extends local file — maxTokens from base
test('config extends: maxTokens overridden from base config', () => {
  const basePath = path.join(extendsTmpDir, 'base.json');
  fs.writeFileSync(basePath, JSON.stringify({ maxTokens: 9999 }));
  fs.writeFileSync(path.join(extendsTmpDir, 'gen-context.config.json'),
    JSON.stringify({ extends: basePath }));
  const cfg = loadConfig(extendsTmpDir);
  assert.strictEqual(cfg.maxTokens, 9999, `expected 9999, got ${cfg.maxTokens}`);
});

// 10. user config overrides base
test('config extends: user value overrides base config', () => {
  const basePath = path.join(extendsTmpDir, 'base2.json');
  fs.writeFileSync(basePath, JSON.stringify({ maxTokens: 9999 }));
  fs.writeFileSync(path.join(extendsTmpDir, 'gen-context.config.json'),
    JSON.stringify({ extends: basePath, maxTokens: 1234 }));
  const cfg = loadConfig(extendsTmpDir);
  assert.strictEqual(cfg.maxTokens, 1234, `expected 1234 (user override), got ${cfg.maxTokens}`);
});

// ── sigmap history tests ──────────────────────────────────────────────────────

// 11. sigmap history --json → valid JSON array
test('sigmap history --json → valid JSON array', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'history', '--json'], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); }
  catch (e) { throw new Error(`invalid JSON: ${r.stdout.slice(0, 200)}`); }
  assert.ok(Array.isArray(parsed), 'expected JSON array');
});

// 12. sigmap history → exits 0
test('sigmap history → exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'history'], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stderr}`);
});

// ── J2: configurable learning thresholds (#638) ──────────────────────────────

const { DEFAULTS } = require('../../../src/config/defaults');

/** Temp cwd with one real source file and a context that names it in a heading. */
function learnFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-band-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n');
  return dir;
}

// 13. loader merges a partial judge section over defaults
test('config: partial judge section merges over defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-cfg-'));
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
    JSON.stringify({ judge: { learnBoostAbove: 0.9 } }));
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.judge.learnBoostAbove, 0.9, 'user override lost');
  assert.strictEqual(cfg.judge.learnPenalizeBelow, DEFAULTS.judge.learnPenalizeBelow, 'sibling default lost');
  assert.strictEqual(cfg.judge.threshold, DEFAULTS.judge.threshold, 'threshold default lost');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 14. engine respects a configured band: the same score flips boost → no-op
test('judge --learn: configured band flips boost to no-op at the same score', () => {
  const dir = learnFixture();
  const context = '## src/a.js\nfunction rank sorts results relevance score tokens';
  const response = 'rank sorts results relevance score tokens'; // fully grounded → score 1.0
  const def = judge(response, context, { learn: true, cwd: dir });
  assert.strictEqual(def.learning.action, 'boost', `default band should boost: ${JSON.stringify(def.learning)}`);
  const moved = judge(response, context, { learn: true, cwd: dir, learnBoostAbove: 1.0 });
  assert.strictEqual(moved.learning.action, 'none', `band 1.0 must not boost a 1.0 score: ${JSON.stringify(moved.learning)}`);
  assert.ok(moved.learning.reason.includes('(0.4-1)'), `no-op reason must report the active band: ${moved.learning.reason}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 15. engine respects penalizeBelow: zero score stops penalizing when the band is 0
test('judge --learn: penalizeBelow 0 turns a penalize into a no-op', () => {
  const dir = learnFixture();
  const context = '## src/a.js\nfunction rank sorts results relevance score tokens';
  const response = 'weather paris sunny warm holiday'; // score 0
  const def = judge(response, context, { learn: true, cwd: dir });
  assert.strictEqual(def.learning.action, 'penalize', `default band should penalize: ${JSON.stringify(def.learning)}`);
  const moved = judge(response, context, { learn: true, cwd: dir, learnPenalizeBelow: 0 });
  assert.strictEqual(moved.learning.action, 'none', `band 0 must not penalize a 0 score: ${JSON.stringify(moved.learning)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 16. CLI: judge.threshold from config flips the verdict; --threshold still wins
test('sigmap judge: config threshold applies, --threshold flag overrides it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-cli-'));
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
    JSON.stringify({ judge: { threshold: 0.99 } }));
  const strict = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', respFile, '--context', ctxFile, '--json'], {
    encoding: 'utf8', cwd: dir, timeout: 120000,
  });
  assert.strictEqual(strict.status, 1, `config threshold 0.99 should fail a grounded answer, got exit ${strict.status}: ${strict.stdout}`);
  const flagged = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', respFile, '--context', ctxFile, '--threshold', '0.25', '--json'], {
    encoding: 'utf8', cwd: dir, timeout: 120000,
  });
  assert.strictEqual(flagged.status, 0, `--threshold 0.25 must override config 0.99, got exit ${flagged.status}: ${flagged.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 17. Derivation guard (#638): the shipped band separates measured mixtures.
//     Answers built from the repo's own vocabulary at 80% grounded tokens must
//     land in the boost band; at 30% grounded they must land in the penalize
//     band. Pins band ordering so a config edit can't silently invert it.
test('judge band: derived defaults separate 80%/30% grounded mixtures', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/judge/judge-engine.js'), 'utf8');
  // ≥7-char tokens only: the engine's STOP words are all ≤6 chars, so none of
  // the mixture is stop-filtered and the constructed ratios stay exact.
  const vocab = [...new Set((src.toLowerCase().match(/\b[a-z][a-z0-9_]{6,}\b/g) || []))].slice(0, 40);
  assert.ok(vocab.length === 40, `expected 40 vocab tokens, got ${vocab.length}`);
  const context = vocab.join(' ');
  const novel = Array.from({ length: 14 }, (_, i) => `zzqxword${i}`);
  const boostMix = vocab.slice(0, 16).concat(novel.slice(0, 4)).join(' ');    // 16/20 = 0.8
  const penalizeMix = vocab.slice(0, 6).concat(novel).join(' ');              // 6/20 = 0.3
  const hi = groundedness(boostMix, context);
  const lo = groundedness(penalizeMix, context);
  const { learnBoostAbove, learnPenalizeBelow } = DEFAULTS.judge;
  assert.ok(hi > learnBoostAbove, `80% mixture (${hi}) must exceed learnBoostAbove (${learnBoostAbove})`);
  assert.ok(lo < learnPenalizeBelow, `30% mixture (${lo}) must sit below learnPenalizeBelow (${learnPenalizeBelow})`);
  assert.ok(learnPenalizeBelow > 0 && learnPenalizeBelow < learnBoostAbove && learnBoostAbove < 1,
    `band ordering violated: 0 < ${learnPenalizeBelow} < ${learnBoostAbove} < 1`);
});

// ── J1: structural claim grounding via the verify engine (#640) ──────────────

/** Fixture repo with an indexed symbol and an installed, typed direct dep. */
function structuralFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-struct-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'leftpad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'judge-fixture', version: '1.0.0', dependencies: { leftpad: '^9.1.0' },
  }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'package.json'),
    JSON.stringify({ name: 'leftpad', version: '9.1.4', main: 'index.js', types: 'index.d.ts' }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'index.js'), 'module.exports = (s) => s;\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'index.d.ts'),
    'export declare function leftpad(s: string, n: number): string;\n');
  fs.writeFileSync(path.join(dir, 'src', 'pad.js'),
    "const leftpad = require('leftpad');\nfunction padded(s) {\n  return leftpad(s, 8);\n}\nmodule.exports = { padded };\n");
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'], changes: false }));
  spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  return dir;
}

const dirS = structuralFixture();
const unrelatedCtx = 'completely unrelated prose about nothing in particular';

// 18. repo symbol absent from context grounds structurally; fabricated fails
test('claimGrounding: repo symbol grounds via the index; fabricated still fails (#640)', () => {
  const real = claimGrounding('Call `padded()` to pad.', unrelatedCtx, { cwd: dirS });
  assert.strictEqual(real.structural, true, 'structural pass did not run');
  assert.strictEqual(real.grounded, 1, JSON.stringify(real));
  const fake = claimGrounding('Call `fabricatedQuantumFn()` to pad.', unrelatedCtx, { cwd: dirS });
  assert.strictEqual(fake.ungrounded.length, 1, JSON.stringify(fake));
});

// 19. installed-lib symbol, declared import, and real file ground; fakes fail
test('claimGrounding: lib symbol + declared import + real file ground; fakes fail (#640)', () => {
  const lib = claimGrounding('Use `leftpad()` here.', unrelatedCtx, { cwd: dirS });
  assert.strictEqual(lib.grounded, 1, `lib symbol should ground via the .d.ts index: ${JSON.stringify(lib)}`);
  const imp = claimGrounding("import leftpad from 'leftpad'", unrelatedCtx, { cwd: dirS });
  assert.strictEqual(imp.ungrounded.length, 0, `declared import should ground: ${JSON.stringify(imp)}`);
  const bad = claimGrounding("import x from 'not-a-real-dep-zzqx'", unrelatedCtx, { cwd: dirS });
  assert.ok(bad.ungrounded.some((c) => c.kind === 'import'), JSON.stringify(bad));
  const file = claimGrounding('See src/pad.js for the implementation.', unrelatedCtx, { cwd: dirS });
  assert.strictEqual(file.grounded, 1, `real file should ground: ${JSON.stringify(file)}`);
  const nofile = claimGrounding('See src/nonexistent-thing.js for the implementation.', unrelatedCtx, { cwd: dirS });
  assert.ok(nofile.ungrounded.some((c) => c.kind === 'file'), JSON.stringify(nofile));
});

// 20. verify summary exposes which claim classes ran
test('verify summary.checks reports which claim classes ran (#640)', () => {
  const { verify } = require('../../../src/verify/hallucination-guard');
  const withIndex = verify('nothing here', dirS);
  assert.deepStrictEqual(withIndex.summary.checks,
    { symbols: true, files: true, relativeImports: true, bareImports: true, scripts: false },
    JSON.stringify(withIndex.summary.checks));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-nochecks-'));
  const empty = verify('nothing here', bare);
  assert.strictEqual(empty.summary.checks.symbols, false, 'no index → symbols check must not count as run');
  assert.strictEqual(empty.summary.checks.bareImports, false, 'no package.json → bareImports must not count as run');
  fs.rmSync(bare, { recursive: true, force: true });
});

// 21. with cwd the verdict still fails on fabricated symbols, reason names the index
test('judge with cwd: fabricated symbol fails and the reason names the repo index (#640)', () => {
  const response = 'The padded helper calls `fabricatedQuantumFn()` for padding things.';
  const ctx = 'the padded helper pads things for padding';
  const r = judge(response, ctx, { threshold: 0.1, cwd: dirS });
  assert.strictEqual(r.verdict, 'fail', JSON.stringify(r));
  assert.ok(r.reasons.some((x) => x.includes('context or repo index')), JSON.stringify(r.reasons));
});

// 22. CLI end-to-end: a repo-true symbol claim the context never quotes now passes
test('sigmap judge: repo-true symbol claim passes end-to-end (#640)', () => {
  const resp2 = path.join(dirS, 'r.txt');
  const ctx2 = path.join(dirS, 'c.txt');
  fs.writeFileSync(resp2, 'The padding helper calls `padded()` internally.');
  fs.writeFileSync(ctx2, 'the padding helper lives in src and pads strings internally');
  const pre = claimGrounding(fs.readFileSync(resp2, 'utf8'), fs.readFileSync(ctx2, 'utf8'));
  assert.strictEqual(pre.ungrounded.length, 1, 'precondition: lexical-only must NOT ground this claim');
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', resp2, '--context', ctx2, '--json'], {
    encoding: 'utf8', cwd: dirS, timeout: 120000,
  });
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.verdict, 'pass', r.stdout);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}`);
});

// ── J4: confidence + checked-claims explainability (#653) ────────────────────

// 23. every claim reports its grounding route
test('claimGrounding: checked records carry the grounding route (#653)', () => {
  const repoRoute = claimGrounding('Call `padded()` to pad.', unrelatedCtx, { cwd: dirS });
  assert.deepStrictEqual(repoRoute.checked, [{ kind: 'symbol', value: 'padded', grounded: true, via: 'repo' }]);
  assert.strictEqual(repoRoute.coverage, 1);
  const ctxRoute = claimGrounding('Call `rank()` here.', 'function rank sorts results');
  assert.deepStrictEqual(ctxRoute.checked, [{ kind: 'symbol', value: 'rank', grounded: true, via: 'context' }]);
  const none = claimGrounding('Call `fabricatedQuantumFn()` now.', unrelatedCtx, { cwd: dirS });
  assert.deepStrictEqual(none.checked[0].via, null);
  assert.strictEqual(none.coverage, 0);
});

// 24. confidence levels are pinned
test('judge: confidence high / medium / low derive as documented (#653)', () => {
  const response = 'The padding helper calls `padded()` internally.';
  const ctx = 'the padding helper lives in src and pads strings internally';
  const high = judge(response, ctx, { cwd: dirS });
  assert.strictEqual(high.confidence.level, 'high', JSON.stringify(high.confidence));
  assert.ok(high.confidence.basis.some((b) => b.includes('structural pass ran')), JSON.stringify(high.confidence.basis));
  const medium = judge(response, ctx, {});
  assert.strictEqual(medium.confidence.level, 'medium', `no structural pass must cap at medium: ${JSON.stringify(medium.confidence)}`);
  const low = judge('alpha beta gamma delta', 'epsilon zeta eta theta', {});
  assert.strictEqual(low.confidence.level, 'low', `word-overlap-only verdict must be low: ${JSON.stringify(low.confidence)}`);
});

// 25. CLI carries the new fields; existing keys unchanged
test('sigmap judge: human output shows Confidence + Claims; --json is additive (#653)', () => {
  const resp3 = path.join(dirS, 'r2.txt');
  const ctx3 = path.join(dirS, 'c2.txt');
  fs.writeFileSync(resp3, 'The padding helper calls `padded()` internally.');
  fs.writeFileSync(ctx3, 'the padding helper lives in src and pads strings internally');
  const human = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', resp3, '--context', ctx3], {
    encoding: 'utf8', cwd: dirS, timeout: 120000,
  });
  assert.ok(human.stdout.includes('Confidence: high'), human.stdout);
  assert.ok(human.stdout.includes('Claims    : 1/1 grounded'), human.stdout);
  const json = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', resp3, '--context', ctx3, '--json'], {
    encoding: 'utf8', cwd: dirS, timeout: 120000,
  });
  const parsed = JSON.parse(json.stdout.trim());
  for (const k of ['score', 'reasons', 'claims', 'confidence']) assert.ok(k in parsed, `missing ${k}`);
  assert.strictEqual(parsed.confidence.level, 'high');
  assert.ok(Array.isArray(parsed.claims.checked) && parsed.claims.checked[0].via === 'repo', JSON.stringify(parsed.claims));
});

// ── #795: score technical content, not English (closes #779/#765/#766/#780) ──

const { scoreTokens, markerRegex } = require('../../../src/judge/judge-engine');
const ctxSource = require('../../../src/judge/context-source');

const SCAN_CTX = '## src/security/scanner.js\nfunction scan(signatures, filePath)  :14-38\n';

// 18. #779: filler prose no longer dilutes a fully-grounded answer below threshold
test('judge #779: prose-heavy grounded answer scores above threshold and passes', () => {
  const response = 'The scan function lives in src/security/scanner.js and takes signatures and '
    + 'filePath. You should probably first look there, then decide whether you want to change '
    + 'anything, because there are quite a few places where this could matter later on when '
    + 'things get complicated.';
  const score = groundedness(response, SCAN_CTX);
  assert.ok(score > 0.25, `expected > 0.25 (was 0.212 before the fix), got ${score}`);
  const r = judge(response, SCAN_CTX);
  assert.strictEqual(r.verdict, 'pass', `expected pass, got ${r.verdict}: ${JSON.stringify(r.reasons)}`);
});

// 19. #779: judge and ranker share one tokenizer — identifier vs split identifier
test('judge #779: identifier and split-identifier forms score within 0.05', () => {
  const context = 'function buildEvidencePack(query, cwd, opts) builds an evidence pack';
  const ident = groundedness('call buildEvidencePack with query and cwd', context);
  const split = groundedness('call build evidence pack with query and cwd', context);
  assert.ok(Math.abs(ident - split) <= 0.05,
    `identifier ${ident} vs split ${split} must agree (was 0.750 vs 0.333)`);
  assert.ok(ident > 0.25 && split > 0.25, `both forms must clear threshold: ${ident} / ${split}`);
});

// 20. #779: the judge tokenizer is the ranker's tokenizer
test('judge #779: scoreTokens splits camelCase like the ranker', () => {
  const toks = scoreTokens('buildEvidencePack');
  assert.ok(toks.length >= 3, `expected a split identifier, got ${JSON.stringify(toks)}`);
  assert.ok(toks.includes('build'), `expected "build" among ${JSON.stringify(toks)}`);
});

// 21. #765: a generic phrase is a warning, not a verdict
test('judge #765: generic phrase warns but does not flip the verdict', () => {
  const grounded = 'The scan function lives in src/security/scanner.js and takes signatures and filePath.';
  const hedged = grounded + ' Typically, it redacts secrets.';
  const a = judge(grounded, SCAN_CTX);
  const b = judge(hedged, SCAN_CTX);
  assert.strictEqual(a.verdict, 'pass', `control must pass: ${JSON.stringify(a.reasons)}`);
  assert.strictEqual(b.verdict, 'pass', `hedged answer must still pass: ${JSON.stringify(b.reasons)}`);
  assert.ok(b.warnings.some((w) => w.includes('typically,')), `expected warning, got ${JSON.stringify(b.warnings)}`);
  assert.ok(!b.reasons.some((r) => r.includes('generic phrase')), 'generic phrase must not be a reason');
});

// 22. #765: an ungrounded claim still fails
test('judge #765: a hallucinated symbol still fails despite the demotion', () => {
  const r = judge('Call `computeQuantumScore()` — typically, it scans signatures in src/security/scanner.js.', SCAN_CTX);
  assert.strictEqual(r.verdict, 'fail', `expected fail, got ${r.verdict}`);
  assert.ok(r.reasons.some((x) => x.includes('computeQuantumScore')), JSON.stringify(r.reasons));
});

// 23. #765: confidence never reports high when a stylistic warning is present
test('judge #765: a generic phrase caps confidence below high', () => {
  const hedged = 'The scan function lives in src/security/scanner.js and takes signatures and filePath. Typically, it redacts secrets.';
  const r = judge(hedged, SCAN_CTX, { cwd: ROOT });
  assert.notStrictEqual(r.confidence.level, 'high',
    `stylistic warning must cap confidence: ${JSON.stringify(r.confidence)}`);
});

// 24. #765: word-boundary matching — "in general-purpose" is not "in general"
test('judge #765: generic marker matches on word boundaries only', () => {
  assert.strictEqual(markerRegex('in general').test('written in general-purpose code'), false);
  assert.strictEqual(markerRegex('in general').test('this holds in general.'), true);
});

// 25. #766: empty response is inconclusive, not a genuine failure
test('judge #766: empty response verdicts inconclusive', () => {
  const r = judge('', SCAN_CTX);
  assert.strictEqual(r.verdict, 'inconclusive', `expected inconclusive, got ${r.verdict}`);
  assert.strictEqual(r.confidence.level, 'low', JSON.stringify(r.confidence));
  assert.strictEqual(r.claims.total, 0);
});

// 26. #766: empty context is inconclusive
test('judge #766: empty context verdicts inconclusive', () => {
  const r = judge('The scan function reads signatures.', '   \n  ');
  assert.strictEqual(r.verdict, 'inconclusive', `expected inconclusive, got ${r.verdict}`);
});

// 27. #766: an unrelated-but-substantive answer is still a genuine fail
test('judge #766: unrelated response still fails rather than going inconclusive', () => {
  const r = judge('The weather in Paris today is sunny and warm.', SCAN_CTX);
  assert.strictEqual(r.verdict, 'fail', `expected fail, got ${r.verdict}`);
});

// 28. #766: --learn never learns from an inconclusive verdict
test('judge #766: inconclusive verdict skips the weights feedback loop', () => {
  const dir = learnFixture();
  const r = judge('', '## src/a.js\nfunction rank sorts results', { learn: true, cwd: dir });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.strictEqual(r.learning.applied, false, JSON.stringify(r.learning));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── CLI surface for the same four fixes ──────────────────────────────────────

const cliDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-795-'));
const cliCtx  = path.join(cliDir, 'ctx.md');
const cliResp = path.join(cliDir, 'resp.md');
const cliEmpty = path.join(cliDir, 'empty.md');
const cliBad  = path.join(cliDir, 'bad.md');
fs.writeFileSync(cliCtx, SCAN_CTX);
fs.writeFileSync(cliResp, 'The scan function lives in src/security/scanner.js and takes signatures and filePath. Typically, it redacts secrets.\n');
fs.writeFileSync(cliEmpty, '');
fs.writeFileSync(cliBad, 'Call `computeQuantumScore()` to scan signatures in src/security/scanner.js.\n');

// 29. #766: empty --response exits 2 and names the file
test('sigmap judge #766: empty --response exits 2 naming the file', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliEmpty, '--context', cliCtx], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes(cliEmpty), `stderr must name the file: ${r.stderr}`);
});

// 30. #766: empty --context exits 2 and names the file
test('sigmap judge #766: empty --context exits 2 naming the file', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliResp, '--context', cliEmpty], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes(cliEmpty), `stderr must name the file: ${r.stderr}`);
});

// 31. #766: inconclusive is emitted in --json; pass/fail exit codes unchanged
test('sigmap judge #766: --json carries inconclusive; pass=0 and fail=1 unchanged', () => {
  const inc = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliEmpty, '--context', cliCtx, '--json'], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.strictEqual(JSON.parse(inc.stdout.trim()).verdict, 'inconclusive', inc.stdout);
  const pass = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliResp, '--context', cliCtx], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.strictEqual(pass.status, 0, `pass must exit 0, got ${pass.status}\n${pass.stdout}`);
  const fail = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliBad, '--context', cliCtx], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.strictEqual(fail.status, 1, `fail must exit 1, got ${fail.status}\n${fail.stdout}`);
});

// 32. #780: stdin via `--response -` and via a bare pipe
test('sigmap judge #780: reads the response from stdin', () => {
  const body = fs.readFileSync(cliResp, 'utf8');
  const dash = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', '-', '--context', cliCtx, '--json'], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000, input: body,
  });
  assert.strictEqual(JSON.parse(dash.stdout.trim()).verdict, 'pass', dash.stdout + dash.stderr);
  const bare = spawnSync(process.execPath, [SCRIPT, 'judge', '--context', cliCtx, '--json'], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000, input: body,
  });
  assert.strictEqual(JSON.parse(bare.stdout.trim()).verdict, 'pass', bare.stdout + bare.stderr);
});

// 33. #780: omitting --context uses the repo's generated context and says so
test('sigmap judge #780: default --context resolves and is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-ctxdef-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), SCAN_CTX);
  const resp = path.join(dir, 'r.md');
  fs.writeFileSync(resp, 'The scan function takes signatures and filePath.\n');
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', resp], {
    encoding: 'utf8', cwd: dir, timeout: 120000,
  });
  assert.ok(r.stdout.includes('CLAUDE.md'), `must name the resolved context: ${r.stdout}`);
  assert.ok(r.stdout.includes('default'), `must flag it as the default: ${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 34. #780: a context older than its sources warns
test('sigmap judge #780: stale context produces a visible warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-stale-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const ctxFile = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(ctxFile, SCAN_CTX);
  const old = Date.now() - 1000 * 60 * 60 * 72;
  fs.utimesSync(ctxFile, old / 1000, old / 1000);
  fs.writeFileSync(path.join(dir, 'src', 'scanner.js'), 'function scan(signatures, filePath) {}\n');

  const st = ctxSource.contextStaleness(ctxFile, dir, { srcDirs: ['src'] });
  assert.ok(st && st.stale, `expected stale, got ${JSON.stringify(st)}`);
  assert.ok(ctxSource.stalenessWarning(st).includes('scanner.js'),
    `warning must name the newer file: ${ctxSource.stalenessWarning(st)}`);

  const resp = path.join(dir, 'r.md');
  fs.writeFileSync(resp, 'The scan function takes signatures and filePath.\n');
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', resp, '--context', ctxFile], {
    encoding: 'utf8', cwd: dir, timeout: 120000,
  });
  assert.ok(r.stdout.includes('stale ground'), `CLI must surface the stale warning: ${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 35. #780: a fresh context produces no stale warning
test('sigmap judge #780: a context newer than its sources does not warn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-judge-fresh-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'scanner.js'), 'function scan(signatures, filePath) {}\n');
  const old = Date.now() - 1000 * 60 * 60 * 72;
  fs.utimesSync(path.join(dir, 'src', 'scanner.js'), old / 1000, old / 1000);
  const ctxFile = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(ctxFile, SCAN_CTX);
  const st = ctxSource.contextStaleness(ctxFile, dir, { srcDirs: ['src'] });
  assert.ok(st && !st.stale, `expected fresh, got ${JSON.stringify(st)}`);
  assert.strictEqual(ctxSource.stalenessWarning(st), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 36. #780: the human output lists each checked claim on a fail
test('sigmap judge #780: human output shows the per-claim table on a fail', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliBad, '--context', cliCtx], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.strictEqual(r.status, 1, `expected fail: ${r.stdout}`);
  assert.ok(r.stdout.includes('Checked'), `expected a per-claim table: ${r.stdout}`);
  assert.ok(r.stdout.includes('computeQuantumScore'), `must name the ungrounded claim: ${r.stdout}`);
  assert.ok(r.stdout.includes('src/security/scanner.js'), `must name the grounded claim: ${r.stdout}`);
});

// 37. #765: warnings reach the human output
test('sigmap judge #765: warnings are printed in the human output', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'judge', '--response', cliResp, '--context', cliCtx], {
    encoding: 'utf8', cwd: cliDir, timeout: 120000,
  });
  assert.ok(r.stdout.includes('Warnings'), `expected a warnings block: ${r.stdout}`);
  assert.ok(r.stdout.includes('typically,'), r.stdout);
});

// Cleanup
try {
  fs.rmSync(cliDir, { recursive: true, force: true });
} catch (_) {}

// Cleanup
try {
  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(extendsTmpDir, { recursive: true });
  fs.rmSync(dirS, { recursive: true });
} catch (_) {}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
