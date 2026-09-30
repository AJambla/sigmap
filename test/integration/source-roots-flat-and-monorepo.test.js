'use strict';

/**
 * Integration tests for source-root and workspace detection.
 *
 *   #805 — a flat layout (Go's normal shape) must index the repo root, must not
 *          prefer a fixture directory over it, and the miss must be VISIBLE in
 *          `validate` and `doctor` rather than hidden behind a plausible
 *          coverage percentage.
 *   #781 — `roots`, `tune` and `--monorepo` must agree, and must name the
 *          evidence behind the verdict.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'gen-context.js');

const { resolveSourceRoots } = require(path.join(ROOT, 'src/discovery/source-root-resolver'));
const { detectMonorepo, layoutPackages, workspaceMarker } = require(path.join(ROOT, 'src/discovery/monorepo'));
const { outsideSrcDirs } = require(path.join(ROOT, 'src/analysis/coverage-score'));
const { PENALTY_DIRS } = require(path.join(ROOT, 'src/discovery/source-root-scorer'));
const { diagnose } = require(path.join(ROOT, 'src/doctor/diagnose'));

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

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-roots-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

// spawnSync, not execFileSync: the disclosures under test are written with
// `console.warn` (stderr), and execFileSync's return value carries stdout only.
function cli(dir, argv) {
  const r = spawnSync('node', [CLI, ...argv], { cwd: dir, encoding: 'utf8' });
  return { out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', code: r.status };
}

/** The gin shape from #805: source at the root, plus a Go fixture dir. */
function flatGoRepo(extra = {}) {
  const files = { 'go.mod': 'module example.com/flat\n\ngo 1.21\n' };
  for (const n of ['gin', 'routergroup', 'context', 'tree', 'errors', 'recovery']) {
    files[`${n}.go`] = `package gin\n\nfunc ${n[0].toUpperCase()}${n.slice(1)}Handler() {}\n`;
  }
  files['internal/helper.go'] = 'package internal\n\nfunc Helper() {}\n';
  files['testdata/fixture.go'] = 'package testdata\n\nvar Fixture = 1\n';
  files['render/render.go'] = 'package render\n\nfunc Render() {}\n';
  return tmp(Object.assign(files, extra));
}

// ── #805: the repo root is a source root on a flat layout ──────────────────

