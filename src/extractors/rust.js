'use strict';

const { lineAt, withAnchor } = require('./line-anchor');
const { capWithNotice, capMembersWithNotice } = require('../util/truncate');
const { stripComments, maskCode, readBalanced } = require('./scan');

// Ceiling sits above the default `maxSigsPerFile` so the configured budget
// governs output rather than a literal buried here, and omissions are disclosed (#576).
// Class bodies are scanned to this many characters. Real classes routinely
// run past the old 4KB scan window — truncating there silently hid every
// member after ~4000 chars AND anchored class end-lines short (#576). The
// ceiling only guards against pathological input (Java parity, #551).
const MAX_CLASS_BODY_CHARS = 200000;
const PER_FILE_LIMIT = 200;

// Chars scanned past the params for a `-> Return` before giving up.
const RET_SCAN_CHARS = 400;

// Per-impl member ceiling, disclosed via capMembersWithNotice (#576).
const MEMBER_LIMIT = 120;

/**
 * Extract signatures from Rust source code.
 * Signatures carry `:start-end` line anchors (Surgical Context); the comment
 * strip below is newline-preserving so anchor lines match the original file.
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];
  const docHints = buildDocHints(src);
  // Append the doc-comment hint after the anchor as `  # <hint>` — same
  // convention as the Python/JS extractors' doc hints.
  const hinted = (sig, name) => (docHints.has(name) ? `${sig}  # ${docHints.get(name)}` : sig);

  // stripComments is length- AND newline-preserving; the previous regex strip
  // DELETED comment text, so offsets computed on it no longer aligned with the
  // masked surface the balanced reader walks (#695).
  const stripped = stripComments(src);
  // Rust lifetimes (`&'db`, `<'_>`, `'static`) start with a single quote, which
  // maskCode reads as a CHAR-LITERAL opener. That desynchronised the mask, so
  // readBalanced failed and the whole declaration was dropped — 208 signatures
  // on rust-analyzer, every one of them lifetime-annotated. Blanked on the mask
  // surface only, length-preserving, so the rendered signature keeps them.
  const masked = maskCode(blankLifetimes(src));

  // Anchor range for a declaration at declIdx whose header ends at afterIdx:
  // if a `{` body follows, range to its closing brace; else single-line.
  const rangeFor = (declIdx, afterIdx) => {
    let k = afterIdx;
    while (k < stripped.length && /[ \t]/.test(stripped[k])) k++;
    if (stripped[k] === '{') {
      const end = k + 1 + extractBlock(stripped, k + 1).length;
      return [lineAt(stripped, declIdx), lineAt(stripped, end)];
    }
    const line = lineAt(stripped, declIdx);
    return [line, line];
  };

  // Structs
  for (const m of stripped.matchAll(/^pub\s+struct\s+(\w+)(?:<[^{]*>)?/gm)) {
    const [s, e] = rangeFor(m.index, m.index + m[0].length);
    sigs.push(hinted(withAnchor(`pub struct ${m[1]}`, s, e), m[1]));
  }

  // Enums
  for (const m of stripped.matchAll(/^pub\s+enum\s+(\w+)(?:<[^{]*>)?/gm)) {
    const [s, e] = rangeFor(m.index, m.index + m[0].length);
    sigs.push(hinted(withAnchor(`pub enum ${m[1]}`, s, e), m[1]));
  }

  // Traits
  for (const m of stripped.matchAll(/^pub\s+trait\s+(\w+)(?:<[^{]*>)?/gm)) {
    const [s, e] = rangeFor(m.index, m.index + m[0].length);
    sigs.push(hinted(withAnchor(`pub trait ${m[1]}`, s, e), m[1]));
  }

  // impl blocks
  for (const m of stripped.matchAll(/^impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?(\w+)(?:<[^{]*>)?\s*\{/gm)) {
    const bodyStart = m.index + m[0].length;
    const block = extractBlock(stripped, bodyStart);
    sigs.push(withAnchor(`impl ${m[1]}`, lineAt(stripped, m.index), lineAt(stripped, bodyStart + block.length)));
    for (const fn of extractMethods(block, masked.slice(bodyStart, bodyStart + block.length))) {
      sigs.push(hinted(withAnchor(`  ${fn.text}`, lineAt(stripped, bodyStart + (fn.declIdx || 0)), lineAt(stripped, bodyStart + (fn.endIdx || 0))), fn.name));
    }
  }

  // Top-level pub fns — capture everything after ) up to { or ; for return type
  for (const m of stripped.matchAll(/^pub(?:\s+async)?\s+fn\s+(\w+)(?:<[^(]*>)?\s*\(/gm)) {
    const asyncKw = m[0].includes('async') ? 'async ' : '';
    const pr = readParams(stripped, masked, m.index + m[0].length - 1);
    if (!pr) continue;
    const retStr = extractReturnType(pr.after);
    const [s, e] = rangeFor(m.index, pr.end);
    sigs.push(hinted(withAnchor(`pub ${asyncKw}fn ${m[1]}(${normalizeParams(pr.params)})${retStr}`, s, e), m[1]));
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

/**
 * Resolve a `fn` declaration's parameter list with a BALANCED read (#695).
 *
 * `\(([^)]*)\)` stopped at the first `)`, so a closure-typed parameter —
 * `b: Box<dyn Fn(i32) -> i32>` — truncated mid-type. The `->` to `→`
 * substitution in `extractReturnType` then fired on the CLOSURE's arrow,
 * leaving the real return arrow as literal `-> i32`, so the rendering stated
 * the return type twice in two notations.
 *
 * @param {string} stripped comment-blanked surface
 * @param {string} masked   comment- AND string-blanked surface (same length)
 * @param {number} openIdx  index of the `(` that opens the params
 * @returns {{ params: string, after: string, end: number }|null}
 */
