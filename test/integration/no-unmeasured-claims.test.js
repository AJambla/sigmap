'use strict';

/**
 * No unmeasured number in a publicly-pasted block (#763, #764).
 *
 * Both commands here exist to produce text a user pastes somewhere public —
 * `share` into a social post, `bench --submit` into a GitHub Discussion — and
 * both printed figures that were never measured:
 *
 *   share           `6× better results`, a string literal, against a published
 *                   lift of 2.12×. And on a repo with no benchmark history it
 *                   emitted `97% fewer tokens · 88% retrieval accuracy` as the
 *                   USER'S OWN numbers, from two hardcoded defaults.
 *   bench --submit  `ret.hitAt5Pct || Math.round((ret.hitAt5 || 0) * 100)`
 *                   collapsed a MISSING field to 0, which then passed the
 *                   `!= null` render guard — so an unmeasured entry printed
 *                   `hit@5 : 0%`, indistinguishable from a real score of zero,
 *                   and exited 0.
 *
 * Same family as the `compare` fix (#760): a shipped command stating a number
 * the project cannot support. These are worse only because the output is
 * designed to be republished.
 *
 * Run: node test/integration/no-unmeasured-claims.test.js
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

function repo(history) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-claims-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function a(x) { return x; }\nmodule.exports = { a };\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'] }));
  execFileSync(process.execPath, [GEN], { cwd: dir, stdio: 'pipe' });
  const ctx = path.join(dir, '.context');
  fs.mkdirSync(ctx, { recursive: true });
  const hist = path.join(ctx, 'benchmark-history.ndjson');
  if (history === null) { try { fs.unlinkSync(hist); } catch (_) {} }
  else if (history !== undefined) fs.writeFileSync(hist, history.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

function run(dir, args) {
  try {
    const out = execFileSync(process.execPath, [GEN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return { out, code: 0 };
  } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}

const LIFT = (() => {
  const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks', 'latest.json'), 'utf8'));
  return l.honest.lift;
})();

// ── #763: share ─────────────────────────────────────────────────────────────

test('share: no unmeasured multiplier', () => {
  const dir = repo(null);
  try {
    const { out } = run(dir, ['share']);
    // The lookbehind keeps a MEASURED lift whose digits happen to end in 6
    // (`2.16×`) from matching; the target is the standalone literal.
    assert.ok(!/(?<![\d.])6×|6x better/.test(out),
      'the literal "6× better results" is measured nowhere and overstates the published lift ~3×');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share: a fresh repo does not invent 97% / 88%', () => {
  const dir = repo(null);
  try {
    const { out } = run(dir, ['share']);
    assert.ok(!/97% fewer tokens/.test(out) && !/88% retrieval/.test(out),
      'hardcoded defaults were emitted as the user\'s own measurements');
    assert.ok(/not benchmarked locally/.test(out),
      'a repo with no history should say so');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share: any multiplier it prints matches the published lift', () => {
  const dir = repo(null);
  try {
    const { out } = run(dir, ['share']);
    const m = out.match(/([\d.]+)×\s+vs a grep agent/);
    assert.ok(m, 'share should cite the published lift');
    assert.strictEqual(m[1], LIFT.toFixed(2),
      `share says ${m[1]}× but latest.json publishes ${LIFT}×`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share: local figures are labelled as this repo, published as published', () => {
  const dir = repo([{ type: 'token-reduction', ts: '2026-09-29T00:00:00.000Z', reduction: 91 },
                    { type: 'retrieval', ts: '2026-09-29T00:00:00.000Z', hitAt5: 0.7 }]);
  try {
    const { out } = run(dir, ['share']);
    assert.ok(/91% fewer tokens/.test(out), 'local reduction not used');
    assert.ok(/70% retrieval accuracy/.test(out), 'local hit@5 not used');
    assert.ok(/\(this repo\)/.test(out), 'local numbers must be labelled as local');
    assert.ok(/\(published\)/.test(out), 'the product-level lift must be labelled as published');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share: a measured zero is used, not treated as absent', () => {
  // `if (tok.reduction)` would discard a real 0.
  const dir = repo([{ type: 'token-reduction', ts: '2026-09-29T00:00:00.000Z', reduction: 0 }]);
  try {
    const { out } = run(dir, ['share']);
    assert.ok(/0% fewer tokens/.test(out), 'a measured 0 was dropped as if unmeasured');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── #764: bench --submit ────────────────────────────────────────────────────

const LOCAL = /Local run metrics[\s\S]*?hit@5\s+:\s*([^\n]+)/;

test('bench --submit: a missing hit@5 renders "not run", never 0%', () => {
  const dir = repo([{ type: 'retrieval', ts: '2026-09-29T00:00:00.000Z', repo: 'demo' }]);
  try {
    const { out } = run(dir, ['bench', '--submit']);
    const m = out.match(LOCAL);
    assert.ok(m, 'local block missing');
    assert.strictEqual(m[1].trim(), 'not run',
      `unmeasured entry rendered as "${m[1].trim()}" in a block meant for publication`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bench --submit: a real measured 0 still renders 0%', () => {
  const dir = repo([{ type: 'retrieval', ts: '2026-09-29T00:00:00.000Z', repo: 'demo', hitAt5: 0 }]);
  try {
    const { out } = run(dir, ['bench', '--submit']);
    const m = out.match(LOCAL);
    assert.ok(m && m[1].trim() === '0%',
      `a genuine zero must stay distinguishable from missing, got "${m && m[1].trim()}"`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bench --submit: exits non-zero when nothing local was measured', () => {
  const dir = repo([{ type: 'retrieval', ts: '2026-09-29T00:00:00.000Z', repo: 'demo' }]);
  try {
    assert.strictEqual(run(dir, ['bench', '--submit']).code, 1,
      'a green exit says the block is ready to publish when it carries nothing measured');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bench --submit: exits 0 when a real metric exists — including zero', () => {
  const dir = repo([{ type: 'retrieval', ts: '2026-09-29T00:00:00.000Z', repo: 'demo', hitAt5: 0 }]);
  try {
    assert.strictEqual(run(dir, ['bench', '--submit']).code, 0,
      'a measured 0 is a result and must not fail the command');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bench --submit: canonical release figures still render', () => {
  const dir = repo([{ type: 'retrieval', ts: '2026-09-29T00:00:00.000Z', hitAt5: 0.9 }]);
  try {
    const { out } = run(dir, ['bench', '--submit']);
    assert.ok(/Canonical metrics \(official release\)/.test(out), 'canonical block lost');
    assert.ok(/90%/.test(out), 'local measured value not rendered');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n  no-unmeasured-claims: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
