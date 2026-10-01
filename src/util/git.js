'use strict';

/**
 * Shell-free git invocation.
 *
 * Uses `execFileSync('git', [...])`, which executes the git binary directly —
 * it never spawns a system shell (`/bin/sh -c`). That means:
 *   - no shell-injection surface (arguments are passed as an array, never
 *     interpolated into a command string), and
 *   - supply-chain scanners (e.g. Socket) do not flag a "Shell access" capability.
 *
 * stderr is discarded by default (replaces the old `2>/dev/null` redirects).
 */

const { execFileSync } = require('child_process');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  });
}

// Convenience: run git and return trimmed stdout, or '' on any failure.
function tryGit(args, opts = {}) {
  try { return git(args, opts).toString().trim(); }
  catch (_) { return ''; }
}

/**
 * Git ref names this accepts as a diff base. Anything else is refused rather
 * than passed through, so a ref can never smuggle an option into the argv.
 */
const REF_RE = /^[A-Za-z0-9._/\-~^]+$/;

/**
 * Files changed in one of the three diff modes, as repo-relative paths.
 *
 * WHY THIS EXISTS
 * ---------------
 * `--diff <ref>` ran `git diff <ref>..HEAD`, which is ref-vs-HEAD and therefore
 * **excludes the working tree** — while the flag is documented as "changes
 * since <ref>". A developer with local edits got a diff that omitted exactly
 * the files they were editing (#667). The correct range for "since <ref>" is
 * the two-dot-free `git diff <ref>`: ref vs working tree, committed and
 * uncommitted alike.
 *
 * The same wrong range existed in two places — the CLI and the
 * `get_diff_context` MCP tool — so this is one helper rather than two fixes,
 * and the two surfaces cannot answer the same question differently.
 *
 *   mode            range                 meaning
 *   ──────────────────────────────────────────────────────────────────
 *   (default)       git diff HEAD         working tree vs HEAD
 *   { base }        git diff <base>       working tree vs <base>
 *   { staged }      git diff --cached     index vs HEAD
 *
 * @param {string} cwd
 * @param {{ base?: string, staged?: boolean }} [mode]
 * @returns {string[]} repo-relative paths, empty on any failure
 */
function changedFiles(cwd, mode = {}) {
  let args;
  if (mode.base) {
    if (!REF_RE.test(mode.base)) return [];
    args = ['diff', mode.base, '--name-only'];
  } else if (mode.staged) {
    args = ['diff', '--cached', '--name-only'];
  } else {
    args = ['diff', 'HEAD', '--name-only'];
  }
  return tryGit(args, { cwd }).split('\n').map((s) => s.trim()).filter(Boolean);
}

module.exports = { git, tryGit, changedFiles, REF_RE };
