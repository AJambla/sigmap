'use strict';

const { lineAt, withAnchor } = require('./line-anchor');
const { stripComments, maskCode, readBalanced } = require('./scan');
const { capWithNotice, capMembersWithNotice } = require('../util/truncate');

// Ceiling sits above the default `maxSigsPerFile` so the configured budget
// governs output rather than a literal buried here, and omissions are disclosed (#576).
// Class bodies are scanned to this many characters. Real classes routinely
// run past the old 4KB scan window — truncating there silently hid every
// member after ~4000 chars AND anchored class end-lines short (#576). The
// ceiling only guards against pathological input (Java parity, #551).
const MAX_CLASS_BODY_CHARS = 200000;
const PER_FILE_LIMIT = 200;

// Per-interface member ceiling, disclosed via capMembersWithNotice (#576).
const MEMBER_LIMIT = 120;

// Chars scanned past the params for the return type before giving up — a
// body-less declaration (assembly stub) must not swallow the next func's `{`.
const RET_SCAN_CHARS = 300;

/**
 * Extract signatures from Go source code.
 * Signatures carry `:start-end` line anchors (Surgical Context); comment
 * stripping is the shared string-aware scanner (G4, #643), so `//` inside a
 * string literal survives and anchor lines match the original file. Params
 * are captured with balanced-delimiter reads: nested func types, multiline
 * lists, type parameters (`[T any]`), and generic receivers all resolve.
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];
  const docHints = buildDocHints(src);
  // Append the godoc hint after the anchor as `  # <hint>` — same convention
  // as the Python/JS extractors' doc hints.
  const hinted = (sig, name) => (docHints.has(name) ? `${sig}  # ${docHints.get(name)}` : sig);

  // stripComments is string-aware; maskCode additionally blanks string
  // contents so every delimiter seen on it is structural. Both preserve
  // length and newlines, so offsets align across all three surfaces.
  const stripped = stripComments(src);
  const masked = maskCode(src);

  // Index of the closing brace for a block opened just before startIndex.
  const blockEndIdx = (startIndex) => startIndex + extractBlock(stripped, masked, startIndex).length;

  // Structs (type parameters on the name allowed: `type Stack[T any] struct`)
  for (const m of stripped.matchAll(/^type\s+(\w+)(?:\[[^\]\n]*\])?\s+struct\s*\{/gm)) {
    const end = blockEndIdx(m.index + m[0].length);
    sigs.push(hinted(withAnchor(`type ${m[1]} struct`, lineAt(stripped, m.index), lineAt(stripped, end)), m[1]));
  }

  // Interfaces (type parameters on the name allowed)
  for (const m of stripped.matchAll(/^type\s+(\w+)(?:\[[^\]\n]*\])?\s+interface\s*\{/gm)) {
    const bodyStart = m.index + m[0].length;
    const block = extractBlock(stripped, masked, bodyStart);
    sigs.push(hinted(withAnchor(`type ${m[1]} interface`, lineAt(stripped, m.index), lineAt(stripped, bodyStart + block.length)), m[1]));
    for (const meth of extractInterfaceMethods(block, masked.slice(bodyStart, bodyStart + block.length))) {
      sigs.push(withAnchor(`  ${meth.text}`, lineAt(stripped, bodyStart + (meth.declIdx || 0)), lineAt(stripped, bodyStart + (meth.endIdx || 0))));
    }
  }

  // Functions and methods — balanced walk: optional receiver, name, optional
  // type params, params, return segment up to the body brace.
  const ws = (i) => { while (stripped[i] === ' ' || stripped[i] === '\t') i++; return i; };
  for (const m of stripped.matchAll(/^func\b/gm)) {
    let i = ws(m.index + 4);
    let receiver = '';
    if (stripped[i] === '(') {
      const close = readBalanced(masked, i);
      if (close < 0) continue;
      const rcvName = (/^[A-Za-z_]\w*/.exec(stripped.slice(i + 1, close).trim()) || [''])[0];
      receiver = rcvName ? `(${rcvName}) ` : '';
      i = ws(close + 1);
    }
    const nameM = /^[A-Za-z_]\w*/.exec(stripped.slice(i, i + 200));
    if (!nameM) continue;
    const name = nameM[0];
    i = ws(i + name.length);
    if (stripped[i] === '[') {
      const close = readBalanced(masked, i, '[', ']');
      if (close < 0) continue;
      i = ws(close + 1);
    }
    if (stripped[i] !== '(') continue;
    const paramsClose = readBalanced(masked, i);
    if (paramsClose < 0) continue;
    const params = stripped.slice(i + 1, paramsClose);
    // Return segment: walk to the body `{`, jumping balanced result tuples.
    let j = paramsClose + 1;
    let bodyOpen = -1;
    const scanEnd = Math.min(masked.length, paramsClose + RET_SCAN_CHARS);
    while (j < scanEnd) {
      const ch = masked[j];
      if (ch === '(') { const c = readBalanced(masked, j); if (c < 0) break; j = c + 1; continue; }
      if (ch === '{') { bodyOpen = j; break; }
      j++;
    }
    if (bodyOpen < 0) continue;
    const retType = stripped.slice(paramsClose + 1, bodyOpen).trim().replace(/\s+/g, ' ');
    const retStr = retType ? ` → ${retType.slice(0, 30)}` : '';
    const end = blockEndIdx(bodyOpen + 1);
    sigs.push(hinted(withAnchor(`func ${receiver}${name}(${normalizeParams(params)})${retStr}`, lineAt(stripped, m.index), lineAt(stripped, end)), name));
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

