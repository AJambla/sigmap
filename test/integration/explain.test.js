'use strict';

/**
 * Integration tests for `sigmap explain <file>` (#785, #772).
 *
 * `explain` answers "why is this file in — or not in — my context?" and had no
 * test file at all, which is how #772 shipped: a path that does not exist was
 * reported as `EXCLUDED — no extractable signatures`, exit 0, advising the user
 * to "check that the file contains function/class definitions".
 *
 * One case per status the handler can emit, human and `--json`:
 *   not-found · .contextignore · not in srcDirs · no signatures · included
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
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

/** Temp project with a real source file, an ignored file and a file outside srcDirs. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-explain-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
    JSON.stringify({ srcDirs: ['src'] }));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'),
    'function loadThing(id) { return id; }\nfunction saveThing(id) { return id; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'ignored.js'), 'function hidden() {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'empty.js'), '// just a comment, no declarations\n');
  fs.writeFileSync(path.join(dir, 'vendor', 'outside.js'), 'function vendored() {}\n');
  fs.writeFileSync(path.join(dir, '.contextignore'), 'src/ignored.js\n');
  return dir;
}

function explain(dir, args) {
  return spawnSync(process.execPath, [SCRIPT, 'explain', ...args], {
    encoding: 'utf8', cwd: dir, timeout: 120000,
  });
}

const dir = fixture();

console.log('[explain.test.js] sigmap explain — every status it can emit (#785, #772)');
console.log('');

// ── not-found (#772) ─────────────────────────────────────────────────────────

test('#772 a file that does not exist reports NOT FOUND, not EXCLUDED', () => {
  const r = explain(dir, ['src/does-not-exist.js']);
  assert.ok(r.stdout.includes('NOT FOUND'), `expected NOT FOUND, got: ${r.stdout}`);
  assert.ok(!r.stdout.includes('EXCLUDED'), `must not report EXCLUDED: ${r.stdout}`);
  assert.ok(!r.stdout.includes('no extractable signatures'),
    `must not blame missing signatures for a missing file: ${r.stdout}`);
});

test('#772 a missing file exits non-zero', () => {
  const r = explain(dir, ['src/does-not-exist.js']);
  assert.notStrictEqual(r.status, 0, 'a missing file must not exit 0');
});

test('#772 --json reports status not-found and names the path', () => {
  const r = explain(dir, ['src/does-not-exist.js', '--json']);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.status, 'not-found', JSON.stringify(j));
  assert.strictEqual(j.path, 'src/does-not-exist.js', JSON.stringify(j));
  assert.ok(j.fix && !j.fix.includes('function/class definitions'),
    `fix text must be actionable for a missing file: ${j.fix}`);
});

// ── excluded by .contextignore ───────────────────────────────────────────────

test('.contextignore match reports EXCLUDED and names the reason', () => {
  const r = explain(dir, ['src/ignored.js']);
  assert.ok(r.stdout.includes('EXCLUDED'), r.stdout);
  assert.ok(r.stdout.includes('.contextignore'), r.stdout);
  assert.strictEqual(r.status, 0, 'an exclusion is an answer, not an error');
});

test('.contextignore match --json carries reason and an exception fix', () => {
  const r = explain(dir, ['src/ignored.js', '--json']);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.status, 'excluded');
  assert.strictEqual(j.reason, '.contextignore', JSON.stringify(j));
  assert.ok(j.fix.includes('!src/ignored.js'), `expected an exception hint: ${j.fix}`);
});

// ── excluded by srcDirs ──────────────────────────────────────────────────────

test('a file outside srcDirs reports EXCLUDED with the configured dirs', () => {
  const r = explain(dir, ['vendor/outside.js']);
  assert.ok(r.stdout.includes('EXCLUDED'), r.stdout);
  assert.ok(r.stdout.includes('srcDir'), r.stdout);
  assert.strictEqual(r.status, 0);
});

test('a file outside srcDirs --json lists srcDirs', () => {
  const r = explain(dir, ['vendor/outside.js', '--json']);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.status, 'excluded');
  assert.strictEqual(j.reason, 'not in srcDirs', JSON.stringify(j));
  assert.deepStrictEqual(j.srcDirs, ['src'], JSON.stringify(j));
});

// ── excluded for having no signatures ────────────────────────────────────────

test('a file with no declarations reports EXCLUDED — no signatures', () => {
  const r = explain(dir, ['src/empty.js']);
  assert.ok(r.stdout.includes('EXCLUDED'), r.stdout);
  assert.ok(r.stdout.includes('no extractable signatures'), r.stdout);
  assert.strictEqual(r.status, 0);
});

test('a file with no declarations --json names the extractor', () => {
  const r = explain(dir, ['src/empty.js', '--json']);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.status, 'excluded');
  assert.strictEqual(j.reason, 'no signatures', JSON.stringify(j));
  assert.strictEqual(j.extractor, 'javascript', JSON.stringify(j));
});

// ── included ─────────────────────────────────────────────────────────────────

test('an indexed source file reports INCLUDED with extractor and count', () => {
  const r = explain(dir, ['src/app.js']);
  assert.ok(r.stdout.includes('INCLUDED'), r.stdout);
  assert.ok(r.stdout.includes('javascript'), r.stdout);
  assert.strictEqual(r.status, 0);
});

test('an indexed source file --json carries signatures and a preview', () => {
  const r = explain(dir, ['src/app.js', '--json']);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.status, 'included', JSON.stringify(j));
  assert.strictEqual(j.extractor, 'javascript');
  assert.ok(j.signatures >= 2, `expected ≥2 signatures, got ${j.signatures}`);
  assert.ok(Array.isArray(j.sigs) && j.sigs.some((x) => x.includes('loadThing')),
    `expected loadThing among sigs: ${JSON.stringify(j.sigs)}`);
  assert.ok(Array.isArray(j.preview) && j.preview.length <= 3, JSON.stringify(j.preview));
});

// ── usage ────────────────────────────────────────────────────────────────────

test('explain with no path exits 1 with usage', () => {
  const r = explain(dir, []);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
  assert.ok(/Usage/i.test(r.stderr), `expected usage on stderr: ${r.stderr}`);
});

// Cleanup
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
