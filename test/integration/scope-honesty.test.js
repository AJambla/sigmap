'use strict';

/**
 * Two commands reported a narrower scope than they claimed (#831).
 *
 * `--diff <ref>` ran `git diff <ref>..HEAD`, which is ref-vs-HEAD and so
 * excludes the working tree — while the flag is documented as "changes since
 * <ref>". A developer with local edits got a diff that omitted exactly the
 * files they were editing (#667). The same wrong range existed twice, in the
 * CLI and in the `get_diff_context` MCP tool, so the two surfaces could answer
 * the same question differently.
 *
 * `--callers` printed `zero method blast radius` — an affirmative safety claim
 * — for symbols that are demonstrably called, because the graph walks srcDirs
 * only and cannot follow dynamic module loads (#768). It could not distinguish
 * "no caller exists" from "no edge was found", and that is precisely the claim
 * a developer leans on before changing a signature.
 *
 * Run: node test/integration/scope-honesty.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const GEN = path.join(ROOT, 'gen-context.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/** stdout + stderr — the `--diff` summary and risk table go to stderr. */
const run = (dir, args) => {
  const r = spawnSync(process.execPath, [GEN, ...args], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '') + (r.stderr || '');
};

/** stdout only — machine surfaces, so a warning cannot corrupt the JSON. */
const runOut = (dir, args) => {
  try { return execFileSync(process.execPath, [GEN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 30000 }); }
  catch (e) { return e.stdout || ''; }
};
const g = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

/** A repo with ONE committed change and ONE uncommitted change since HEAD~1. */
function makeDiffRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-scope-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  g(dir, ['init', '-q', '.']);
  g(dir, ['config', 'user.email', 't@t']);
  g(dir, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function alpha() { return 1; }\nmodule.exports = { alpha };\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'function beta() { return 2; }\nmodule.exports = { beta };\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'], outputs: ['copilot'] }));
  g(dir, ['add', '-A']); g(dir, ['commit', '-qm', 'base']);
  // committed change
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function alpha(x) { return x; }\nmodule.exports = { alpha };\n');
  g(dir, ['add', '-A']); g(dir, ['commit', '-qm', 'change a']);
  // uncommitted change
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'function beta(y) { return y * 2; }\nmodule.exports = { beta };\n');
  return dir;
}

const mcp = (dir, name, args) => {
  const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let out = '';
  try {
    out = execFileSync(process.execPath, [GEN, '--mcp'], { cwd: dir, input: req + '\n', encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  } catch (e) { out = e.stdout || ''; }
  for (const line of out.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      const t = j.result && j.result.content && j.result.content[0] && j.result.content[0].text;
      if (t) return t;
    } catch (_) { /* not a JSON-RPC line */ }
  }
  return '';
};

// ---------------------------------------------------------------------------
// #667 — "since <ref>" means since <ref>, working tree included
// ---------------------------------------------------------------------------

test('--diff <ref> includes an uncommitted change alongside the committed one', () => {
  const dir = makeDiffRepo();
  const out = run(dir, ['--diff', 'HEAD~1']);
  assert.ok(/src\/a\.js/.test(out), `committed change missing: ${out}`);
  assert.ok(/src\/b\.js/.test(out), `UNCOMMITTED change silently excluded: ${out}`);
  assert.ok(/diff-vs-HEAD~1 files: 2/.test(out), `expected 2 files, got: ${out}`);
});

test('the MCP get_diff_context tool reports the same file set for the same ref', () => {
  const dir = makeDiffRepo();
  const text = mcp(dir, 'get_diff_context', { base: 'HEAD~1' });
  assert.ok(text, 'MCP returned no content');
  assert.ok(/src\/a\.js/.test(text) && /src\/b\.js/.test(text),
    `MCP must match the CLI file set, got: ${text.slice(0, 300)}`);
});

test('bare --diff and --diff --staged are unchanged', () => {
  const dir = makeDiffRepo();
  // bare: working tree vs HEAD → only the uncommitted b.js
  const bare = run(dir, ['--diff']);
  assert.ok(/src\/b\.js/.test(bare), `bare --diff must see the working-tree change: ${bare}`);
  assert.ok(!/src\/a\.js/.test(bare), `a.js is committed at HEAD; bare --diff must not list it: ${bare}`);

  // staged: index vs HEAD → nothing staged yet
  const staged = run(dir, ['--diff', '--staged']);
  assert.ok(!/src\/b\.js/.test(staged), `nothing is staged; --staged must not list b.js: ${staged}`);
  g(dir, ['add', 'src/b.js']);
  const staged2 = run(dir, ['--diff', '--staged']);
  assert.ok(/src\/b\.js/.test(staged2), `after staging, --staged must list b.js: ${staged2}`);
});

test('an invalid ref is refused rather than passed to git', () => {
  const { changedFiles } = require(path.join(ROOT, 'src', 'util', 'git.js'));
  const dir = makeDiffRepo();
  assert.deepStrictEqual(changedFiles(dir, { base: '--output=/tmp/pwn' }), [],
    'a ref that is not a plain ref name must be refused');
});

test('the diff ranges have one owner, not one per surface', () => {
  const gen = fs.readFileSync(GEN, 'utf8');
  const handlers = fs.readFileSync(path.join(ROOT, 'src', 'mcp', 'handlers.js'), 'utf8');
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\$\{[A-Za-z.]*base[A-Za-z]*\}\.\.HEAD/.test(code(gen)),
    'gen-context.js must not build a <ref>..HEAD range');
  assert.ok(!/\.\.HEAD/.test(code(handlers)), 'the MCP handler must not build a <ref>..HEAD range');
  assert.ok(/changedFiles/.test(code(handlers)), 'the MCP handler must use the shared helper');
});

