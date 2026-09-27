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

// Chars scanned past the params for a `: ReturnType` before giving up.
const RET_SCAN_CHARS = 400;

/** Keywords that mean the header ended without a body — see `bodyBraceFor`. */
const DECL_KEYWORDS = /\b(?:class|trait|object|def|val|var|case)\b/;

/**
 * Extract signatures from Scala source code.
 *
 * Migrated onto the shared balanced scanner (G4, #695), the same treatment
 * Kotlin received. Four defects came from doing this with regex alone:
 *
 *   1. `\(([^)]*)\)` stopped at the FIRST `)`, so a nested call in a default —
 *      `def f(a: Int = g(1, 2))` — captured `a: Int = g(1` and the
 *      comma-splitting `normalizeParams` rendered `def f(a, 2)`: a
 *      plausible-looking signature with an invented parameter.
 *   2. Scala generics use SQUARE brackets, which the splitter did not track, so
 *      `def f(m: Map[String, List[Int]])` rendered as the two params
 *      `m` and `List[Int]]` — an unbalanced type fragment.
 *   3. `(?:[^{]*)\{` on the type header matched NEWLINES, so a body-less
 *      `case class A(...)` walked past the blank line into the next
 *      declaration and adopted ITS body — reporting A with B's members while
 *      B vanished (#738). Misattribution, not truncation.
 *   4. Multiple parameter lists (currying) were dropped after the first, and
 *      with them the return type: `def f(a: Int)(b: Int): Int` rendered
 *      `def f(a)` with no `→`.
 *
 * Signatures carry `:start-end` line anchors (Surgical Context); both scan
 * surfaces are length- and newline-preserving so anchors match the original.
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];

  // stripComments is string-aware; maskCode additionally blanks string
  // contents so every delimiter seen on it is structural. Both preserve
  // length and newlines, so offsets align across both surfaces.
  const stripped = stripComments(src);
  const masked = maskCode(src);

  /**
   * Index of the body `{` belonging to the declaration starting at `from`, or
   * -1 when it has no body. Balanced constructor parens and `[T]` groups are
   * jumped whole; a blank line or a new declaration keyword ends the header,
   * which is what stops `case class A` swallowing the next type (#738).
   */
  const bodyBraceFor = (from) => {
    let i = from;
    const end = Math.min(masked.length, from + RET_SCAN_CHARS);
    while (i < end) {
      const ch = masked[i];
      if (ch === '{') return i;
      if (ch === '(') { const c = readBalanced(masked, i); if (c < 0) return -1; i = c + 1; continue; }
      if (ch === '[') { const c = readBalanced(masked, i, '[', ']'); if (c < 0) return -1; i = c + 1; continue; }
      if (ch === '\n') {
        const nl = masked.indexOf('\n', i + 1);
        const nextLine = masked.slice(i + 1, nl < 0 ? end : nl);
        if (!nextLine.trim()) return -1;
        // `extends`/`with` continuations are part of this header; a new
        // declaration keyword is not.
        const t = nextLine.trimStart();
        if (DECL_KEYWORDS.test(nextLine) && !/^(?:extends|with)\b/.test(t)) return -1;
        i++;
        continue;
      }
      if (ch === '=' || ch === ';') return -1;
      i++;
    }
    return -1;
  };

  const blockEndIdx = (bodyOpen) => bodyOpen + 1 + extractBlock(stripped, masked, bodyOpen + 1).length;

  // ── Classes, traits, objects ───────────────────────────────────────────────
  for (const m of stripped.matchAll(
    /^[ \t]*(?:(?:final|sealed|abstract|implicit|private|protected)\s+)*(case\s+class|case\s+object|class|trait|object)\s+(\w+)/gm)) {
    const declIdx = m.index + (m[0].length - m[0].trimStart().length);
    const kind = m[1].replace(/\s+/g, ' ');
    const bodyOpen = bodyBraceFor(m.index + m[0].length);
    if (bodyOpen < 0) {
      // No body: a one-line `case class User(id: String)` still names a real
      // type, so it is reported — anchored to its own single line.
      const line = lineAt(stripped, declIdx);
      sigs.push(withAnchor(`${kind} ${m[2]}`, line, line));
      continue;
    }
    const bodyStart = bodyOpen + 1;
    const block = extractBlock(stripped, masked, bodyStart);
    sigs.push(withAnchor(`${kind} ${m[2]}`, lineAt(stripped, declIdx), lineAt(stripped, bodyStart + block.length)));
    // Members of a NESTED type belong to that type, not to this one.
    const scoped = blankNestedTypeBodies(block, masked.slice(bodyStart, bodyStart + block.length),
      /^[ \t]+(?:(?:final|sealed|abstract|implicit|private|protected)\s+)*(?:case\s+class|case\s+object|class|trait|object)\s+\w+/gm);
    // capMembersWithNotice keeps the raised 120-member ceiling DISCLOSED — an
    // undisclosed cap looks like a class that simply has fewer methods (#576).
    const scopedMembers = capMembersWithNotice(
      scanDefs(scoped.block, scoped.masked, /^[ \t]+(?:(?:override|implicit|private|protected|final)\s+)*def\b/gm),
      MEMBER_LIMIT);
    for (const fn of scopedMembers) {
      sigs.push(withAnchor(`  ${fn.text}`, lineAt(stripped, bodyStart + (fn.declIdx || 0)), lineAt(stripped, bodyStart + (fn.endIdx || 0))));
    }
  }

  // ── Top-level defs ─────────────────────────────────────────────────────────
  for (const fn of scanDefs(stripped, masked, /^(?:(?:implicit|private|protected|final)\s+)*def\b/gm)) {
    const line = lineAt(stripped, fn.declIdx);
    sigs.push(withAnchor(fn.text, line, line));
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

/**
 * Walk every `def` matched by `headRe`, resolving each parameter list with a
 * balanced read. Multiple lists (currying) are all rendered, so the return
 * type after the last one is no longer lost.
 * @returns {Array<{text:string, declIdx:number, endIdx:number}>}
 */
function scanDefs(stripped, masked, headRe) {
  const out = [];
  const ws = (i) => { while (masked[i] === ' ' || masked[i] === '\t') i++; return i; };
  for (const m of stripped.matchAll(headRe)) {
    const head = m[0];
    const declIdx = m.index + (head.length - head.trimStart().length);
    let i = ws(m.index + head.length);

    const nameM = /^(?:[A-Za-z_]\w*|[+\-*/<>=!&|^%]+)/.exec(stripped.slice(i, i + 200));
    if (!nameM) continue;
    const name = nameM[0];
    if (name.startsWith('_')) continue;
    i = ws(i + name.length);

    // Method type parameters: `def f[T](a: T)`.
    if (masked[i] === '[') {
      const c = readBalanced(masked, i, '[', ']');
      if (c < 0) continue;
      i = ws(c + 1);
    }

    // One or more parameter lists.
    let lists = '';
    while (masked[i] === '(') {
      const close = readBalanced(masked, i);
      if (close < 0) break;
      lists += `(${normalizeParams(stripped.slice(i + 1, close))})`;
      i = ws(close + 1);
    }

    // `: ReturnType` up to `=`, the body `{`, or end of line.
    let ret = '';
    if (masked[i] === ':') {
      i++;
      const start = i;
      const scanEnd = Math.min(masked.length, i + RET_SCAN_CHARS);
      while (i < scanEnd) {
        const ch = masked[i];
        if (ch === '[') { const c = readBalanced(masked, i, '[', ']'); if (c < 0) break; i = c + 1; continue; }
        if (ch === '(') { const c = readBalanced(masked, i); if (c < 0) break; i = c + 1; continue; }
        if (ch === '=' || ch === '{' || ch === '\n') break;
        i++;
      }
      ret = normalizeType(stripped.slice(start, i));
    }
    const retStr = ret ? ` → ${ret}` : '';
    out.push({ text: `def ${name}${lists}${retStr}`, declIdx, endIdx: i });
  }
  return out;
}

// Depth-counted on the MASKED surface (a brace inside a string can no longer
// open or close a block); content sliced from the stripped surface.
/**
 * Blank the bodies of NESTED type declarations inside a block, so their members
 * are not also attributed to the enclosing type.
 *
 * Before the scanner migration a nested `trait`/`interface` was never found at
 * all, so this could not arise. Finding them correctly exposed it: a method in
 * `object O { trait T { def inner… } }` was emitted once under O and once under
 * T. Blanking is length- and newline-preserving, so member offsets and line
 * anchors computed on the result still align with the original block.
 * @param {string} block        stripped block text
 * @param {string} maskedBlock  masked block text (same length)
 * @param {RegExp} typeRe       nested-type header matcher (global, multiline)
 * @returns {{ block: string, masked: string }}
 */
function blankNestedTypeBodies(block, maskedBlock, typeRe) {
  const b = block.split('');
  const mb = maskedBlock.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < b.length; k++) {
      if (b[k] !== '\n') b[k] = ' ';
      if (mb[k] !== '\n') mb[k] = ' ';
    }
  };
  for (const m of block.matchAll(typeRe)) {
    // Walk the nested header to its body brace, jumping balanced groups.
    let i = m.index + m[0].length;
    const stop = Math.min(maskedBlock.length, i + RET_SCAN_CHARS);
    let open = -1;
    while (i < stop) {
      const ch = maskedBlock[i];
      if (ch === '{') { open = i; break; }
      if (ch === '(') { const c = readBalanced(maskedBlock, i); if (c < 0) break; i = c + 1; continue; }
      if (ch === '[') { const c = readBalanced(maskedBlock, i, '[', ']'); if (c < 0) break; i = c + 1; continue; }
      if (ch === '\n') {
        const nl = maskedBlock.indexOf('\n', i + 1);
        if (!maskedBlock.slice(i + 1, nl < 0 ? stop : nl).trim()) break;
        i++; continue;
      }
      if (ch === '=' || ch === ';') break;
      i++;
    }
    if (open < 0) continue;
    const close = readBalanced(maskedBlock, open, '{', '}');
    blank(open, close < 0 ? maskedBlock.length : close + 1);
  }
  return { block: b.join(''), masked: mb.join('') };
}

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

/**
 * Parameter NAMES only, with `: Type` and `= default` dropped.
 *
 * Depth- and string-aware over `()`, `[]` and `{}`. Scala generics use SQUARE
 * brackets, so the old `split(',')` rendered `Map[String, List[Int]]` as two
 * parameters and left an unbalanced `List[Int]]` behind (#695).
 * @param {string} params raw text between the balanced parens
 * @returns {string} `a, b` style list
 */
function normalizeParams(params) {
  if (!params || !params.trim()) return '';
  const names = [];
  let depth = 0;
  let quote = null;
  let seg = '';
  const flush = () => {
    // Keep `implicit` and other modifiers Scala allows in a param list, which
    // the previous rendering also kept.
    const name = seg.split(/[:=]/)[0].trim().replace(/\s+/g, ' ');
    if (name) names.push(name);
    seg = '';
  };
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (ch === ',' && depth === 0) { flush(); continue; }
    if (depth === 0) seg += ch;
  }
  flush();
  return names.join(', ');
}

function normalizeType(type) {
  if (!type) return '';
  return type.trim().replace(/\s+/g, ' ').slice(0, 25);
}

module.exports = { extract };
