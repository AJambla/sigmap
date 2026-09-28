'use strict';

const { capWithNotice } = require('../util/truncate');
const { readBalanced } = require('./scan');

// Ceiling sits above the default `maxSigsPerFile` so the configured budget
// governs output rather than a literal buried here, and omissions are disclosed (#576).
const PER_FILE_LIMIT = 200;

/**
 * Extract signatures from Ruby source code.
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];

  // Length- AND newline-preserving: a deleting strip would desynchronise the
  // offsets the balanced reader walks (#695).
  const stripped = src.replace(/#[^\n]*/g, (m) => ' '.repeat(m.length));
  const masked = stripped.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g,
    (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0]);

  // Modules and classes
  for (const m of stripped.matchAll(/^(?:module|class)\s+([\w:]+)(?:\s*<\s*[\w:]+)?\s*$/gm)) {
    const kind = m[0].trimStart().startsWith('module') ? 'module' : 'class';
    sigs.push(`${kind} ${m[1]}`);
  }

  // Public methods (not private/protected)
  for (const m of stripped.matchAll(/^[ \t]+def\s+(?:self\.)?(\w+)(\s*\()?/gm)) {
    if (m[1].startsWith('_')) continue;
    const pr = m[2] ? readParams(stripped, masked, m.index + m[0].length - 1) : null;
    const params = pr ? `(${normalizeParams(pr.params)})` : '';
    const selfPrefix = m[0].includes('self.') ? 'self.' : '';
    const retStr = extractReturnHint(stripped, m.index);
    sigs.push(`  def ${selfPrefix}${m[1]}${params}${retStr}`);
  }

  // Top-level def
  for (const m of stripped.matchAll(/^def\s+(\w+)(\s*\()?/gm)) {
    if (m[1].startsWith('_')) continue;
    const pr = m[2] ? readParams(stripped, masked, m.index + m[0].length - 1) : null;
    const params = pr ? `(${normalizeParams(pr.params)})` : '';
    const retStr = extractReturnHint(stripped, m.index);
    sigs.push(`def ${m[1]}${params}${retStr}`);
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

/** Balanced parameter read — `\(([^)]*)\)` truncated at a nested `)` (#695). */
function readParams(stripped, masked, openIdx) {
  const close = readBalanced(masked, openIdx);
  if (close < 0) return null;
  return { params: stripped.slice(openIdx + 1, close), close };
}

function normalizeParams(params) {
  if (!params) return '';
  return params.trim().replace(/\s+/g, ' ');
}

function extractReturnHint(stripped, index) {
  const start = Math.max(0, index - 180);
  const before = stripped.slice(start, index);
  const m = before.match(/sig\s*\{[\s\S]*?returns\(([^)]+)\)[\s\S]*?\}\s*$/);
  if (!m) return '';
  const type = m[1].trim().replace(/\s+/g, ' ').slice(0, 25);
  return type ? ` → ${type}` : '';
}

module.exports = { extract };
