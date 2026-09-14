'use strict';

/**
 * D1 arity-checked verification (#529).
 * Run: node test/integration/arity-verify.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { parseParams, buildArityIndex, extractCallArgCounts, checkArity } = require(path.join(ROOT, 'src/verify/arity.js'));
const { verify } = require(path.join(ROOT, 'src/verify/hallucination-guard.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// ── parseParams ─────────────────────────────────────────────────────────────

test('parseParams: required, defaults, nested defaults, TS optionals, rest, destructuring', () => {
  assert.deepStrictEqual(parseParams('a, b'), { min: 2, max: 2, variadic: false });
  assert.deepStrictEqual(parseParams('a, b = g(x), c = ")"'), { min: 1, max: 3, variadic: false });
  assert.deepStrictEqual(parseParams('...rest'), { min: 0, max: 0, variadic: true });
  assert.deepStrictEqual(parseParams('x, y=1, *args'), { min: 1, max: 2, variadic: true });
  assert.deepStrictEqual(parseParams('a, **kwargs'), { min: 1, max: 1, variadic: true });
  assert.deepStrictEqual(parseParams('{ a, b }, [c]'), { min: 2, max: 2, variadic: false });
  assert.deepStrictEqual(parseParams('q, filter?'), { min: 1, max: 2, variadic: false });
  assert.deepStrictEqual(parseParams(''), { min: 0, max: 0, variadic: false });
});

test('parseParams: Go shapes — grouped params, type variadics, nested func types (#643)', () => {
  assert.deepStrictEqual(parseParams('a, b int'), { min: 2, max: 2, variadic: false });
  assert.deepStrictEqual(parseParams('nums ...int'), { min: 0, max: 0, variadic: true });
  assert.deepStrictEqual(parseParams('s []T, f func(T) U'), { min: 2, max: 2, variadic: false });
  assert.deepStrictEqual(parseParams('f func(a ...int), n int'), { min: 2, max: 2, variadic: false },
    'a nested func param’s ... must not mark the outer signature variadic');
});

// ── buildArityIndex ─────────────────────────────────────────────────────────

function sampleIndex() {
  return buildArityIndex(new Map([
    ['src/a.js', ['export function add(a, b) → number  :5-5  # Adds two numbers', 'function only(x)  :9-9', 'export const spread = (...args) =>  :12-12']],
    ['src/b.py', ['def greet(name, greeting="hi")  :3-8']],
    ['src/c.js', ['function add(a, b, c)  :1-1']],
    ['src/d.go', ['func Skip(a int)  :1-1', 'func (s) Push(v T)  :3-5', 'func Sum(nums ...int) → int  :7-9']],
    ['src/e.js', ['class Thing', '  method(a, b)  :4-6']],
  ]));
}

test('buildArityIndex: exact-param languages only; conflicts → ambiguous; members excluded', () => {
  const idx = sampleIndex();
  assert.strictEqual(idx.get('add'), 'ambiguous', 'conflicting arities must be ambiguous');
  assert.deepStrictEqual({ min: idx.get('only').min, max: idx.get('only').max }, { min: 1, max: 1 });
  assert.deepStrictEqual({ min: idx.get('greet').min, max: idx.get('greet').max }, { min: 1, max: 2 });
  assert.strictEqual(idx.get('spread').variadic, true);
  // Go joined the exact-param languages in G4 #643: top-level funcs enter the
  // index, receiver methods stay out (dotted calls are never flagged).
  assert.deepStrictEqual({ min: idx.get('Skip').min, max: idx.get('Skip').max }, { min: 1, max: 1 });
  assert.strictEqual(idx.get('Sum').variadic, true, 'Go type-variadic must index as variadic');
  assert.strictEqual(idx.get('Push'), undefined, 'Go receiver methods must not enter the index');
  assert.strictEqual(idx.get('method'), undefined, 'indented members must not enter the index');
});

// ── extractCallArgCounts ────────────────────────────────────────────────────

test('extractCallArgCounts: nested calls, comma strings, dotted + definitions skipped', () => {
  const calls = extractCallArgCounts('const r = only(1, g(2,3));\nobj.only(9);\nfunction only(a) {}\ngreet("a,b")\nnew Foo(1)\nif (only) {}');
  const byName = {};
  for (const c of calls) byName[c.name + '@' + c.line] = c.args;
  assert.strictEqual(byName['only@1'], 2, 'nested call args miscounted');
  assert.strictEqual(byName['g@1'], 2);
  assert.strictEqual(byName['greet@4'], 1, 'comma-in-string miscounted');
  assert.strictEqual(byName['only@2'], undefined, 'dotted call must be skipped');
  assert.strictEqual(byName['only@3'], undefined, 'definition must be skipped');
  assert.strictEqual(byName['Foo@5'], undefined, 'new-expression must be skipped');
});

// ── checkArity ──────────────────────────────────────────────────────────────

test('checkArity: in-range/variadic/ambiguous never flag; out-of-range flags', () => {
  const idx = sampleIndex();
  assert.strictEqual(checkArity('only', 1, idx), null);
  assert.ok(checkArity('only', 2, idx), 'too many args must flag');
  assert.ok(checkArity('only', 0, idx), 'too few args must flag');
  assert.strictEqual(checkArity('greet', 1, idx), null);
  assert.strictEqual(checkArity('greet', 2, idx), null);
  assert.ok(checkArity('greet', 3, idx));
  assert.strictEqual(checkArity('add', 5, idx), null, 'ambiguous must never flag');
  assert.strictEqual(checkArity('spread', 9, idx), null, 'variadic above min must never flag');
  assert.strictEqual(checkArity('nosuch', 1, idx), null);
});

// ── verify() end-to-end (real context file, no opts injection) ──────────────

function withRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-arity-'));
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'copilot-instructions.md'), [
    '### src/billing.js',
    '```',
    'export function charge(amount, currency)  :3-9',
    '```',
    '',
  ].join('\n'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('verify(): wrong-arity call flags arity-mismatch with the repo signature as suggestion', () => {
  withRepo((dir) => {
    const answer = 'Use it like this:\n```js\ncharge(100, "eur", true)\n```\n';
    const res = verify(answer, dir, { libIndex: false });
    const issue = res.issues.find((i) => i.type === 'arity-mismatch');
    assert.ok(issue, `arity-mismatch missing: ${JSON.stringify(res.issues)}`);
    assert.strictEqual(issue.confidence, 'medium');
    assert.ok(issue.message.includes('3 argument(s)') && issue.message.includes('takes 2'), issue.message);
    assert.ok(issue.suggestion.includes('charge(amount, currency)'), issue.suggestion);
  });
});

test('verify(): Go block — wrong-arity call flags, in-range + variadic stay clean (#643)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-arity-go-'));
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'copilot-instructions.md'), [
    '### src/pad.go',
    '```',
    'func Pad(s string, n int) → string  :3-9',
    'func Sum(nums ...int) → int  :11-13',
    '```',
    '',
  ].join('\n'));
  try {
    const bad = verify('Use it:\n```go\nPad("x", 2, true)\n```\n', dir, { libIndex: false });
    const issue = bad.issues.find((i) => i.type === 'arity-mismatch');
    assert.ok(issue, `Go arity-mismatch missing: ${JSON.stringify(bad.issues)}`);
    assert.ok(issue.message.includes('3 argument(s)') && issue.message.includes('takes 2'), issue.message);
    const clean = verify('```go\nPad("x", 2)\nSum(1, 2, 3, 4)\n```\n', dir, { libIndex: false });
    assert.ok(!clean.issues.find((i) => i.type === 'arity-mismatch'), JSON.stringify(clean.issues));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verify(): in-range call is clean; unknown symbol stays fake-symbol, not arity', () => {
  withRepo((dir) => {
    const clean = verify('```js\ncharge(100, "eur")\n```\n', dir, { libIndex: false });
    assert.ok(!clean.issues.find((i) => i.type === 'arity-mismatch'), JSON.stringify(clean.issues));
    const unknown = verify('Call `chargeAll(1)` to bill.\n', dir, { libIndex: false });
    assert.ok(unknown.issues.find((i) => i.type === 'fake-symbol'), 'unknown symbol must be fake-symbol');
    assert.ok(!unknown.issues.find((i) => i.type === 'arity-mismatch'), 'unknown symbol must not be arity-checked');
  });
});

console.log(`\n  arity-verify: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
