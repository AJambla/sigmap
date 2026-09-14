'use strict';

/**
 * Environment-variable schema extractor (v8.5 C1).
 *
 * Surfaces the environment the project actually reads — from source across
 * JS/TS, Python, Ruby, and Go, plus keys declared in a committed `.env.example`
 * / `.env.sample` / `.env.template`. Pure, zero-dependency, deterministic.
 *
 * @param {string[]} files — absolute file paths to analyze (srcDirs-scoped)
 * @param {string}   cwd   — project root
 * @returns {string} formatted markdown table (empty string if none found)
 */

const fs = require('fs');
const path = require('path');

const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go']);
const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];

// process.env.X / process.env['X'] / import.meta.env.X / Deno.env.get('X')
const JS_RE = /(?:process\.env|import\.meta\.env)(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])|Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;
// os.environ['X'] / os.environ.get('X') / os.getenv('X') / getenv('X')
const PY_RE = /(?:os\.)?(?:environ(?:\.get)?\[?\s*['"]([A-Z_][A-Z0-9_]*)['"]|getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"])/g;
const RB_RE = /ENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g;
const GO_RE = /os\.(?:Getenv|LookupEnv)\(\s*["`']([A-Z_][A-Z0-9_]*)["`']/g;

const MAX_ROWS = 200;

function collectMatches(re, content, into) {
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name) into.add(name);
  }
}

function readExampleKeys(cwd) {
  const keys = new Set();
  for (const name of EXAMPLE_FILES) {
    let content;
    try { content = fs.readFileSync(path.join(cwd, name), 'utf8'); } catch (_) { continue; }
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
      if (eq) keys.add(eq[1]);
    }
  }
  return keys;
}

/**
 * Structured env reads with per-file attribution (#629): one row per variable,
 * reader files repo-relative and sorted, plus the committed-example flag.
 * @returns {Array<{name: string, files: string[], inExample: boolean}>}
 */
function collectEnvReads(files, cwd) {
  const readers = new Map(); // name → Set<rel file>

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SCAN_EXTS.has(ext)) continue;
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }

    const found = new Set();
    if (ext === '.py') collectMatches(PY_RE, content, found);
    else if (ext === '.rb') collectMatches(RB_RE, content, found);
    else if (ext === '.go') collectMatches(GO_RE, content, found);
    else collectMatches(JS_RE, content, found);
    if (found.size === 0) continue;

    const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
    for (const name of found) {
      if (!readers.has(name)) readers.set(name, new Set());
      readers.get(name).add(rel);
    }
  }

  const fromExample = readExampleKeys(cwd);
  const names = [...new Set([...readers.keys(), ...fromExample])].sort();
  return names.map((name) => ({
    name,
    files: [...(readers.get(name) || [])].sort(),
    inExample: fromExample.has(name),
  }));
}

function analyze(files, cwd) {
  const rows = collectEnvReads(files, cwd);
  if (rows.length === 0) return '';

  const lines = [
    '| Variable | Source |',
    '|----------|--------|',
  ];
  for (const r of rows.slice(0, MAX_ROWS)) {
    const src = [];
    if (r.files.length > 0) src.push('code');
    if (r.inExample) src.push('.env.example');
    lines.push(`| ${r.name} | ${src.join(', ')} |`);
  }
  if (rows.length > MAX_ROWS) {
    lines.push(`| … | +${rows.length - MAX_ROWS} more |`);
  }
  return lines.join('\n');
}

module.exports = { analyze, collectEnvReads };
