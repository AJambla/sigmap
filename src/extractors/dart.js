'use strict';

const { lineAt, withAnchor } = require('./line-anchor');
const { capWithNotice, capMembersWithNotice } = require('../util/truncate');
const { stripComments, maskCode, readBalanced } = require('./scan');

// Ceilings sit above the default `maxSigsPerFile` so the configured budget
// governs output rather than a literal buried here, and omissions are disclosed
// — an undisclosed cap looks like a class that simply has eight methods (#576).
// Class bodies are scanned to this many characters. Real classes routinely
// run past the old 4KB scan window — truncating there silently hid every
// member after ~4000 chars AND anchored class end-lines short (#576). The
// ceiling only guards against pathological input (Java parity, #551).
const MAX_CLASS_BODY_CHARS = 200000;
const MEMBER_LIMIT = 120;
const PER_FILE_LIMIT = 200;

/**
 * Extract signatures from Dart source code.
 * Signatures carry `:start-end` line anchors (Surgical Context); the comment
 * strip below is newline-preserving so anchor lines match the original file.
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];

  // stripComments is length- AND newline-preserving; the previous strip DELETED
  // comment text, so offsets no longer aligned with the masked surface the
  // balanced reader walks (#695).
  const stripped = stripComments(src);
  const masked = maskCode(src);

  // Anchor range: scan past same-line trivia (`async`, `=>` stops) to a body `{`.
  const rangeFor = (declIdx, afterIdx) => {
    let k = afterIdx;
    while (k < stripped.length && /[ \tA-Za-z0-9_]/.test(stripped[k])) k++;
    if (stripped[k] === '{') {
      const end = k + 1 + extractBlock(stripped, k + 1).length;
      return [lineAt(stripped, declIdx), lineAt(stripped, end)];
    }
    const line = lineAt(stripped, declIdx);
    return [line, line];
  };

  // Classes and abstract classes
  for (const m of stripped.matchAll(/^(?:abstract\s+)?class\s+(\w+)(?:<[^{]*>)?(?:\s+extends\s+[\w<>, ]+)?(?:\s+(?:implements|with|on)\s+[\w<>, ]+)?\s*\{/gm)) {
    const abs = m[0].trimStart().startsWith('abstract') ? 'abstract ' : '';
    const bodyStart = m.index + m[0].length;
    const block = extractBlock(stripped, bodyStart);
    sigs.push(withAnchor(`${abs}class ${m[1]}`, lineAt(stripped, m.index), lineAt(stripped, bodyStart + block.length)));
    for (const meth of extractMembers(block, masked.slice(bodyStart, bodyStart + block.length))) {
      // The disclosure marker carries no offsets; anchor it at the class body.
      sigs.push(withAnchor(`  ${meth.text}`, lineAt(stripped, bodyStart + (meth.declIdx || 0)), lineAt(stripped, bodyStart + (meth.endIdx || 0))));
    }
  }

  // Top-level functions — capture return type (prefix before name) and show as suffix
  for (const m of stripped.matchAll(/^((?:Future<[\w<>?,\s]*>|[\w<>?]+))\s+(\w+)\s*\(/gm)) {
    if (m[2].startsWith('_')) continue;
    const pr = readParams(stripped, masked, m.index + m[0].length - 1);
    if (!pr) continue;
    const retStr = (m[1] && m[1] !== 'void') ? ` → ${m[1].replace(/\s+/g, '').slice(0, 25)}` : '';
    const [s, e] = rangeFor(m.index, pr.close + 1);
    sigs.push(withAnchor(`${m[2]}(${normalizeParams(pr.params)})${retStr}`, s, e));
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

/** Balanced parameter read — `\(([^)]*)\)` truncated at a nested `)` (#695). */
function readParams(stripped, masked, openIdx) {
  const close = readBalanced(masked, openIdx);
  if (close < 0) return null;
  return { params: stripped.slice(openIdx + 1, close), close };
}

function extractBlock(src, startIndex) {
  let depth = 1, i = startIndex;
  const end = Math.min(src.length, startIndex + MAX_CLASS_BODY_CHARS);
  while (i < end && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(startIndex, i - 1);
}

function extractMembers(block, maskedBlock) {
  const members = [];
  for (const m of block.matchAll(/^[ \t]+(?:@override\s+)?(?:@\w+\s+)*((?:Future<[\w<>?,\s]*>|[\w<>?]+))\s+(\w+)\s*\(/gm)) {
    if (m[2].startsWith('_')) continue;
    const pr = readParams(block, maskedBlock, m.index + m[0].length - 1);
    if (!pr) continue;
    const retStr = (m[1] && m[1] !== 'void') ? ` → ${m[1].replace(/\s+/g, '').slice(0, 25)}` : '';
    members.push({
      text: `${m[2]}(${normalizeParams(pr.params)})${retStr}`,
      declIdx: m.index + (m[0].length - m[0].trimStart().length),
      endIdx: pr.close + 1,
    });
  }
  return capMembersWithNotice(members, MEMBER_LIMIT);
}

/**
 * Compact the parameter text, keeping Dart's `{named}` / `[optional]` groups.
 *
 * The previous implementation deleted `{...}` groups wholesale — real API
 * surface, and only tolerable because the first-`)` capture had usually
 * mangled them anyway. Defaults are dropped at depth 0, so
 * `{int b = 2, int Function(int)? cb}` renders `{int b, int Function(int)? cb}`.
 */
function normalizeParams(params) {
  if (!params || !params.trim()) return '';
  let out = '';
  let depth = 0;
  let quote = null;
  let skipDefault = false;
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if (quote) { out += ch; if (ch === '\\') { out += params[++i] || ''; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { if (!skipDefault) { quote = ch; out += ch; } continue; }
    if (ch === '(' || ch === '<') { depth++; if (!skipDefault) out += ch; continue; }
    if (ch === ')' || ch === '>') { depth--; if (!skipDefault) out += ch; continue; }
    if (ch === '{' || ch === '[') { if (!skipDefault) out += ch; continue; }
    if (ch === '}' || ch === ']') { skipDefault = false; out += ch; continue; }
    if (ch === '=' && depth === 0) { skipDefault = true; continue; }
    if (ch === ',' && depth === 0) { skipDefault = false; out += ch; continue; }
    if (!skipDefault) out += ch;
  }
  return out.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/,\s*([}\]])/g, '$1').replace(/\s+([}\])])/g, '$1').replace(/\(\s+/g, '(').trim().replace(/,$/, '');
}

module.exports = { extract };
