'use strict';

/**
 * Release-automation guards (#751).
 *
 * Two process failures this cycle, both invisible until someone looked:
 *
 *   1. v8.51.5 merged to `main` and was never tagged. `main` claimed a version
 *      npm did not have, for a day, because pushing the tag was a manual step
 *      at the end of `/ship`. v8.51.6 repeated it.
 *   2. CI's `pull_request` trigger was filtered to `[develop, main]`, so a
 *      STACKED PR — base = another feature branch — matched no workflow and ran
 *      only the external Snyk check. Required checks could never be satisfied,
 *      so the PR sat blocked with no way to go green.
 *
 * `tag-on-merge.yml` closes (1). The decision logic is shell inside YAML, which
 * is exactly the kind of code that is never exercised until it misfires on
 * `main` — so these tests EXTRACT that script and run it against real git
 * repos, rather than asserting on the text of the workflow.
 *
 * Run: node test/integration/release-automation.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const WF = path.join(ROOT, '.github', 'workflows');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/**
 * Pull the `run:` block of a named step out of a workflow, without a YAML
 * dependency: find `id: <id>`, then take the block-scalar body that follows
 * `run: |` at a deeper indent.
 */
function runBlock(file, stepId) {
  const lines = fs.readFileSync(path.join(WF, file), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `id: ${stepId}`);
  assert.notStrictEqual(at, -1, `no step with id: ${stepId} in ${file}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run:\s*\|/.test(l));
  assert.notStrictEqual(runAt, -1, `step ${stepId} has no run: | block`);
  const indent = lines[runAt].match(/^\s*/)[0].length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { body.push(''); continue; }
    if (lines[i].match(/^\s*/)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n');
}

const DECIDE = runBlock('tag-on-merge.yml', 'decide');

/** Run the decide script in a throwaway repo; return {out, outputs, code}. */
function decide({ version, changelog, tag }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-tag-'));
  try {
    const sh = path.join(dir, 'decide.sh');
    const gho = path.join(dir, 'gh-output');
    fs.writeFileSync(sh, DECIDE);
    fs.writeFileSync(gho, '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
      changelog === null
        ? '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- pending\n'
        : `# Changelog\n\n## [Unreleased]\n\n---\n\n## [${changelog}] — 2026-01-01\n\n### Fixed\n- x\n`);
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '.');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'init');
    if (tag) git('tag', tag);

    let out = '', code = 0;
    try {
      out = execFileSync('bash', [sh], {
        cwd: dir, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, GITHUB_OUTPUT: gho },
      });
    } catch (e) { code = e.status; out = (e.stdout || '') + (e.stderr || ''); }
    const outputs = {};
    for (const l of fs.readFileSync(gho, 'utf8').split('\n').filter(Boolean)) {
      const i = l.indexOf('=');
      outputs[l.slice(0, i)] = l.slice(i + 1);
    }
    return { out, outputs, code };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── the one case that tags ──────────────────────────────────────────────────

test('a prepared, untagged release is tagged', () => {
  const r = decide({ version: '9.9.9', changelog: '9.9.9' });
  assert.strictEqual(r.outputs.skip, 'false', `expected skip=false, got ${JSON.stringify(r.outputs)}`);
  assert.strictEqual(r.outputs.version, '9.9.9');
});

// ── every case that must NOT tag ────────────────────────────────────────────

test('a version/CHANGELOG disagreement is not a prepared release', () => {
  const r = decide({ version: '9.9.9', changelog: '9.9.8' });
  assert.strictEqual(r.outputs.skip, 'true');
  assert.ok(/disagree/.test(r.out), r.out);
});

test('an already-tagged version is not re-tagged', () => {
  const r = decide({ version: '9.9.9', changelog: '9.9.9', tag: 'v9.9.9' });
  assert.strictEqual(r.outputs.skip, 'true');
  assert.ok(/already exists/.test(r.out), r.out);
});

test('a CHANGELOG with only [Unreleased] skips instead of failing the job', () => {
  // `set -euo pipefail` + a grep that matches nothing aborts the step, which
  // would put a red X on every push to main. It must exit 0 with skip=true.
  const r = decide({ version: '9.9.9', changelog: null });
  assert.strictEqual(r.code, 0, `the step failed instead of skipping: ${r.out}`);
  assert.strictEqual(r.outputs.skip, 'true', `no skip output: ${JSON.stringify(r.outputs)}`);
});

test('every no-tag path still emits a skip output', () => {
  // A missing output makes the downstream `if:` read as false and silently do
  // nothing — indistinguishable from a deliberate skip, so pin it.
  for (const c of [
    { version: '1.0.0', changelog: '1.0.1' },
    { version: '1.0.0', changelog: '1.0.0', tag: 'v1.0.0' },
    { version: '1.0.0', changelog: null },
  ]) {
    const r = decide(c);
    assert.ok('skip' in r.outputs, `no skip output for ${JSON.stringify(c)}`);
    assert.strictEqual(r.code, 0, `non-zero exit for ${JSON.stringify(c)}: ${r.out}`);
  }
});

test('the real repo state is a no-op — this must never tag on its own history', () => {
  const v = require(path.join(ROOT, 'package.json')).version;
  const tagged = execFileSync('git', ['tag', '-l', `v${v}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!tagged) return; // mid-release: /update-docs bumped but /ship has not tagged yet
  const r = decide({ version: v, changelog: v, tag: `v${v}` });
  assert.strictEqual(r.outputs.skip, 'true');
});

// ── the SYNC_PAT refusal ────────────────────────────────────────────────────

test('a tag is refused when SYNC_PAT is absent, rather than pushed uselessly', () => {
  // A tag pushed with GITHUB_TOKEN does not start npm-publish or
  // release-binaries, so it would leave a tag with no release behind it.
  const y = fs.readFileSync(path.join(WF, 'tag-on-merge.yml'), 'utf8');
  assert.ok(/SYNC_PAT: \$\{\{ secrets\.SYNC_PAT \}\}/.test(y),
    'the refusal step must read the secret through env');
  assert.ok(/if \[ -z "\$\{SYNC_PAT:-\}" \]/.test(y),
    'the refusal must be a shell test, not a step `if:`');
  assert.ok(/exit 1/.test(y), 'the refusal must fail the job');
});

test('secrets are never read from a step `if:` — GitHub does not provide them there', () => {
  for (const f of fs.readdirSync(WF).filter((f) => /\.ya?ml$/.test(f))) {
    for (const l of fs.readFileSync(path.join(WF, f), 'utf8').split('\n')) {
      if (/^\s*if:/.test(l) && /secrets\./.test(l)) {
        assert.fail(`${f}: \`secrets\` in a step if: is always empty — ${l.trim()}`);
      }
    }
  }
});

// ── the stacked-PR trap ─────────────────────────────────────────────────────

test('CI runs for a PR whose base is another feature branch', () => {
  const y = fs.readFileSync(path.join(WF, 'ci.yml'), 'utf8');
  const pr = y.slice(y.indexOf('pull_request:'));
  const next = pr.split('\n').slice(1).find((l) => l.trim() && !l.startsWith('    '));
  const body = pr.slice(0, next ? pr.indexOf(next) : undefined);
  assert.ok(!/branches:/.test(body),
    'a branches filter on pull_request skips stacked PRs entirely — they can never go green');
});

console.log(`\n  release-automation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