test('#805 a flat Go layout selects the repo root', () => {
  const dir = flatGoRepo();
  try {
    const r = resolveSourceRoots(dir);
    assert.ok(r.roots.includes('.'), `expected '.' among roots, got ${JSON.stringify(r.roots)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 selecting the root collapses its subdirectories (no double walk)', () => {
  const dir = flatGoRepo();
  try {
    const r = resolveSourceRoots(dir);
    assert.deepStrictEqual(r.roots, ['.'],
      `'.' must be the only root once selected, got ${JSON.stringify(r.roots)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 testdata is never preferred as a source root', () => {
  assert.ok(PENALTY_DIRS.has('testdata'), 'testdata must be a penalised directory');
  const dir = flatGoRepo();
  try {
    const r = resolveSourceRoots(dir);
    assert.ok(!r.roots.includes('testdata'),
      `testdata must not be a source root, got ${JSON.stringify(r.roots)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 a go.mod with root-level .go files qualifies the root structurally', () => {
  // Only ONE root .go file — below any share threshold. The go.mod rule is what
  // must carry it, because a Go module root IS a package.
  const dir = tmp({
    'go.mod': 'module example.com/x\n\ngo 1.21\n',
    'main.go': 'package main\n\nfunc main() {}\n',
    'internal/a/a.go': 'package a\n\nfunc A() {}\n',
    'internal/b/b.go': 'package b\n\nfunc B() {}\n',
    'internal/c/c.go': 'package c\n\nfunc C() {}\n',
    'internal/d/d.go': 'package d\n\nfunc D() {}\n',
    'internal/e/e.go': 'package e\n\nfunc E() {}\n',
  });
  try {
    const r = resolveSourceRoots(dir);
    assert.ok(r.roots.includes('.'), `a Go module root must be a source root, got ${JSON.stringify(r.roots)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 a conventional src/ layout does NOT gain the root', () => {
  const files = { 'package.json': '{"name":"x","version":"1.0.0"}', 'index.js': 'module.exports = {};\n' };
  for (let i = 0; i < 12; i++) files[`src/mod${i}.js`] = `function f${i}() {}\nmodule.exports = { f${i} };\n`;
  const dir = tmp(files);
  try {
    const r = resolveSourceRoots(dir);
    assert.ok(!r.roots.includes('.'),
      `a src/-shaped repo must not select the root, got ${JSON.stringify(r.roots)}`);
    assert.ok(r.roots.includes('src'), `expected src among roots, got ${JSON.stringify(r.roots)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 this repo is unaffected — src/ stays the root, not .', () => {
  const r = resolveSourceRoots(ROOT);
  assert.ok(!r.roots.includes('.'), `SigMap must not select '.', got ${JSON.stringify(r.roots)}`);
  assert.ok(r.roots.includes('src'), `expected src among roots, got ${JSON.stringify(r.roots)}`);
});

test('#805 a flat repo indexes its root files end to end', () => {
  const dir = flatGoRepo();
  try {
    cli(dir, []);
    const r = cli(dir, ['explain', 'gin.go']);
    assert.ok(/INCLUDED/.test(r.out), `gin.go must be INCLUDED with default config:\n${r.out}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── #805: the miss is visible ──────────────────────────────────────────────

test('#805 outsideSrcDirs counts implementation files the srcDirs missed', () => {
  const dir = flatGoRepo();
  try {
    const o = outsideSrcDirs(dir, { srcDirs: ['internal', 'render', 'testdata'], exclude: [] });
    assert.strictEqual(o.total, 6, `expected the 6 root .go files, got ${o.total}`);
    assert.ok(o.byExt.some((e) => e.ext === '.go'), 'the extension breakdown must name .go');
    assert.ok(o.share > 0.5, `share must reflect a majority miss, got ${o.share}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 tests, docs, CI and tooling dirs are not counted as a miss', () => {
  const dir = tmp({
    'package.json': '{"name":"x","version":"1.0.0"}',
    'src/a.js': 'module.exports = {};\n',
    'test/a.test.js': 'test();\n',
    'scripts/build.mjs': 'export default 1;\n',
    'docs/guide.js': 'module.exports = 1;\n',
    '.github/workflows/ci.yml': 'name: ci\n',
  });
  try {
    const o = outsideSrcDirs(dir, { srcDirs: ['src'], exclude: [] });
    assert.strictEqual(o.total, 0, `conventional out-of-scope dirs must not count, got ${o.total} (${JSON.stringify(o.byExt)})`);
    assert.ok(o.skipped > 0, 'they must be reported as skipped rather than ignored silently');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 a srcDirs of "." means nothing can be outside it', () => {
  const dir = flatGoRepo();
  try {
    const o = outsideSrcDirs(dir, { srcDirs: ['.'], exclude: [] });
    assert.strictEqual(o.total, 0, 'a root srcDir covers the whole tree');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 validate reports the miss on a wrongly configured flat repo', () => {
  const dir = flatGoRepo({ 'gen-context.config.json': JSON.stringify({ srcDirs: ['internal', 'render', 'testdata'] }) });
  try {
    cli(dir, []);
    const r = cli(dir, ['validate']);
    assert.ok(/OUTSIDE srcDirs/.test(r.out), `validate must disclose the miss:\n${r.out}`);
    assert.ok(/\.go/.test(r.out), 'the breakdown must name the extension');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 validate --json carries the outsideSrcDirs figure', () => {
  const dir = flatGoRepo({ 'gen-context.config.json': JSON.stringify({ srcDirs: ['internal'] }) });
  try {
    cli(dir, []);
    const r = cli(dir, ['validate', '--json']);
    const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const j = JSON.parse(line);
    assert.ok(j.outsideSrcDirs, 'payload must carry outsideSrcDirs');
    assert.ok(j.outsideSrcDirs.total > 0, `expected a non-zero count, got ${j.outsideSrcDirs.total}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 doctor surfaces the same count', () => {
  const dir = flatGoRepo({ 'gen-context.config.json': JSON.stringify({ srcDirs: ['internal', 'render', 'testdata'] }) });
  try {
    const d = diagnose(dir);
    const check = d.checks.find((c) => c.id === 'srcdirs-coverage');
    assert.ok(check, 'doctor must carry a srcdirs-coverage check');
    assert.strictEqual(check.status, 'warn', `expected warn, got ${check.status}: ${check.detail}`);
    assert.ok(/OUTSIDE srcDirs/.test(check.detail), `detail must name the miss: ${check.detail}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#805 doctor does not cry wolf on a correct layout', () => {
  const files = { 'package.json': '{"name":"x","version":"1.0.0"}' };
  for (let i = 0; i < 12; i++) files[`src/mod${i}.js`] = `module.exports = ${i};\n`;
  const dir = tmp(files);
  try {
    const d = diagnose(dir);
    const check = d.checks.find((c) => c.id === 'srcdirs-coverage');
    assert.ok(check, 'the check must still run');
    assert.strictEqual(check.status, 'ok', `a correct layout must not warn: ${check.detail}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── #781: one monorepo verdict, with evidence ──────────────────────────────

test('#781 a declared workspace is detected, and names the marker', () => {
  const dir = tmp({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","version":"1.0.0"}',
  });
  try {
    const m = detectMonorepo(dir);
    assert.strictEqual(m.isMonorepo, true);
    assert.strictEqual(m.source, 'marker');
    assert.ok(/pnpm-workspace\.yaml/.test(m.evidence), `evidence must name the marker: ${m.evidence}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#781 a layout-only monorepo is detected, and says so', () => {
  const dir = tmp({
    'package.json': '{"name":"root","version":"1.0.0"}',
    'packages/core/package.json': '{"name":"core","version":"1.0.0"}',
    'packages/cli/package.json': '{"name":"cli","version":"1.0.0"}',
  });
  try {
    const m = detectMonorepo(dir);
    assert.strictEqual(m.isMonorepo, true, 'two sibling manifests is a monorepo');
    assert.strictEqual(m.source, 'layout');
    assert.ok(/layout: 2 manifests/.test(m.evidence), `evidence must name the layout: ${m.evidence}`);
    assert.strictEqual(m.marker, null, 'a layout match must be distinguishable from a declared one');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#781 one package under packages/ is not a monorepo', () => {
  const dir = tmp({
    'package.json': '{"name":"root","version":"1.0.0"}',
    'packages/only/package.json': '{"name":"only","version":"1.0.0"}',
  });
  try {
    const m = detectMonorepo(dir);
    assert.strictEqual(m.isMonorepo, false, 'a single package is an ordinary layout');
    assert.ok(/needs 2/.test(m.evidence), `evidence must explain the shortfall: ${m.evidence}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#781 non-JS manifests count as packages', () => {
  const dir = tmp({
    'packages/a/Cargo.toml': '[package]\nname = "a"\n',
    'packages/b/pyproject.toml': '[project]\nname = "b"\n',
  });
  try {
    const pkgs = layoutPackages(dir);
    assert.strictEqual(pkgs.length, 2, `expected 2 packages, got ${JSON.stringify(pkgs)}`);
    assert.ok(detectMonorepo(dir).isMonorepo, 'a polyglot workspace is still a workspace');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#781 a plain repo is not a monorepo', () => {
  const dir = tmp({ 'package.json': '{"name":"x","version":"1.0.0"}', 'src/a.js': 'module.exports=1;\n' });
  try {
    const m = detectMonorepo(dir);
    assert.strictEqual(m.isMonorepo, false);
    assert.strictEqual(workspaceMarker(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#781 the resolver reports the shared verdict and its evidence', () => {
  const dir = tmp({
    'package.json': '{"name":"root","version":"1.0.0"}',
    'packages/core/package.json': '{"name":"core","version":"1.0.0"}',
    'packages/core/src/a.js': 'module.exports=1;\n',
    'packages/cli/package.json': '{"name":"cli","version":"1.0.0"}',
    'packages/cli/src/b.js': 'module.exports=2;\n',
  });
  try {
    const r = resolveSourceRoots(dir);
    assert.strictEqual(r.isMonorepo, true, 'the resolver must agree with the shared detector');
    assert.ok(r.monorepo && /layout/.test(r.monorepo.evidence), `evidence must be carried out: ${JSON.stringify(r.monorepo)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#781 roots, tune and --monorepo agree on THIS repo', () => {
  const r = resolveSourceRoots(ROOT);
  const m = detectMonorepo(ROOT);
  const { buildTuneProposal } = require(path.join(ROOT, 'src/config/tune'));
  const t = buildTuneProposal(ROOT);
  assert.strictEqual(r.isMonorepo, m.isMonorepo, 'resolver and detector must agree');
  assert.strictEqual(t.detection.isMonorepo, m.isMonorepo, 'tune and detector must agree');
  assert.ok(m.packages.length >= 2, `--monorepo processes ${m.packages.length} packages; the verdict must reflect that`);
  assert.ok(t.detection.monorepoEvidence, 'tune must carry the evidence');
});

test('#781 there is exactly one monorepo detector left', () => {
  const resolverSrc = fs.readFileSync(path.join(ROOT, 'src/discovery/source-root-resolver.js'), 'utf8');
  const tuneSrc = fs.readFileSync(path.join(ROOT, 'src/config/tune.js'), 'utf8');
  for (const [name, src] of [['resolver', resolverSrc], ['tune', tuneSrc]]) {
    assert.ok(/require\(['"][^'"]*monorepo['"]\)/.test(src), `${name} must consume src/discovery/monorepo.js`);
    assert.ok(!/MONOREPO_MARKERS\s*=/.test(src), `${name} must not keep its own marker list`);
  }
});

test('#781 roots output names the evidence', () => {
  const r = cli(ROOT, ['roots']);
  assert.ok(/Monorepo:\s*yes/.test(r.out), `expected a yes verdict on this repo:\n${r.out.slice(0, 400)}`);
  assert.ok(/layout: \d+ manifests/.test(r.out), `output must name the evidence:\n${r.out.slice(0, 400)}`);
});

console.log(`\nsource-roots-flat-and-monorepo: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
