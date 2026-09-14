'use strict';

/**
 * T2 exactness: TS via the target repo's own typescript (#609, #542).
 *
 * The hermetic cases (always run, no host tools): flag off, package absent,
 * and package present-but-API-less — the last one is exactly what
 * typescript@7 ships (the Go-native compiler exposes only `version` through
 * its CommonJS entry; the classic API is the ≤5.x line), so the guard that
 * rejects it is load-bearing, not defensive fluff. Every fallback must be
 * byte-identical to the flag being off, and the toolchain label must appear
 * ONLY when native extraction actually fired.
 *
 * The positive AST path needs a real typescript (≤5.x) and is skipped when
 * none resolves — same policy as test:python needing a host python3. Point
 * SIGMAP_TEST_TS_DIR at any directory from which `typescript` resolves to
 * run it (the PR for #609 records a full run + measurement).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');
const native = require(path.join(ROOT, 'src/extractors/typescript_native'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function skip(name, why) { console.log(`  SKIP  ${name} — ${why}`); }

const TS_SRC = [
  'export interface Point { x: number; y: number; }',
  'export async function move(p: Point, dx = 1): Promise<Point> {',
  '  return { x: p.x + dx, y: p.y };',
  '}',
  '',
].join('\n');

function repo(exactnessOn, plantFakeTs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-tsnative-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'geo.ts'), TS_SRC);
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({
    srcDirs: ['src'],
    exactness: { typescript: exactnessOn },
    changes: false,
  }));
  if (plantFakeTs) {
    // The typescript@7 shape: resolvable, loads fine, exposes version but no
    // compiler API. resolveRepoTypescript must reject it and the extraction
    // must fall back to regex with no toolchain label.
    const fake = path.join(dir, 'node_modules', 'typescript');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'package.json'),
      JSON.stringify({ name: 'typescript', version: '7.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(fake, 'index.js'), 'module.exports = { version: "7.0.0" };\n');
  }
  return dir;
}

function generate(dir) {
  execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  return fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
}

// Volatile lines (timestamps) must not fail a byte-identity comparison.
const stable = (s) => s.split('\n').filter((l) => !/<!-- Updated:/.test(l)).join('\n');

const offDir = repo(false, false);
const off = generate(offDir);

test('flag on with no typescript in the repo falls back byte-identical', () => {
  const dir = repo(true, false);
  const on = generate(dir);
  assert.strictEqual(stable(on), stable(off), 'fallback output differs from flag-off output');
  assert.ok(!/toolchain=/.test(on), 'no toolchain label may appear when native never fired');
});

test('a typescript without the compiler API (the 7.x shape) is rejected and falls back', () => {
  const dir = repo(true, true);
  const on = generate(dir);
  assert.strictEqual(stable(on), stable(off), 'fallback output differs from flag-off output');
  assert.ok(!/toolchain=/.test(on), 'no toolchain label for a rejected typescript');
});

test('resolveRepoTypescript returns null for the API-less package', () => {
  const dir = repo(true, true);
  const r = native.resolveRepoTypescript(path.join(dir, 'src', 'geo.ts'));
  assert.strictEqual(r, null);
});

test('flag off never resolves or labels, even with a real-looking package planted', () => {
  const dir = repo(false, true);
  const out = generate(dir);
  assert.ok(!/toolchain=/.test(out));
});

// ── Positive AST path — needs a real typescript (≤5.x) ─────────────────────
const tsProbeDir = process.env.SIGMAP_TEST_TS_DIR || ROOT;
const resolved = native.resolveRepoTypescript(path.join(tsProbeDir, 'probe.ts'));
if (!resolved) {
  skip('native AST extraction (positive path)', `no typescript resolvable from ${tsProbeDir}; set SIGMAP_TEST_TS_DIR`);
} else {
  test(`native AST extraction with typescript@${resolved.version}`, () => {
    const sigs = native.extract(TS_SRC, 'geo.ts', resolved.ts);
    assert.ok(Array.isArray(sigs) && sigs.length >= 3, `expected sigs, got ${JSON.stringify(sigs)}`);
    assert.ok(sigs.some((s) => /^export interface Point  :1-1$/.test(s)), `interface line missing: ${sigs[0]}`);
    assert.ok(sigs.some((s) => /^  x: number  :1-1$/.test(s)), 'interface member missing');
    assert.ok(sigs.some((s) => /^export async function move\(p, dx = 1\) → Promise<Point>  :2-4$/.test(s)),
      `function line wrong: ${JSON.stringify(sigs)}`);
  });

  test('a multiline generic signature regex cannot fully see is exact under AST', () => {
    const hard = 'export function pick<T extends { id: string },\n  K extends keyof T>(\n  obj: T,\n  key: K,\n): T[K] {\n  return obj[key];\n}\n';
    const sigs = native.extract(hard, 'hard.ts', resolved.ts);
    assert.ok(sigs.some((s) => s.startsWith('export function pick(obj, key) → T[K]  :1-7')),
      `expected exact multiline signature, got ${JSON.stringify(sigs)}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
