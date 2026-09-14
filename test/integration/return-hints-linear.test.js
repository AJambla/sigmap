'use strict';

/**
 * buildReturnHints must be linear and bind correctly (#615).
 *
 * The old implementation's lazy gaps scanned across comment boundaries:
 * quadratic on docblock-dense files (93.6% of a 15s self-generate), and it
 * could bind a hint to a LATER declaration through intervening comments —
 * src/health/scorer.js's composeHealth carried a distant `object` tag
 * instead of its own docblock's type. Both are pinned here.
 */

const assert = require('assert');
const { extract } = require('../../src/extractors/javascript');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

test('a @returns hint binds to the immediately following declaration only', () => {
  const src = [
    '/** @returns {WrongType} first doc with no decl after it */',
    'const x = 1;',
    '/** Second doc. */',
    'function target(a) {',
    '  return a;',
    '}',
    'module.exports = { target };',
    '',
  ].join('\n');
  const sigs = extract(src);
  const line = sigs.find((s) => s.includes('function target'));
  assert.ok(line, 'target must be extracted');
  assert.ok(!line.includes('WrongType'),
    `a hint crossed an intervening comment to a later declaration: ${line}`);
});

test('a correctly placed @returns hint still lands', () => {
  const src = '/** Doc. @returns {Widget} */\nfunction make(a) {\n  return a;\n}\nmodule.exports = { make };\n';
  const sigs = extract(src);
  const line = sigs.find((s) => s.includes('function make'));
  assert.ok(line && line.includes('→ Widget'), `hint missing: ${line}`);
});

test('docblock-dense input extracts in linear-ish time', () => {
  // 3000 docblocks with @returns and no following declaration — the old
  // implementation scanned each one toward end-of-file (minutes); the
  // linear pass must stay well under a generous bound even on slow CI.
  const chunk = '/** Something.\n * @returns {Thing} a thing\n */\nconst v_IDX = IDX;\n';
  const src = Array.from({ length: 3000 }, (_, i) => chunk.replace(/IDX/g, String(i))).join('\n')
    + '\nfunction tail(a) { return a; }\nmodule.exports = { tail };\n';
  const t0 = Date.now();
  const sigs = extract(src);
  const elapsed = Date.now() - t0;
  assert.ok(Array.isArray(sigs) && sigs.length > 0);
  assert.ok(elapsed < 5000, `extraction took ${elapsed}ms — quadratic scanning is back`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
