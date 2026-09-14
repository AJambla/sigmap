'use strict';

/**
 * T4 SCIP import (#618, #542): read a CI-produced index.scip as a signature
 * source, quality-guarded, silent fallback. Hermetic: the test writes its own
 * minimal-but-valid SCIP index with a ~30-line protobuf wire writer (the
 * reader's inverse), so CI needs no SCIP tooling. The real scip-typescript
 * measurement is recorded in the PR.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');
const { parseIndex } = require(path.join(ROOT, 'src/scip/reader'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// ── protobuf wire writer (inverse of src/scip/reader.js) ───────────────────
function varint(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const lenDelim = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const str = (field, s) => lenDelim(field, Buffer.from(s, 'utf8'));
const num = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const packed = (field, nums) => lenDelim(field, Buffer.concat(nums.map(varint)));

function buildIndex({ relPath, symbols, defs }) {
  const toolInfo = Buffer.concat([str(1, 'fake-scip'), str(2, '9.9.9')]);
  const metadata = lenDelim(2, toolInfo);
  const symBufs = symbols.map((s) => lenDelim(3, Buffer.concat([
    str(1, s.symbol), ...s.docs.map((d) => str(3, d)),
  ])));
  const occBufs = defs.map((d) => lenDelim(2, Buffer.concat([
    packed(1, d.range), str(2, d.symbol), num(3, 1),
    ...(d.enclosing ? [packed(7, d.enclosing)] : []),
  ])));
  const doc = lenDelim(2, Buffer.concat([str(1, relPath), ...symBufs, ...occBufs]));
  return Buffer.concat([lenDelim(1, metadata), doc]);
}

const RICH_INDEX = (relPath) => buildIndex({
  relPath,
  symbols: [
    { symbol: 'x/Widget#', docs: ['```ts\nclass Widget<T>\n```'] },
    { symbol: 'x/Widget#spin().', docs: ['```ts\n(method) spin(n: number): void\n```', 'Spins the widget.'] },
    { symbol: 'x/Widget#spin().(n)', docs: ['```ts\n(parameter) n: number\n```'] },
    { symbol: 'x/make().', docs: ['```ts\nfunction make(label: string): Widget<string>\n```'] },
    { symbol: 'x/other().', docs: ['```ts\nfunction other(): void\n```'] },
  ],
  defs: [
    { symbol: 'x/Widget#', range: [0, 6, 12], enclosing: [0, 0, 5, 1] },
    { symbol: 'x/Widget#spin().', range: [2, 7, 11], enclosing: [2, 2, 4, 3] },
    { symbol: 'x/Widget#spin().(n)', range: [2, 12, 13] },
    { symbol: 'x/make().', range: [7, 9, 13], enclosing: [7, 0, 9, 1] },
    { symbol: 'x/other().', range: [9, 0, 5] },
  ],
});

const CPP_LIKE_TS = 'class Widget {\n  n = 1;\n  spin(n) {\n    return n;\n  }\n}\nmodule.exports = { Widget };\nfunction make(label) {\n  return new Widget();\n}\n';

function repo(exactness) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-scip-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widget.js'), CPP_LIKE_TS);
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({
    srcDirs: ['src'], exactness, changes: false,
  }));
  return dir;
}
function generate(dir) {
  execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  return fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
}
const stable = (s) => s.split('\n').filter((l) => !/<!-- Updated:/.test(l)).join('\n');

test('reader round-trips the writer output', () => {
  const idx = parseIndex(RICH_INDEX('src/widget.js'));
  assert.strictEqual(idx.tool, 'fake-scip@9.9.9');
  const doc = idx.documents.get('src/widget.js');
  assert.ok(doc && doc.symbols.size === 5 && doc.defs.length === 5);
  assert.deepStrictEqual(doc.defs[1].enclosing, [2, 2, 4, 3]);
});

const offOut = generate(repo({ scip: false }));

test('flag on with no index.scip falls back byte-identical, no label', () => {
  const dir = repo({ scip: true });
  const out = generate(dir);
  assert.strictEqual(stable(out), stable(offOut));
  assert.ok(!/toolchain=/.test(out));
});

test('a corrupt index.scip falls back byte-identical, no label', () => {
  const dir = repo({ scip: true });
  fs.writeFileSync(path.join(dir, 'index.scip'), Buffer.from([0xff, 0x07, 0x99, 0x03, 0x01]));
  const out = generate(dir);
  assert.strictEqual(stable(out), stable(offOut));
  assert.ok(!/toolchain=/.test(out));
});

test('a rich index entry lands with anchors, hint, and acceptance-gated label', () => {
  const dir = repo({ scip: true });
  fs.writeFileSync(path.join(dir, 'index.scip'), RICH_INDEX('src/widget.js'));
  const out = generate(dir);
  assert.ok(out.includes('class Widget<T>  :1-6'), 'container with enclosing-range anchor missing');
  assert.ok(out.includes('  (method) spin(n: number): void  :3-5  # Spins the widget'), 'typed member + hint missing');
  assert.ok(out.includes('function make(label: string): Widget<string>  :8-10'), 'function missing');
  assert.ok(!out.includes('(parameter)'), 'parameter symbols must be filtered');
  assert.ok(out.includes('toolchain=scip:fake-scip@9.9.9'), `label missing: ${out.match(/sigmap:[^\n]*/)}`);
});

test('quality guard: a sparse index entry is refused, regex kept, no label', () => {
  const dir = repo({ scip: true });
  fs.writeFileSync(path.join(dir, 'index.scip'), buildIndex({
    relPath: 'src/widget.js',
    symbols: [{ symbol: 'x/lone().', docs: ['```ts\nfunction lone(): void\n```'] }],
    defs: [{ symbol: 'x/lone().', range: [0, 0, 4] }],
  }));
  const out = generate(dir);
  assert.ok(!out.includes('lone'), 'sparse SCIP entry must be refused by the guard');
  assert.ok(/Widget/.test(out), 'regex output must be retained');
  assert.ok(!/toolchain=/.test(out), 'a refused result must not label the header');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
