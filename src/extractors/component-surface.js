'use strict';

const { readBalanced } = require('./scan');

// Web-component surface for the TS/JS extractors (#537). The class extractor
// sees a Lit or Angular component's methods but loses everything that makes
// it a component — the tag name or selector, the reactive/input/output
// fields, and the base class. For an agent those ARE the public API. This is
// decorator-aware enrichment in the hooks/Zustand idiom family, not a new
// extractor: every addition is gated on detecting a component marker, so
// non-component classes stay byte-identical.

// Decorators (and nothing but decorators/whitespace/modifier keywords) may
// sit between a recognised marker and its class declaration.
const GAP_RE = /^(?:\s|@[\w.]+\([^)]*\)|export|default|abstract)*$/;

const CUSTOM_ELEMENT_RE = /@customElement\(\s*['"]([^'"]+)['"]\s*\)/g;
const NG_COMPONENT_RE = /@(?:Component|Directive)\(/g;
const DEFINE_RE = /customElements\.define\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g;

const PROP_RE = /@(property|state)\s*\(([^)]*)\)\s*(?:declare\s+)?(?:readonly\s+)?(\w+)\s*([?!]?)\s*(?::\s*([^=;\n]+))?/g;
const IO_RE = /@(Input|Output)\s*\(\s*(?:['"][^'"]*['"])?\s*\)\s*(?:declare\s+)?(?:readonly\s+)?(\w+)\s*([?!]?)\s*(?::\s*([^=;\n]+))?/g;

const TYPE_CHARS = 30;
const _type = (t) => (t ? `: ${t.trim().replace(/\s+/g, ' ').slice(0, TYPE_CHARS)}` : '');

/**
 * Pre-pass over a whole (comment-stripped) source: component markers by the
 * class index they attach to, plus `customElements.define` tags by class name.
 * @param {string} stripped
 * @returns {{ decorated: Map<number, {tag?: string, selector?: string}>, defined: Map<string, string> }}
 */
function scanComponentMarkers(stripped) {
  const decorated = new Map();
  const defined = new Map();

  const attach = (endIdx, info) => {
    // The marker binds to the next `class` whose gap is decorators-only.
    const rel = stripped.slice(endIdx).search(/(?:^|\n)[^\n]*\bclass\s+\w/);
    if (rel === -1) return;
    const classAt = endIdx + rel;
    if (!GAP_RE.test(stripped.slice(endIdx, classAt))) return;
    const existing = decorated.get(classAt) || {};
    decorated.set(classAt, Object.assign(existing, info));
  };

  for (const m of stripped.matchAll(CUSTOM_ELEMENT_RE)) {
    attach(m.index + m[0].length, { tag: m[1] });
  }
  for (const m of stripped.matchAll(NG_COMPONENT_RE)) {
    const open = m.index + m[0].length - 1;
    const close = readBalanced(stripped, open);
    if (close === -1) continue;
    const cfg = stripped.slice(open + 1, close);
    const sel = /selector\s*:\s*['"]([^'"]+)['"]/.exec(cfg);
    attach(close + 1, sel ? { selector: sel[1] } : { selector: '' });
  }
  for (const m of stripped.matchAll(DEFINE_RE)) {
    defined.set(m[2], m[1]);
  }
  return { decorated, defined };
}

/**
 * Component-marker lookup for one class match. `classLineStart` is the match
 * index of the class STATEMENT (line start); decorators bind to the position
 * of the `class` keyword itself, so probe the small window between them.
 */
function markersForClass(decorated, stripped, classLineStart, matchText) {
  const kw = classLineStart + matchText.search(/\bclass\s/);
  for (const [at, info] of decorated) {
    if (at >= classLineStart - 1 && at <= kw + 1) return info;
  }
  return null;
}

/**
 * Component surface member lines for a class body.
 * @param {string} block - class body (comment-stripped)
 * @returns {Array<{text: string, start: number, end: number}>} offsets within block
 */
function componentMembers(block) {
  const out = [];
  for (const m of block.matchAll(PROP_RE)) {
    const opt = m[4] === '?' ? '?' : '';
    out.push({ text: `@${m[1]} ${m[3]}${opt}${_type(m[5])}`, start: m.index, end: m.index + m[0].length });
  }
  for (const m of block.matchAll(IO_RE)) {
    const opt = m[3] === '?' ? '?' : '';
    out.push({ text: `@${m[1]}() ${m[2]}${opt}${_type(m[4])}`, start: m.index, end: m.index + m[0].length });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

module.exports = { scanComponentMarkers, markersForClass, componentMembers };
