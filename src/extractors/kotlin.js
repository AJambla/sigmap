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

/** Type/class keywords that terminate a header walk — see `bodyBraceFor`. */
const DECL_KEYWORDS = /\b(?:class|object|interface|fun|val|var)\b/;

/**
 * Extract signatures from Kotlin source code.
 *
 * Migrated onto the shared balanced scanner (G4, #695). Two defects came from
 * doing this with regex alone:
 *
 *   1. `\(([^)]*)\)` stopped at the FIRST `)`, so a nested call in a default —
 *      `fun f(a: Int = g(1, 2))` — captured `a: Int = g(1` and the old
 *      comma-splitting `normalizeParams` then rendered `fun f(a, 2)`: a
 *      plausible-looking signature with an invented parameter. A consumer
 *      could not tell it was damaged.
 *   2. `(?:[^{]*)\{` on the class header matched NEWLINES, so a body-less
 *      `data class A(...)` walked past the blank line into the next
 *      declaration and adopted ITS body — reporting A with B's members while
 *      B vanished (#738). Misattribution, not truncation: every symbol was
 *      real, just bolted to the wrong owner.
 *
 * Both are now structural walks over a masked surface, so delimiters inside
 * strings and comments cannot open or close anything.
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
   * -1 when it has no body.
   *
   * Walks the header: balanced constructor parens and generic/annotation
   * groups are jumped whole; a newline is allowed (Kotlin wraps supertype
   * lists) but another declaration keyword or a blank line means the
   * declaration ended without a body — which is what stopped `data class A`
   * from swallowing the next class (#738).
   */
  const bodyBraceFor = (from) => {
    let i = from;
    const end = Math.min(masked.length, from + RET_SCAN_CHARS);
    while (i < end) {
      const ch = masked[i];
      if (ch === '{') return i;
      if (ch === '(') { const c = readBalanced(masked, i); if (c < 0) return -1; i = c + 1; continue; }
      if (ch === '<') { const c = readBalanced(masked, i, '<', '>'); if (c < 0) { i++; continue; } i = c + 1; continue; }
      if (ch === '[') { const c = readBalanced(masked, i, '[', ']'); if (c < 0) return -1; i = c + 1; continue; }
      if (ch === '\n') {
        // A blank line, or a new declaration on the next line, ends the header.
        const nl = masked.indexOf('\n', i + 1);
        const nextLine = masked.slice(i + 1, nl < 0 ? end : nl);
        if (!nextLine.trim()) return -1;
        if (DECL_KEYWORDS.test(nextLine) && !nextLine.trimStart().startsWith(':')) return -1;
        i++;
        continue;
      }
      if (ch === '=' || ch === ';') return -1; // expression body / bare decl
      i++;
    }
    return -1;
  };

  /** Closing `}` index for a block opened at `bodyOpen`, depth on the mask. */
  const blockEndIdx = (bodyOpen) => bodyOpen + 1 + extractBlock(stripped, masked, bodyOpen + 1).length;

  // ── Classes, objects, interfaces ──────────────────────────────────────────
  // The header is walked rather than regex-spanned, so a body-less declaration
  // is reported on its own line instead of borrowing the next one's body.
  for (const m of stripped.matchAll(
    /^[ \t]*(?:public\s+|internal\s+|private\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+|enum\s+|annotation\s+|value\s+)*(class|object|interface)\s+(\w+)/gm)) {
    const declIdx = m.index + (m[0].length - m[0].trimStart().length);
    const bodyOpen = bodyBraceFor(m.index + m[0].length);
    if (bodyOpen < 0) {
      // No body: a one-line `data class User(val id: String)` still names a
      // real type, so it is reported — anchored to its own single line.
      const line = lineAt(stripped, declIdx);
      sigs.push(withAnchor(`${m[1]} ${m[2]}`, line, line));
      continue;
    }
    const bodyStart = bodyOpen + 1;
    const block = extractBlock(stripped, masked, bodyStart);
    sigs.push(withAnchor(`${m[1]} ${m[2]}`, lineAt(stripped, declIdx), lineAt(stripped, bodyStart + block.length)));
    // Members of a NESTED type belong to that type, not to this one.
    const scoped = blankNestedTypeBodies(block, masked.slice(bodyStart, bodyStart + block.length),
      /^[ \t]+(?:(?:public|internal|private|protected)\s+)?(?:(?:data|sealed|abstract|open|enum|annotation|value|inner|companion)\s+)*(?:class|object|interface)\s+\w+/gm);
    for (const meth of extractMembers(scoped.block, scoped.masked)) {
      sigs.push(withAnchor(`  ${meth.text}`, lineAt(stripped, bodyStart + (meth.declIdx || 0)), lineAt(stripped, bodyStart + (meth.endIdx || 0))));
    }
  }

  // ── Top-level functions ───────────────────────────────────────────────────
  for (const fn of scanFunctions(stripped, masked, /^(?:public\s+|internal\s+)?(?:suspend\s+)?fun\b/gm)) {
    const bodyOpen = bodyBraceFor(fn.afterRet);
    const end = bodyOpen >= 0 ? blockEndIdx(bodyOpen) : fn.afterRet;
    sigs.push(withAnchor(fn.text, lineAt(stripped, fn.declIdx), lineAt(stripped, end)));
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

/**
 * Walk every `fun` matched by `headRe`, resolving its parameter list with a
 * balanced read instead of a first-`)` capture.
 * @returns {Array<{text:string, declIdx:number, endIdx:number, afterRet:number}>}
 */
function scanFunctions(stripped, masked, headRe) {
  const out = [];
  const ws = (i) => { while (masked[i] === ' ' || masked[i] === '\t') i++; return i; };
  for (const m of stripped.matchAll(headRe)) {
    const head = m[0];
    const declIdx = m.index + (head.length - head.trimStart().length);
    const suspend = /\bsuspend\b/.test(head) ? 'suspend ' : '';
    let i = ws(m.index + head.length);

    const nameM = /^[A-Za-z_]\w*/.exec(stripped.slice(i, i + 200));
    if (!nameM) continue;
    const name = nameM[0];
    if (name.startsWith('_')) continue;
    i = ws(i + name.length);

    // Generic parameters, e.g. `fun <T> map(...)` handled by the head regex's
    // caller; a receiver-side `<T>` here is jumped whole.
    if (masked[i] === '<') {
      const c = readBalanced(masked, i, '<', '>');
      if (c >= 0) i = ws(c + 1);
    }
    if (masked[i] !== '(') continue;
    const close = readBalanced(masked, i);
    if (close < 0) continue;
    const params = stripped.slice(i + 1, close);

    // `: ReturnType` — read to the body `{`, the expression `=`, or EOL,
    // jumping balanced groups so `(Int) -> Int` survives intact.
    let j = close + 1;
    let ret = '';
    const scanEnd = Math.min(masked.length, close + RET_SCAN_CHARS);
    let k = ws(j);
    if (masked[k] === ':') {
      k++;
      const start = k;
      while (k < scanEnd) {
        const ch = masked[k];
        if (ch === '(') { const c = readBalanced(masked, k); if (c < 0) break; k = c + 1; continue; }
        if (ch === '<') { const c = readBalanced(masked, k, '<', '>'); if (c < 0) { k++; continue; } k = c + 1; continue; }
        if (ch === '{' || ch === '=' || ch === '\n') break;
        k++;
      }
      ret = stripped.slice(start, k).trim().replace(/\s+/g, ' ');
      j = k;
    }
    const retStr = ret ? ` → ${ret.slice(0, 25)}` : '';
    out.push({
      text: `${suspend}fun ${name}(${normalizeParams(params)})${retStr}`,
      declIdx,
      endIdx: j,
      afterRet: j,
    });
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

function extractMembers(block, maskedBlock) {
  const members = [];
  const fns = scanFunctions(block, maskedBlock,
    /^[ \t]+(?:public\s+|internal\s+|override\s+|protected\s+)?(?:suspend\s+)?fun\b/gm);
  for (const fn of fns) members.push({ text: fn.text, declIdx: fn.declIdx, endIdx: fn.endIdx });
  return capMembersWithNotice(members, MEMBER_LIMIT);
}

/**
 * Parameter NAMES only, with `: Type` and `= default` dropped.
 *
 * Depth- and string-aware: the old implementation split on every `,` and took
 * `split(':')[0]`, so `a: Int = g(1, 2)` became the two params `a` and `2`.
 * Nested delimiters are consumed with their annotation instead (#695).
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
    // Name is everything before the first top-level `:` or `=`, minus
    // modifiers Kotlin allows there (`vararg`, `crossinline`, …) which the
    // previous rendering kept, so they are kept here too.
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
    if (ch === '(' || ch === '[' || ch === '<' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    // `->` is a function-type arrow, not a generic close (`Map<String, Int>` is).
    if (ch === '>') { if (params[i - 1] !== '-') depth--; else seg += depth === 0 ? ch : ''; continue; }
    if (ch === ',' && depth === 0) { flush(); continue; }
    if (depth === 0) seg += ch;
  }
  flush();
  return names.join(', ');
}

module.exports = { extract };
