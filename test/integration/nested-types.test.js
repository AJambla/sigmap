'use strict';

/**
 * Nested type declarations in java, swift and csharp (#741).
 *
 * Three languages, three DIFFERENT root causes — which is why this could not be
 * one shared patch:
 *
 *   csharp  the nested type WAS reported, but its members were not: the member
 *           scan demanded an explicit `public|internal|protected`, and
 *           INTERFACE members are implicitly public. The committed
 *           `test/expected/csharp.txt` recorded `interface IUserRepository`
 *           with no members while the fixture declares two.
 *   swift   the type regex was anchored at column 0, so a nested type was never
 *           reported — while the member scan happily matched its methods
 *           against the ENCLOSING block, attributing them to the wrong owner.
 *   java    the type regex was likewise column-0 anchored, so the nested type
 *           and its members were both absent. No misattribution, but no surface.
 *
 * Correcting the reporting without scoping the members produces duplicates —
 * that is what happened in kotlin/scala (#738) — so both halves land together
 * and every test below asserts zero exact duplicates.
 *
 * Run: node test/integration/nested-types.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { extractFile } = require(path.join(ROOT, 'src', 'extractors', 'dispatch'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const bare = (sigs) => sigs.map((s) => s.replace(/\s+:\d+-\d+$/, ''));
const dupes = (sigs) => sigs.filter((s, i) => sigs.indexOf(s) !== i);

const CASES = {
  'a.java': {
    src: 'class O {\n    public int before(int a) { return a; }\n    public interface T {\n        int inner(int b);\n    }\n    public int after(int c) { return c; }\n}\n',
    want: ['class O', '  before(int a) → int', '  after(int c) → int', 'interface T', '  inner(int b) → int'],
  },
  'a.cs': {
    src: 'class O {\n    public int Before(int a) { return a; }\n    public interface T {\n        int Inner(int b);\n    }\n    public int After(int c) { return c; }\n}\n',
    want: ['class O', '  Before(int a) → int', '  After(int c) → int', 'interface T', '  Inner(int b) → int'],
  },
  'a.swift': {
    src: 'class O {\n    func before(a: Int) -> Int { return a }\n    class T {\n        func inner(b: Int) -> Int { return b }\n    }\n    func after(c: Int) -> Int { return c }\n}\n',
    want: ['class O', '  func before(a) → Int', '  func after(c) → Int', 'class T', '  func inner(b) → Int'],
  },
};

for (const [file, { src, want }] of Object.entries(CASES)) {
  const lang = file.slice(2);

  test(`${lang}: a nested type is reported with its own members`, () => {
    assert.deepStrictEqual(bare(extractFile(file, src)), want);
  });

  test(`${lang}: no member is attributed to two owners`, () => {
    const out = extractFile(file, src);
    assert.deepStrictEqual(dupes(out), [], `duplicate signatures: ${JSON.stringify(dupes(out))}`);
  });

  test(`${lang}: outer members on BOTH sides of the nested type survive`, () => {
    const out = bare(extractFile(file, src));
    const idxNested = out.findIndex((s) => /^(class|interface) T/.test(s));
    const outerMembers = out.slice(0, idxNested).filter((s) => s.startsWith('  '));
    assert.strictEqual(outerMembers.length, 2,
      `expected both outer members before the nested type, got ${JSON.stringify(out)}`);
  });
}

// ── language-specific roots ──────────────────────────────────────────────────

test('csharp: interface members are implicitly public', () => {
  // The whole csharp defect: no explicit modifier, so the scan found nothing.
  const out = bare(extractFile('a.cs', 'interface I {\n    int A(int x);\n    string B();\n}\n'));
  assert.deepStrictEqual(out, ['interface I', '  A(int x) → int', '  B() → string']);
});

test('csharp: a class member still requires its modifier', () => {
  // implicitPublic must apply to interfaces ONLY — a private class member is
  // not part of the surface and must stay out.
  const out = bare(extractFile('a.cs', 'class C {\n    private int Hidden(int x) { return x; }\n    public int Shown(int x) { return x; }\n}\n'));
  assert.ok(!out.some((s) => /Hidden/.test(s)), `private member leaked: ${out}`);
  assert.ok(out.some((s) => /Shown/.test(s)));
});

test('swift: a nested type was previously invisible', () => {
  const out = bare(extractFile('a.swift', 'struct A {\n    struct B {\n        func m() -> Int { return 1 }\n    }\n}\n'));
  assert.ok(out.includes('struct B'), `nested struct missing: ${out}`);
  assert.ok(out.includes('  func m() → Int'), `nested member missing: ${out}`);
});

test('java: a static nested class is reported', () => {
  const out = bare(extractFile('a.java', 'class O {\n    public static class Builder {\n        public Builder set(int a) { return this; }\n    }\n}\n'));
  assert.ok(out.includes('class Builder'), `static nested class missing: ${out}`);
  assert.ok(out.some((s) => /set\(int a\)/.test(s)), `builder member missing: ${out}`);
});

test('java: a top-level type is still anchored at its own line', () => {
  const out = extractFile('a.java', 'class A {\n    public int m() { return 1; }\n}\n');
  assert.ok(/^class A\s+:1-3$/.test(out[0]), `anchor changed: ${out[0]}`);
});

// ── the committed expectation no longer hides the members ────────────────────

test('the csharp fixture now names the interface members it declares', () => {
  const expected = fs.readFileSync(path.join(ROOT, 'test/expected/csharp.txt'), 'utf8');
  assert.ok(/interface IUserRepository/.test(expected));
  assert.ok(/FindById/.test(expected) && /SaveAsync/.test(expected),
    'test/expected/csharp.txt still records the interface with no members');
});

test('no committed expectation contains a duplicate signature', () => {
  for (const dir of ['test/expected', 'test/expected-adversarial']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const lines = fs.readFileSync(path.join(ROOT, dir, f), 'utf8').split('\n').filter(Boolean).map((l) => l.trim());
      const d = lines.filter((l, i) => lines.indexOf(l) !== i && /\(/.test(l));
      assert.strictEqual(d.length, 0, `${dir}/${f} asserts duplicates: ${[...new Set(d)].join(', ')}`);
    }
  }
});

console.log(`\n  nested-types: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
