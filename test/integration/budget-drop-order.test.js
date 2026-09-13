'use strict';

/**
 * Token-budget drop order must recognise JVM test conventions and protect
 * entry points (#592).
 *
 * "Drop test files first" ran INVERTED on JVM repos: isTestFile() only matched
 * `.test.` / `.spec.` / `_test.` filename patterns, so `src/test/java/**` and
 * `*Tests.java` files sailed past the check and competed as ordinary
 * production code — and won on recency. On spring-petclinic the budget kept
 * all 17 test files while dropping the application entry point, the owner
 * entities and every owner template; the retrieval benchmark could not return
 * files that were not there.
 *
 * The fixture makes the failure deterministic: test files carry NEWER mtimes
 * than production (the tie-break the old equal-priority code decided on), and
 * the budget fits all production but not production + tests. Under the old
 * classification the newest files — the tests — were kept and production
 * dropped; under the fixed classification tests drop first regardless of
 * recency.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

function javaClass(name, methods) {
  const body = Array.from({ length: methods }, (_, i) =>
    `  public String ${name.toLowerCase()}Method${i}(String arg${i}, int count${i}) {\n    return arg${i};\n  }`).join('\n');
  return `public class ${name} {\n${body}\n}\n`;
}

/** JVM-layout repo where the budget fits production but not production+tests. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-droporder-'));
  const main = path.join(dir, 'src', 'main', 'java', 'com', 'acme');
  const tst = path.join(dir, 'src', 'test', 'java', 'com', 'acme');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(tst, { recursive: true });

  const prod = [];
  // Tiny entry point: fewest sigs of any production file.
  prod.push(path.join(main, 'AcmeApplication.java'));
  fs.writeFileSync(prod[0],
    'public class AcmeApplication {\n  public static void main(String[] args) {\n  }\n}\n');
  // `contest.java`: lowercase "test" inside a word must NOT classify as a test.
  prod.push(path.join(main, 'contest.java'));
  fs.writeFileSync(prod[1], javaClass('contest', 6));
  for (let i = 0; i < 5; i++) {
    const p = path.join(main, `Service${i}.java`);
    fs.writeFileSync(p, javaClass(`Service${i}`, 8));
    prod.push(p);
  }
  const tests = [];
  for (let i = 0; i < 5; i++) {
    const p = path.join(tst, `Service${i}Tests.java`);
    fs.writeFileSync(p, javaClass(`Service${i}Tests`, 16));
    tests.push(p);
  }

  // Deterministic recency: tests strictly newer than production, so the old
  // equal-priority code (which tie-broke on mtime, newest first) kept them.
  const now = Date.now() / 1000;
  for (const p of prod) fs.utimesSync(p, now - 3600, now - 3600);
  for (const p of tests) fs.utimesSync(p, now + 60, now + 60);

  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({
    srcDirs: ['src'],
    maxTokens: 1400,
    autoMaxTokens: false,
    changes: false,
  }));
  return dir;
}

const dir = repo();
const res = spawnSync('node', [CLI], { cwd: dir, encoding: 'utf8' });
const out = (res.stdout || '') + (res.stderr || '');
const ctxPath = path.join(dir, '.github', 'copilot-instructions.md');
const ctx = fs.existsSync(ctxPath) ? fs.readFileSync(ctxPath, 'utf8') : '';

test('budget engaged (fixture actually overflows)', () => {
  assert.ok(/budget: dropped/.test(out), `expected a drop report in output:\n${out.slice(0, 600)}`);
});

test('newer JVM-convention tests drop before older production code', () => {
  const prodKept = (ctx.match(/### src\/main\/\S+\.java/g) || []).length;
  const testsKept = (ctx.match(/### src\/test\//g) || []).length;
  assert.strictEqual(prodKept, 7,
    `only ${prodKept} of 7 production files survived — production dropped while tests competed as ordinary code`);
  assert.ok(testsKept < 5,
    `all 5 src/test/ files kept — test detection missed the src/test/**/*Tests.java convention`);
});

test('the tiny entry point survives the fewest-sigs tie-break', () => {
  assert.ok(ctx.includes('### src/main/java/com/acme/AcmeApplication.java'),
    'AcmeApplication.java (the entry point) was dropped from the context');
});

test('lowercase "test" inside a word does not classify a production file as a test', () => {
  assert.ok(ctx.includes('### src/main/java/com/acme/contest.java'),
    'contest.java was misclassified as a test file and dropped');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
