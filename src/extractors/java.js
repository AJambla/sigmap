'use strict';

const { lineAt, withAnchor } = require('./line-anchor');
const { stripComments, maskCode, readBalanced } = require('./scan');
const { capWithNotice, capMembersWithNotice } = require('../util/truncate');

// Class bodies are scanned to this many characters. Generated JVM sources
// (MyBatis/JPA entities) routinely run past 10KB, so the ceiling only guards
// against pathological input rather than trimming ordinary classes.
const MAX_CLASS_BODY_CHARS = 200000;

// Per-class member ceiling. Sits above the default `maxSigsPerFile` so the
// caller's configured budget governs the output rather than this file.
const MAX_MEMBERS_PER_CLASS = 120;

// Per-file signature ceiling, likewise above the configured default.
const MAX_SIGS_PER_FILE = 200;

// Chars scanned past a type's name/header for the body `{` (extends /
// implements / permits clauses) before giving up.
const HEAD_SCAN_CHARS = 500;

/**
 * Extract signatures from Java source code.
 * Signatures carry `:start-end` line anchors (Surgical Context); comment
 * stripping is the shared string-aware scanner (G4, #646), so `//` or `/*`
 * inside a string literal survives, and brace depth is counted on masked
 * text. Balanced reads capture annotation-argument params, nested generic
 * bounds, generic type names, records, sealed types, and implicit-public
 * interface methods.
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];
  const docHints = buildDocHints(src);
  // Append the Javadoc hint after the anchor as `  # <hint>` — same convention
  // as the Python/JS extractors' doc hints.
  const hinted = (sig, name) => (docHints.has(name) ? `${sig}  # ${docHints.get(name)}` : sig);

  const stripped = stripComments(src);
  const masked = maskCode(src);
  const ws = (i) => { while (stripped[i] === ' ' || stripped[i] === '\t' || stripped[i] === '\n') i++; return i; };

  // Type declarations: classes, interfaces, enums, records — modifiers in any
  // order, sealed/non-sealed included, generic names allowed.
  const typeRegex = /^(?:(?:public|protected|abstract|final|sealed|non-sealed|static|strictfp)\s+)*(class|interface|enum|record)\s+(\w+)/gm;
  for (const m of stripped.matchAll(typeRegex)) {
    const kw = m[1];
    const name = m[2];
    let i = m.index + m[0].length;
    // Optional type parameters on the name: `<T, ID>`, `<T extends Comparable<T>>`.
    i = ws(i);
    if (stripped[i] === '<') {
      const c = readBalanced(masked, i, '<', '>');
      if (c < 0) continue;
      i = ws(c + 1);
    }
    // Record header components: `record Point(int x, int y)`.
    let header = '';
    if (kw === 'record') {
      if (stripped[i] !== '(') continue;
      const c = readBalanced(masked, i);
      if (c < 0) continue;
      header = `(${normalizeParams(stripped.slice(i + 1, c))})`;
      i = ws(c + 1);
    }
    // Walk extends/implements/permits to the body brace, jumping generics.
    let bodyOpen = -1;
    const scanEnd = Math.min(masked.length, i + HEAD_SCAN_CHARS);
    let j = i;
    while (j < scanEnd) {
      const ch = masked[j];
      if (ch === '<') { const c = readBalanced(masked, j, '<', '>'); if (c < 0) break; j = c + 1; continue; }
      if (ch === '{') { bodyOpen = j; break; }
      if (ch === ';') break; // degenerate body-less declaration
      j++;
    }
    if (bodyOpen < 0) continue;
    const bodyStart = bodyOpen + 1;
    const block = extractBlock(stripped, masked, bodyStart);
    sigs.push(hinted(withAnchor(`${kw} ${name}${header}`, lineAt(stripped, m.index), lineAt(stripped, bodyStart + block.length)), name));
    const maskedBlock = masked.slice(bodyStart, bodyStart + block.length);
    for (const meth of extractMembers(block, maskedBlock, { implicitPublic: kw === 'interface' })) {
      // The disclosure marker carries no offsets; anchor it at the class body.
      const declIdx = meth.declIdx || 0;
      const endIdx = meth.endIdx || 0;
      sigs.push(hinted(withAnchor(`  ${meth.text}`, lineAt(stripped, bodyStart + declIdx), lineAt(stripped, bodyStart + endIdx)), meth.name));
    }
  }

  return capWithNotice(sigs, MAX_SIGS_PER_FILE, 'signatures');
}

// Depth-counted on the MASKED surface (a brace inside a string can no longer
// open or close a block); content sliced from the stripped surface.
function extractBlock(stripped, masked, startIndex) {
  let depth = 1;
  let i = startIndex;
  const end = Math.min(masked.length, startIndex + MAX_CLASS_BODY_CHARS);
  while (i < end && depth > 0) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth--;
    i++;
  }
  return stripped.slice(startIndex, i - 1);
}

const MODIFIER_RE = /^(?:public|protected|private|static|final|synchronized|abstract|default|native|strictfp)\b/;

/**
 * Member scan over a type body. Class/enum/record mode requires a
 * public/protected modifier (statements inside method bodies never carry
 * one at declaration position). Interface mode additionally accepts
 * modifier-less declarations — interface bodies hold no statements, so a
 * `name(params)` parse there is safe.
 */
