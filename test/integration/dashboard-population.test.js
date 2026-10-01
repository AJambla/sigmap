'use strict';

/**
 * The dashboard owns neither its output path nor its language list (#828).
 *
 * Two defects in one command. `--dashboard` wrote into `benchmarks/reports/`,
 * a directory SigMap does not own — in a consumer repo it either does not
 * exist, so SigMap creates it, or it means something else entirely, and either
 * way the file lands outside the `.context/` line `--init` gitignores.
 *
 * And its coverage panel graded against a hardcoded 21-entry `LANGUAGE_KEYS`
 * while the project ships 36 languages, so a repo written in Elixir, Lua, R or
 * Terraform read as 0% covered. The denominator was only half of it: a second
 * extension map inside `detectLanguage` recognised the same 21, so the
 * numerator could never reach a widened denominator — fixing one without the
 * other would have made the figure worse, not better.
 *
 * These tests pin the output path, assert nothing is created outside
 * `.context/`, and tie the denominator to the two other places that publish a
 * language count, so the next extractor addition cannot leave any of the three
 * stale.
 *
 * Run: node test/integration/dashboard-population.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const GEN = path.join(ROOT, 'gen-context.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const run = (dir, args) => {
  try { return execFileSync(process.execPath, [GEN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 30000 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

/** A repo whose languages the old 21-entry list could not see at all. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-dash-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.ex'), 'defmodule A do\n  def go(x), do: x\nend\n');
  fs.writeFileSync(path.join(src, 'b.lua'), 'local function f(a) return a end\nreturn f\n');
  fs.writeFileSync(path.join(src, 'c.R'), 'f <- function(x) x + 1\n');
  fs.writeFileSync(path.join(src, 'd.tf'), 'resource "aws_s3_bucket" "b" {}\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'),
    JSON.stringify({ srcDirs: ['src'], maxTokens: 6000, outputs: ['copilot'] }));
  run(dir, []);
  return dir;
}

/** Top-level entries a run created, excluding what the fixture itself wrote. */
const topLevel = (dir) => fs.readdirSync(dir).sort();

// ---------------------------------------------------------------------------
// #782 — output path
// ---------------------------------------------------------------------------

test('--dashboard writes .context/dashboard.html by default', () => {
  const dir = makeRepo();
  const out = run(dir, ['--dashboard']);
  assert.ok(fs.existsSync(path.join(dir, '.context', 'dashboard.html')),
    `expected .context/dashboard.html, got: ${out}`);
  assert.ok(/dashboard written: \.context\/dashboard\.html/.test(out), `got: ${out}`);
});

test('--dashboard creates no directory outside .context/', () => {
  const dir = makeRepo();
  const before = topLevel(dir);
  run(dir, ['--dashboard']);
  const after = topLevel(dir);
  const created = after.filter((e) => !before.includes(e));
  assert.deepStrictEqual(created, [], `--dashboard created ${JSON.stringify(created)} outside .context/`);
  assert.ok(!fs.existsSync(path.join(dir, 'benchmarks')), 'must not create benchmarks/');
});

test('--dashboard --out writes to the given path and creates its parent', () => {
  const dir = makeRepo();
  const out = run(dir, ['--dashboard', '--out', 'reports/deep/custom.html']);
  assert.ok(fs.existsSync(path.join(dir, 'reports', 'deep', 'custom.html')),
    `expected reports/deep/custom.html, got: ${out}`);
  assert.ok(!fs.existsSync(path.join(dir, '.context', 'dashboard.html')),
    '--out must replace the default, not write both');
});

test('--dashboard --json reports the path actually written', () => {
  const dir = makeRepo();
  const def = JSON.parse(run(dir, ['--dashboard', '--json']).trim().split('\n').pop());
  assert.strictEqual(def.ok, true);
  assert.strictEqual(def.file.replace(/\\/g, '/'), '.context/dashboard.html');

  const custom = JSON.parse(run(dir, ['--dashboard', '--json', '--out', 'x/y.html']).trim().split('\n').pop());
  assert.strictEqual(custom.file.replace(/\\/g, '/'), 'x/y.html');
});