// Depth-counted on the MASKED surface (a brace inside a string can no longer
// open or close a block); content sliced from the stripped surface.
function extractBlock(stripped, masked, startIndex) {
  let depth = 1, i = startIndex;
  const end = Math.min(masked.length, startIndex + MAX_CLASS_BODY_CHARS);
  while (i < end && depth > 0) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth--;
    i++;
  }
  return stripped.slice(startIndex, i - 1);
}

function extractInterfaceMethods(block, maskedBlock) {
  const methods = [];
  for (const m of block.matchAll(/^[ \t]+([A-Za-z_]\w*)\s*\(/gm)) {
    const openIdx = m.index + m[0].length - 1;
    const close = readBalanced(maskedBlock, openIdx);
    if (close < 0) continue;
    const nl = block.indexOf('\n', close);
    const lineEnd = nl < 0 ? block.length : nl;
    const retType = block.slice(close + 1, lineEnd).trim().replace(/\s+/g, ' ');
    const retStr = retType ? ` → ${retType.slice(0, 30)}` : '';
    methods.push({
      text: `${m[1]}(${normalizeParams(block.slice(openIdx + 1, close))})${retStr}`,
      declIdx: m.index + (m[0].length - m[0].trimStart().length),
      endIdx: lineEnd,
    });
  }
  return capMembersWithNotice(methods, MEMBER_LIMIT, 'methods');
}

function normalizeParams(params) {
  if (!params) return '';
  return params.trim().replace(/\s+/g, ' ').replace(/,\s*$/, '');
}

// Godoc: the `//` comment block directly above a top-level func/type/method
// declaration → first prose sentence, 60-char cap. Runs on the ORIGINAL src
// (extract strips comments before matching). Compiler directives (`//go:...`)
// carry no prose and are skipped.
function buildDocHints(src) {
  const hints = new Map();
  const re = /((?:^\/\/[^\n]*\n)+)(?:func\s+(?:\([^)\n]*\)\s+)?(\w+)\s*[[(]|type\s+(\w+)\s+(?:struct|interface)\b)/gm;
  for (const m of src.matchAll(re)) {
    const name = m[2] || m[3];
    const hint = firstDocSentence(m[1]);
    if (hint && !hints.has(name)) hints.set(name, hint);
  }
  return hints;
}

// First non-directive prose line of a `//` block → first sentence, 60-char cap.
function firstDocSentence(block) {
  const line = String(block).split('\n')
    .map((l) => l.replace(/^\/\/\s?/, '').trim())
    .find((l) => l && !l.startsWith('go:') && !l.startsWith('nolint'));
  if (!line) return '';
  return line.split(/[.!?]/)[0].trim().slice(0, 60);
}

module.exports = { extract };