function extractMembers(block, maskedBlock, opts = {}) {
  const members = [];
  const seen = new Set();
  const wsB = (i) => { while (block[i] === ' ' || block[i] === '\t') i++; return i; };
  const headRe = opts.implicitPublic
    ? /^([ \t]+)(?=[A-Za-z_<])/gm
    : /^([ \t]+)(?=(?:public|protected)\b)/gm;
  for (const m of block.matchAll(headRe)) {
    let i = m.index + m[1].length;
    const declIdx = i;
    // Modifiers (any, in any order).
    let sawVisible = false;
    for (;;) {
      const mm = MODIFIER_RE.exec(block.slice(i, i + 16));
      if (!mm) break;
      if (mm[0] === 'public' || mm[0] === 'protected') sawVisible = true;
      if (mm[0] === 'private') { sawVisible = false; break; }
      i = wsB(i + mm[0].length);
    }
    if (!opts.implicitPublic && !sawVisible) continue;
    // Optional generic type parameters: `<T extends Comparable<T>>`.
    if (block[i] === '<') {
      const c = readBalanced(maskedBlock, i, '<', '>');
      if (c < 0) continue;
      i = wsB(c + 1);
    }
    // Return type: identifier chain + optional generics + array brackets.
    const t0 = i;
    const idM = /^[\w.]+/.exec(block.slice(i, i + 200));
    if (!idM) continue;
    i += idM[0].length;
    if (block[i] === '<') {
      const c = readBalanced(maskedBlock, i, '<', '>');
      if (c < 0) continue;
      i = c + 1;
    }
    while (block.slice(i, i + 2) === '[]') i += 2;
    const retText = block.slice(t0, i);
    i = wsB(i);
    // Name, then params — anything else (field, constructor) is skipped.
    const nameM = /^\w+/.exec(block.slice(i, i + 200));
    if (!nameM) continue;
    const name = nameM[0];
    i = wsB(i + name.length);
    if (block[i] !== '(') continue;
    const close = readBalanced(maskedBlock, i);
    if (close < 0) continue;
    const params = block.slice(i + 1, close);
    const nl = block.indexOf('\n', close);
    const lineEnd = nl < 0 ? block.length : nl;
    const key = `${name}::${declIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ret = normalizeType(retText);
    const retStr = ret ? ` → ${ret}` : '';
    members.push({
      text: `${name}(${normalizeParams(params)})${retStr}`,
      name,
      declIdx,
      endIdx: lineEnd,
    });
  }
  return capMembersWithNotice(members, MAX_MEMBERS_PER_CLASS);
}

function normalizeParams(params) {
  if (!params) return '';
  return params.trim().replace(/\s+/g, ' ').replace(/,\s*$/, '');
}

function normalizeType(type) {
  if (!type) return '';
  return type.trim().replace(/\s+/g, ' ').slice(0, 30);
}

// Javadoc: the `/** ... */` block directly above a type or public/protected
// member declaration → first prose sentence, 60-char cap. Runs on the
// ORIGINAL src (extract strips comments before matching). Annotation lines
// (`@Override` etc.) between the doc block and the declaration are tolerated.
// Body may not contain `*/` so a failed adjacency check can't expand across
// code to the next comment block and misattribute the hint.
function buildDocHints(src) {
  const hints = new Map();
  const patterns = [
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|protected\s+)?(?:abstract\s+|final\s+|sealed\s+|non-sealed\s+)?(?:class|interface|enum|record)\s+(\w+)/g,
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s+)?[\w<>\[\], ?.]+\s+(\w+)\s*\(/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const hint = firstDocSentence(m[1]);
      if (hint && !hints.has(m[2])) hints.set(m[2], hint);
    }
  }
  return hints;
}

// First non-tag prose line of a Javadoc body → first sentence, 60-char cap.
function firstDocSentence(body) {
  const line = String(body).split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .find((l) => l && !l.startsWith('@'));
  if (!line) return '';
  return line.split(/[.!?]/)[0].trim().slice(0, 60);
}

module.exports = { extract };
