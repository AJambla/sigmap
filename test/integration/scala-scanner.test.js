'use strict';

/**
 * Scala balanced-scanner migration (#695 increment 2, second language).
 *
 * Four regex defects, the same family Kotlin had plus two Scala-specific ones:
 *
 *   1. `\(([^)]*)\)` stopped at the first `)`, so `def f(a: Int = g(1, 2))`
 *      rendered `def f(a, 2)` — an invented parameter.
 *   2. Scala generics use SQUARE brackets, which the comma-splitter did not
 *      track, so `Map[String, List[Int]]` became two params and left an
 *      unbalanced `List[Int]]` behind.
 *   3. `(?:[^{]*)\{` matched newlines, so a body-less `case class` adopted the
 *      next type's body — the committed fixture recorded `case class User :4-9`
 *      carrying `trait Repository`'s methods, with Repository absent (#738).
 *   4. Currying dropped every parameter list after the first, and the return
 *      type with it.
 *
 * Run: node test/integration/scala-scanner.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { extract } = require(path.join(ROOT, 'src', 'extractors', 'scala'));
const { extractFile } = require(path.join(ROOT, 'src', 'extractors', 'dispatch'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const names = (sigs) => sigs.map((s) => s.replace(/\s+:\d+-\d+$/, ''));
const cls = (body) => `class C {\n  ${body}\n}\n`;

// ── 1. Parameter lists survive nesting ───────────────────────────────────────

test('a nested call in a default no longer invents a parameter', () => {
  const out = extract(cls('def f(a: Int = g(1, 2), b: Int = 3): Int = a'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(a, b) → Int'],
    'the old scanner rendered `def f(a, 2)`');
});

test('square-bracket generics do not leak a type fragment as a param', () => {
  const out = extract(cls('def f(m: Map[String, List[Int]]): Int = 0'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(m) → Int'],
    'the old scanner emitted an unbalanced `List[Int]]` as a second param');
});

test('a function-typed parameter keeps what follows it', () => {
  const out = extract(cls('def f(cb: Int => Int, n: Int): Int = cb(n)'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(cb, n) → Int']);
});

test('a `)` inside a string default does not terminate the scan', () => {
  const out = extract(cls('def f(sep: String = ")"): String = sep'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(sep) → String']);
});

// ── 2. Currying keeps every list AND the return type ────────────────────────

test('multiple parameter lists are all rendered', () => {
  const out = extract(cls('def f(a: Int)(b: Int): Int = a'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(a)(b) → Int'],
    'currying used to render `def f(a)` with the return type lost entirely');
});

test('an implicit parameter list is preserved', () => {
  const out = extract(cls('def f(a: Int)(implicit ec: EC): Int = a'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(a)(implicit ec) → Int']);
});

test('method type parameters are consumed, not emitted as params', () => {
  const out = extract(cls('def f[T](a: T): Option[T] = None'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(a) → Option[T]']);
});

// ── 3. #738: a body-less type must not adopt the next one's body ────────────

test('a body-less case class does not swallow the following trait', () => {
  const out = extract('case class A(x: Int)\n\ntrait B {\n  def m(y: Int): Int\n}\n');
  assert.deepStrictEqual(names(out), ['case class A', 'trait B', '  def m(y) → Int'],
    'A used to be reported with B\'s members while B vanished');
});

test('the body-less type is anchored to its own line', () => {
  const out = extract('case class A(x: Int)\n\ntrait B {\n  def m(): Int\n}\n');
  const a = out.find((s) => s.startsWith('case class A'));
  assert.ok(/:1-1$/.test(a), `expected :1-1, got "${a}"`);
});

test('extends/with continuations still resolve to the right body', () => {
  const out = extract('class C(x: Int) extends B with M {\n  def m(y: Int): Int = y\n}\n');
  assert.deepStrictEqual(names(out), ['class C', '  def m(y) → Int']);
});

// ── 4. The committed fixture no longer ratifies the misattribution ─────────

test('the committed fixture names trait Repository, which it previously hid', () => {
  const expected = fs.readFileSync(path.join(ROOT, 'test/expected/scala.txt'), 'utf8');
  assert.ok(/trait Repository/.test(expected),
    'test/expected/scala.txt still omits Repository — it ratified the misattribution');
  assert.ok(!/^case class User\s+:4-9/m.test(expected),
    'User is still anchored to Repository\'s span');
});

test('a nested type\'s members are attributed to it, not the enclosing type', () => {
  // Finding nested types correctly (the migration) exposed a double-emission:
  // `inner` was reported under BOTH O and T. It belongs only to T.
  const out = extract('class O {\n  def before(a: Int): Int = a\n\n  trait T {\n    def inner(b: Int): Int\n  }\n\n  def after(c: Int): Int = c\n}\n');
  const exact = out.filter((s, i) => out.indexOf(s) !== i);
  assert.strictEqual(exact.length, 0, `duplicate signatures: ${JSON.stringify(exact)}`);
  assert.deepStrictEqual(names(out),
    ['class O', '  def before(a) → Int', '  def after(c) → Int', 'trait T', '  def inner(b) → Int'],
    'outer members on BOTH sides of the nested type must survive');
});

test('class members are not also emitted as top-level defs', () => {
  const out = extract(cls('def m(a: Int): Int = a'));
  assert.strictEqual(out.filter((s) => s.includes('def m(')).length, 1,
    `member emitted more than once: ${JSON.stringify(out)}`);
});

test('comment stripping is string-aware', () => {
  const out = extract(cls('def f(url: String = "https://x"): String = url'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(url) → String']);
});

test('the extractor routes through dispatch for .scala', () => {
  const out = extractFile('a.scala', cls('def f(a: Int = g(1, 2)): Int = a'));
  assert.deepStrictEqual(names(out), ['class C', '  def f(a) → Int']);
});

console.log(`\n  scala-scanner: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
