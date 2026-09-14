'use strict';

/**
 * T3 LSP-client spike (#612, #542): opt-in documentSymbol extraction with
 * cache + silent fallback, tested hermetically against a fake LSP server
 * that speaks the real framed protocol — no host tools required, so every
 * case here runs in CI. The real-server measurement (clangd) is recorded in
 * the PR.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');
const FAKE = path.join(__dirname, 'fake-server.js');
const { parseFrames, frame } = require(path.join(ROOT, 'src/lsp/client'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const CPP_SRC = 'class Widget {\npublic:\n  void spin(int n) {\n    (void)n;\n  }\n};\n';

function repo(exactness) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-lsp-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widget.cpp'), CPP_SRC);
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({
    srcDirs: ['src'],
    exactness,
    changes: false,
  }));
  return dir;
}

function generate(dir, env) {
  execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
  return fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
}
const stable = (s) => s.split('\n').filter((l) => !/<!-- Updated:/.test(l)).join('\n');

test('frame/parseFrames round-trip', () => {
  const msgs = parseFrames(frame({ a: 1 }) + frame({ b: 'x' }));
  assert.deepStrictEqual(msgs, [{ a: 1 }, { b: 'x' }]);
});

const offOut = generate(repo({ lsp: false }), {});

test('server absent for the extension falls back byte-identical, no label', () => {
  const dir = repo({ lsp: true, lspServers: { '.cpp': ['sigmap-no-such-lsp-server'] } });
  const out = generate(dir, {});
  assert.strictEqual(stable(out), stable(offOut));
  assert.ok(!/toolchain=/.test(out));
});

test('a crashing server falls back byte-identical, no label', () => {
  const dir = repo({ lsp: true, lspServers: { '.cpp': ['node', '-e', 'process.exit(1)'] } });
  const out = generate(dir, {});
  assert.strictEqual(stable(out), stable(offOut));
  assert.ok(!/toolchain=/.test(out));
});

test('fake server: LSP symbols land in the artifact with anchors and label', () => {
  const dir = repo({ lsp: true, lspServers: { '.cpp': ['node', FAKE] } });
  const out = generate(dir, {});
  assert.ok(out.includes('class Widget  :1-10'), 'container line missing');
  assert.ok(out.includes('  spin: void (int)  :3-5'), 'member line missing');
  assert.ok(out.includes('makeWidget: Widget (const char *)  :12-15'), 'function line missing');
  assert.ok(out.includes('toolchain=fake-lsp@1.2.3'), `label missing: ${out.match(/sigmap:[^\n]*/)}`);
});

test('cache: a second run spawns no server and keeps output + label', () => {
  const dir = repo({ lsp: true, lspServers: { '.cpp': ['node', FAKE] } });
  const counter = path.join(dir, 'spawn-count');
  const first = generate(dir, { FAKE_LSP_COUNT_FILE: counter });
  assert.strictEqual(fs.readFileSync(counter, 'utf8').length, 1, 'first run must spawn once');
  fs.rmSync(path.join(dir, '.github'), { recursive: true, force: true });
  const second = generate(dir, { FAKE_LSP_COUNT_FILE: counter });
  assert.strictEqual(fs.readFileSync(counter, 'utf8').length, 1, 'second run must be served from cache');
  assert.strictEqual(stable(second), stable(first));
  assert.ok(/toolchain=fake-lsp@1\.2\.3/.test(second), 'label must survive a cache hit');
});

test('quality guard: a sparser-than-regex LSP result is refused, no label', () => {
  const dir = repo({ lsp: true, lspServers: { '.cpp': ['node', FAKE] } });
  const out = generate(dir, { FAKE_LSP_SPARSE: '1' });
  assert.ok(!/toolchain=/.test(out), 'a refused result must not label the header');
  assert.ok(!out.includes('mystery'), 'the sparse LSP symbols must not appear');
  assert.ok(/Widget/.test(out), 'the regex tier output must be retained');
});

test('cache invalidates on content change (server spawns again)', () => {
  const dir = repo({ lsp: true, lspServers: { '.cpp': ['node', FAKE] } });
  const counter = path.join(dir, 'spawn-count');
  generate(dir, { FAKE_LSP_COUNT_FILE: counter });
  fs.appendFileSync(path.join(dir, 'src', 'widget.cpp'), '// edit\n');
  generate(dir, { FAKE_LSP_COUNT_FILE: counter });
  assert.strictEqual(fs.readFileSync(counter, 'utf8').length, 2, 'edited file must re-query the server');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