test('the MCP tool description no longer advertises base..HEAD', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'mcp', 'tools.js'), 'utf8');
  assert.ok(!/base\.\.HEAD/.test(tools), 'the tool description must not claim base..HEAD semantics');
});

test('--help states the semantics of all three diff forms', () => {
  const help = run(ROOT, ['--help']);
  assert.ok(/--diff\s+Changed files: working tree vs HEAD/.test(help), `bare form: ${help.match(/.*--diff.*/g)}`);
  assert.ok(/working tree vs <base-ref>/.test(help), 'ref form must say working tree vs ref');
  assert.ok(/index vs HEAD/.test(help), 'staged form must say index vs HEAD');
});

// ---------------------------------------------------------------------------
// #768 — no unqualified zero
// ---------------------------------------------------------------------------

test('--callers never asserts zero blast radius without qualification', () => {
  const out = run(ROOT, ['--callers', 'buildEvidencePack']);
  assert.ok(!/zero method blast radius/.test(out), `the unqualified claim must be gone: ${out}`);
  assert.ok(/lower bound/.test(out), `output must be labelled a lower bound: ${out}`);
});

test('the output names the scope that was searched', () => {
  const out = run(ROOT, ['--callers', 'buildEvidencePack']);
  assert.ok(/searched src, packages/.test(out), `must name the roots: ${out}`);
  assert.ok(/\d+ file\(s\)/.test(out), `must name how many files: ${out}`);
});

test('unfollowable dynamic module loads are counted and surfaced', () => {
  const out = run(ROOT, ['--callers', 'buildEvidencePack']);
  assert.ok(/dynamic module load\(s\) could not be followed/.test(out), `must surface the blind spot: ${out}`);
  const m = out.match(/(\d+) dynamic module load/);
  assert.ok(m && Number(m[1]) > 0, `this repo uses requireSourceOrBundled; expected > 0, got: ${out}`);
});

test('a non-zero result carries the same qualification', () => {
  const out = run(ROOT, ['--callers', 'coverageScore']);
  assert.ok(/\*\*Total callers of:\*\* \d+ _\(lower bound/.test(out),
    `a counted result is also a lower bound: ${out}`);
});

test('--callees is qualified too', () => {
  const out = run(ROOT, ['--callees', 'coverageScore']);
  assert.ok(/lower bound/.test(out), `callees must be labelled too: ${out}`);
});

test('--callers --json exposes the qualification', () => {
  const out = runOut(ROOT, ['--callers', 'buildEvidencePack', '--json']);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(j.total, 0);
  assert.strictEqual(j.lowerBound, true, 'JSON must not present an unqualified zero');
  assert.ok(j.scope && Array.isArray(j.scope.roots) && j.scope.roots.length > 0, 'JSON must name the searched roots');
  assert.ok(typeof j.scope.files === 'number' && j.scope.files > 0, 'JSON must carry the file count');
});

test('a symbol called only from outside srcDirs is not reported as zero-risk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-callers-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'), 'function onlyCalledOutside() { return 1; }\nmodule.exports = { onlyCalledOutside };\n');
  // The caller lives at the repo root — outside srcDirs, exactly the blind spot.
  fs.writeFileSync(path.join(dir, 'cli.js'), "const { onlyCalledOutside } = require('./src/lib');\nonlyCalledOutside();\n");
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'], outputs: ['copilot'] }));
  run(dir, []);
  const out = run(dir, ['--callers', 'onlyCalledOutside']);
  assert.ok(!/zero method blast radius/.test(out), `must not claim zero risk: ${out}`);
  assert.ok(/lower bound/.test(out) && /searched src/.test(out),
    `must disclose that only srcDirs was searched: ${out}`);
});

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