/**
 * Blank Rust lifetime tokens so they are not mistaken for char literals.
 *
 * A lifetime is `'` + identifier NOT followed by a closing `'` — which is what
 * distinguishes `&'a` from the char literal `'a'`. Length-preserving.
 * @param {string} src
 * @returns {string}
 */
function blankLifetimes(src) {
  return src.replace(/'(?:[A-Za-z_][A-Za-z0-9_]*|_)(?!')/g, (m) => ' '.repeat(m.length));
}

function readParams(stripped, masked, openIdx) {
  const close = readBalanced(masked, openIdx);
  if (close < 0) return null;
  // Return segment runs from after the params to the body `{` or a `;`.
  let i = close + 1;
  const stop = Math.min(masked.length, i + RET_SCAN_CHARS);
  while (i < stop) {
    const ch = masked[i];
    if (ch === '{' || ch === ';') break;
    if (ch === '(') { const c = readBalanced(masked, i); if (c < 0) break; i = c + 1; continue; }
    if (ch === '<') { const c = readBalanced(masked, i, '<', '>'); if (c < 0) { i++; continue; } i = c + 1; continue; }
    i++;
  }
  // `close` anchors a member to its DECLARATION line; `end` may run onto the
  // next line when the body brace sits there (C# style), which would widen the
  // anchor past the signature itself.
  return { params: stripped.slice(openIdx + 1, close), after: stripped.slice(close + 1, i), end: i, close };
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

function extractMethods(block, maskedBlock) {
  const methods = [];
  for (const m of block.matchAll(/^[ \t]+pub(?:\s+async)?\s+fn\s+(\w+)(?:<[^(]*>)?\s*\(/gm)) {
    const asyncKw = m[0].includes('async') ? 'async ' : '';
    const pr = readParams(block, maskedBlock, m.index + m[0].length - 1);
    if (!pr) continue;
    const retStr = extractReturnType(pr.after);
    methods.push({
      text: `pub ${asyncKw}fn ${m[1]}(${normalizeParams(pr.params)})${retStr}`,
      name: m[1],
      declIdx: m.index + (m[0].length - m[0].trimStart().length),
      endIdx: pr.end,
    });
  }
  return capMembersWithNotice(methods, MEMBER_LIMIT, 'methods');
}

function normalizeParams(params) {
  if (!params) return '';
  return params.trim().replace(/\s+/g, ' ');
}

function extractReturnType(afterParen) {
  if (!afterParen) return '';
  const m = afterParen.match(/->\s*([^{;]+)/);
  if (!m) return '';
  const rt = m[1].trim().replace(/\s+/g, ' ');
  return ` → ${rt.length > 30 ? rt.slice(0, 27) + '...' : rt}`;
}

// Rustdoc: the `///` block directly above a declaration → first prose
// sentence, 60-char cap. Runs on the ORIGINAL src (extract strips comments
// before matching). Attribute lines (`#[...]`) between the doc block and the
// declaration are tolerated.
function buildDocHints(src) {
  const hints = new Map();
  const re = /((?:^[ \t]*\/\/\/[^\n]*\n)+)(?:[ \t]*#\[[^\n]*\n)*[ \t]*pub(?:\s+async)?\s+(?:fn|struct|enum|trait)\s+(\w+)/gm;
  for (const m of src.matchAll(re)) {
    const hint = firstDocSentence(m[1]);
    if (hint && !hints.has(m[2])) hints.set(m[2], hint);
  }
  return hints;
}

// First prose line of a `///` block → first sentence, 60-char cap.
function firstDocSentence(block) {
  const line = String(block).split('\n')
    .map((l) => l.replace(/^[ \t]*\/\/\/\s?/, '').trim())
    .find((l) => l);
  if (!line) return '';
  return line.split(/[.!?]/)[0].trim().slice(0, 60);
}

module.exports = { extract };
