'use strict';

/**
 * Kotlin balanced-scanner migration (#695 increment 2) and the class
 * misattribution it fixed (#738).
 *
 * Two regex defects, both of which produced output a consumer could not tell
 * was wrong:
 *
 *   1. `\(([^)]*)\)` stopped at the first `)`, so `fun f(a: Int = g(1, 2))`
 *      captured `a: Int = g(1` and the comma-splitting `normalizeParams`
 *      rendered `fun f(a, 2)` — a signature with an INVENTED parameter.
 *   2. `(?:[^{]*)\{` on the class header matched newlines, so a body-less
 *      `data class A(...)` walked into the next declaration and adopted its
 *      body: A was reported with B's members and B vanished entirely.
 *
 * Run: node test/integration/kotlin-scanner.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { extract } = require(path.join(ROOT, 'src', 'extractors', 'kotlin'));
const { extractFile } = require(path.join(ROOT, 'src', 'extractors', 'dispatch'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const names = (sigs) => sigs.map((s) => s.replace(/\s+:\d+-\d+$/, ''));

// ── 1. Parameter lists survive nesting ───────────────────────────────────────

test('a nested call in a default no longer invents a parameter', () => {
  const out = extract('fun f(a: Int = g(1, 2), b: String = h("x")): Int {\n    return a\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(a, b) → Int'],
    'the old scanner rendered `fun f(a, 2)` — a plausible signature that was simply false');
});

test('a function-typed parameter keeps the parameters after it', () => {
  const out = extract('fun f(cb: (Int) -> Int, n: Int): Int {\n    return cb(n)\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(cb, n) → Int'],
    '`(Int) -> Int` used to close the param list early and drop `n`');
});

test('nested generics do not leak type fragments into the params', () => {
  const out = extract('fun f(m: Map<String, List<Pair<Int, String>>>): Int {\n    return m.size\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(m) → Int'],
    'the old scanner emitted an unbalanced `List<Pair<Int, String>>>` as a second param');
});

test('a `)` inside a string default does not terminate the scan', () => {
  const out = extract('fun f(sep: String = ")", other: String = "// not a comment"): String {\n    return sep\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(sep, other) → String']);
});

test('a trailing comma in a multi-line param list is dropped, not emitted', () => {
  const out = extract('fun f(\n    a: Int,\n    b: Int,\n): Int {\n    return a + b\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(a, b) → Int']);
});

test('`vararg` and other param modifiers are preserved', () => {
  const out = extract('fun f(vararg xs: Int, n: Int): Int {\n    return n\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(vararg xs, n) → Int']);
});

// ── 2. #738: a body-less class must not adopt the next one's body ───────────

test('a body-less data class does not swallow the following class', () => {
  const out = extract('data class A(val x: Int)\n\nclass B(val y: Int) {\n    fun m(z: Int): Int {\n        return z\n    }\n}\n');
  assert.deepStrictEqual(names(out), ['class A', 'class B', '  fun m(z) → Int'],
    'A used to be reported with B\'s members while B vanished entirely');
});

test('the body-less class is anchored to its own line, not the next span', () => {
  const out = extract('data class A(val x: Int)\n\nclass B {\n    fun m(): Int {\n        return 1\n    }\n}\n');
  const a = out.find((s) => s.startsWith('class A'));
  assert.ok(/:1-1$/.test(a), `expected class A anchored :1-1, got "${a}"`);
});

test('members are never attributed to a declaration with no body', () => {
  const out = extract('data class A(val x: Int)\n\nclass B {\n    fun m(): Int {\n        return 1\n    }\n}\n');
  const idxA = out.findIndex((s) => s.startsWith('class A'));
  const idxB = out.findIndex((s) => s.startsWith('class B'));
  const idxM = out.findIndex((s) => s.trim().startsWith('fun m'));
  assert.ok(idxA < idxB && idxB < idxM, `member must follow class B, got ${JSON.stringify(out)}`);
});

// ── 3. No duplication, and the committed fixture is right ──────────────────

test('a nested type\'s members are attributed to it, not the enclosing type', () => {
  // Finding nested types correctly (the migration) exposed a double-emission:
  // `inner` was reported under BOTH O and T. It belongs only to T.
  const out = extract('class O {\n    fun before(a: Int): Int { return a }\n\n    interface T {\n        fun inner(b: Int): Int\n    }\n\n    fun after(c: Int): Int { return c }\n}\n');
  const exact = out.filter((s, i) => out.indexOf(s) !== i);
  assert.strictEqual(exact.length, 0, `duplicate signatures: ${JSON.stringify(exact)}`);
  assert.deepStrictEqual(names(out),
    ['class O', '  fun before(a) → Int', '  fun after(c) → Int', 'interface T', '  fun inner(b) → Int'],
    'outer members on BOTH sides of the nested type must survive');
});

test('class members are not also emitted as top-level functions', () => {
  const out = extract('class C {\n    fun m(a: Int): Int {\n        return a\n    }\n}\n');
  const ms = out.filter((s) => s.includes('fun m('));
  assert.strictEqual(ms.length, 1, `member emitted ${ms.length} times: ${JSON.stringify(out)}`);
});

test('the committed fixture names UserService, which it previously hid', () => {
  const expected = fs.readFileSync(path.join(ROOT, 'test/expected/kotlin.txt'), 'utf8');
  assert.ok(/class UserService/.test(expected),
    'test/expected/kotlin.txt still omits UserService — it ratified the misattribution');
  assert.ok(!/^class User\s+:4-14/m.test(expected),
    'User is still anchored to UserService\'s span');
});

test('comment stripping is string-aware', () => {
  // A `//` inside a string must not blank the rest of the line.
  const out = extract('fun f(url: String = "https://x"): String {\n    return url\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(url) → String']);
});

test('the extractor routes through dispatch for .kt', () => {
  const out = extractFile('a.kt', 'fun f(a: Int = g(1, 2)): Int {\n    return a\n}\n');
  assert.deepStrictEqual(names(out), ['fun f(a) → Int']);
});

console.log(`\n  kotlin-scanner: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