test('--help advertises the real default path', () => {
  const help = run(process.cwd(), ['--help']);
  assert.ok(/--dashboard/.test(help), 'help must document --dashboard');
  assert.ok(!/benchmarks\/reports\/dashboard\.html/.test(help),
    'help must not advertise the old benchmarks/reports path');
  assert.ok(/\.context\/dashboard\.html/.test(help), 'help must name .context/dashboard.html');
});

// ---------------------------------------------------------------------------
// #663 — one language list
// ---------------------------------------------------------------------------

test('dispatch.LANGUAGES reproduces the canonical derived list exactly', () => {
  const { LANGUAGES } = require(path.join(ROOT, 'src', 'extractors', 'dispatch.js'));
  const meta = require(path.join(ROOT, 'version.json'));
  assert.strictEqual(LANGUAGES.length, meta.languages,
    `dispatch.LANGUAGES (${LANGUAGES.length}) must equal version.json.languages (${meta.languages})`);
  // Sorted and deduplicated, so the comparison above is order-independent.
  assert.deepStrictEqual(LANGUAGES, [...new Set(LANGUAGES)].sort());
});

test('the dashboard denominator is the live language count, not 21', () => {
  const { computeExtractorCoverage } = require(path.join(ROOT, 'src', 'format', 'dashboard.js'));
  const { LANGUAGES } = require(path.join(ROOT, 'src', 'extractors', 'dispatch.js'));
  const meta = require(path.join(ROOT, 'version.json'));
  const dir = makeRepo();
  const cov = computeExtractorCoverage(dir);
  assert.strictEqual(cov.supported, LANGUAGES.length, 'denominator must come from dispatch');
  assert.strictEqual(cov.supported, meta.languages, 'denominator must match version.json');
  assert.notStrictEqual(cov.supported, 21, 'the stale hardcoded denominator must be gone');
});

test('languages the old list could not see now count toward the numerator', () => {
  const { computeExtractorCoverage } = require(path.join(ROOT, 'src', 'format', 'dashboard.js'));
  const dir = makeRepo();
  const cov = computeExtractorCoverage(dir);
  for (const lang of ['elixir', 'lua', 'r', 'terraform']) {
    assert.strictEqual(cov.perLanguage[lang], 1, `${lang} must be detected (was invisible before)`);
  }
  assert.strictEqual(cov.covered, 4, `expected 4 covered languages, got ${cov.covered}`);
  assert.ok(cov.pct > 0, 'a repo in four supported languages cannot be 0% covered');
});

test('dashboard.js keeps no private copy of the language set', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'format', 'dashboard.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/const\s+LANGUAGE_KEYS\s*=/.test(code), 'LANGUAGE_KEYS must be gone');
  assert.ok(/require\('\.\.\/extractors\/dispatch'\)/.test(code),
    'dashboard must source languages from dispatch');
  // The old detectLanguage was a second extension map; it must not come back.
  const extTests = (code.match(/ext === '\.[a-z]+'/g) || []).length;
  assert.strictEqual(extTests, 0, `dashboard must not re-declare an extension map (${extTests} ext checks found)`);
});

test('the per-language chart carries no hardcoded label list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'format', 'dashboard.js'), 'utf8');
  const fn = src.slice(src.indexOf('function barChartSvg('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/\['ts',\s*'js'/.test(body), 'the positional abbreviation list must be gone');
  assert.ok(/perLanguage/.test(body), 'the chart must render from the computed counts');
});

test('the chart degrades to an empty state with no supported files', () => {
  const { generateDashboardHtml } = require(path.join(ROOT, 'src', 'format', 'dashboard.js'));
  const { score } = require(path.join(ROOT, 'src', 'health', 'scorer.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-dash-empty-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'notes.bin'), 'not a supported language\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'] }));
  const out = generateDashboardHtml(dir, score(dir));
  assert.ok(out.html.includes('no files in a supported language'),
    'must render an empty state rather than a chart of 36 zero bars');
  assert.ok(!/NaN|Infinity/.test(out.html), 'empty state must not emit NaN/Infinity');
});

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
