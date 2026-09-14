'use strict';

/**
 * Elixir Tier-3 extractor (#538): defmodule/def/defp signatures with @spec
 * return hints and @doc first-sentence hints, plus alias/import/use edges
 * that resolve within the repo by the lib/ snake_case convention.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');
const { extract } = require(path.join(ROOT, 'src/extractors/elixir'));
const { extractElixirDeps } = require(path.join(ROOT, 'src/extractors/deps'));
const { buildFromCwd } = require(path.join(ROOT, 'src/graph/builder'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const FIXTURE = fs.readFileSync(path.join(ROOT, 'test/fixtures/elixir.ex'), 'utf8');

test('Phoenix-style fixture: module + defs with params, @doc and @spec hints', () => {
  const sigs = extract(FIXTURE);
  assert.ok(sigs.some((s) => s.startsWith('defmodule MyApp.Accounts  # The Accounts context')), `moduledoc hint missing: ${sigs[0]}`);
  assert.ok(sigs.some((s) => s.includes('def get_user!(id) → User.t()  # Gets a single user by id')), 'spec + doc hint missing');
  assert.ok(sigs.some((s) => s.includes('def update_user(user, attrs)')), 'pattern-matched params must reduce to names');
  assert.ok(sigs.some((s) => s.includes('defp normalize_email(email)')), 'private defs are part of module comprehension');
  assert.ok(sigs.some((s) => s.includes('defmacro __using__(_opts)')), 'dunder macros are meaningful and kept');
  assert.ok(!sigs.some((s) => s.includes('_internal_probe')), 'single-underscore names are filtered');
});

test('deps extraction: alias/import/use module names, deduped and capped', () => {
  const deps = extractElixirDeps(FIXTURE);
  assert.deepStrictEqual(deps.sort(), ['Ecto.Query', 'MyApp.Accounts', 'MyApp.Accounts.User', 'MyApp.Repo'].sort()); // MyApp.Accounts: the import inside __using__'s quote block — a real reference
});

test('graph: alias edges resolve within the repo via snake_case paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-ex-'));
  fs.mkdirSync(path.join(dir, 'lib', 'my_app', 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'my_app', 'repo.ex'),
    'defmodule MyApp.Repo do\n  def get!(mod, id), do: {mod, id}\nend\n');
  fs.writeFileSync(path.join(dir, 'lib', 'my_app', 'accounts', 'user.ex'),
    'defmodule MyApp.Accounts.User do\n  def changeset(user, attrs), do: {user, attrs}\nend\n');
  fs.writeFileSync(path.join(dir, 'lib', 'my_app', 'accounts.ex'), FIXTURE);
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['lib'], changes: false }));

  const graph = buildFromCwd(dir);
  const key = [...graph.forward.keys()].find((k) => k.endsWith('accounts.ex'));
  assert.ok(key, 'accounts.ex missing from graph');
  const deps = graph.forward.get(key) || [];
  assert.ok(deps.some((d) => d.endsWith('repo.ex')), `alias MyApp.Repo did not resolve: ${JSON.stringify(deps)}`);
  assert.ok(deps.some((d) => d.endsWith('user.ex')), `alias MyApp.Accounts.User did not resolve: ${JSON.stringify(deps)}`);

  // End-to-end: the generated artifact carries the Elixir signatures.
  execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  const out = fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
  assert.ok(out.includes('defmodule MyApp.Accounts'), 'artifact missing Elixir module');
  assert.ok(out.includes('def get_user!(id) → User.t()'), 'artifact missing typed def');
});

test('CLI resolution matches dispatch — the drifted-copy regression (#538)', () => {
  // The CLI core kept its own EXT_MAP copy which lacked .lua/.gd/.ex, so
  // those languages silently fell to the generic fallback in the generate
  // pipeline while their extractors passed every direct test. The copy is
  // deleted; this pins that all three languages reach their real extractor
  // end-to-end.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-dispatch-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.lua'), 'local function greet(name)\n  return name\nend\nfunction M.run(x)\n  return x\nend\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.ex'), 'defmodule A.B do\n  def go(x), do: x\nend\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'], changes: false }));
  execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  const out = fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
  assert.ok(out.includes('function M.run(x)'), 'lua fell to the generic fallback in the CLI pipeline');
  assert.ok(out.includes('defmodule A.B'), 'elixir fell to the generic fallback in the CLI pipeline');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
