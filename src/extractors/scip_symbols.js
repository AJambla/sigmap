'use strict';

const fs = require('fs');
const path = require('path');
const { parseIndex } = require('../scip/reader');
const { anchor } = require('./line-anchor');
const { capWithNotice } = require('../util/truncate');

// SCIP index → signature lines (#618, tier T4 of #542, import only). When a
// repo's CI already produced `index.scip` at the root, its documents carry
// compiler-typed signatures inside `documentation[0]` code fences — richer
// than the regex tier and free at extraction time. This renders them into the
// signature vocabulary with anchors from definition occurrences. As with the
// LSP tier, the wiring applies a per-file quality guard, so a sparse or stale
// index entry never loses surface vs the regex floor, and the toolchain label
// (`scip:<tool>@<version>` from Metadata) is registered only on acceptance.

const PER_FILE_LIMIT = 200;
const SIG_TEXT_CHARS = 110;
const HINT_CHARS = 60;

// SCIP symbol grammar suffixes to SKIP — not API surface:
//   `(name)`  parameter · `[T]` type parameter · `local N` locals ·
//   trailing `/` package/file symbols · `typeLiteral` synthesized members
const SKIP_SYMBOL = /\((?:[^()]*)\)$|\[[^\]]*\]$|(^|\s)local\s+\d|\/$|typeLiteral/;

let _cache = null; // { cwd, mtimeMs, size, index } — reloaded when the file changes

function _loadIndex(cwd) {
  const p = path.join(cwd, 'index.scip');
  let st;
  try { st = fs.statSync(p); } catch (_) { return null; }
  if (_cache && _cache.cwd === cwd && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size) {
    return _cache.index;
  }
  try {
    const index = parseIndex(fs.readFileSync(p));
    _cache = { cwd, mtimeMs: st.mtimeMs, size: st.size, index };
    return index;
  } catch (_) {
    _cache = { cwd, mtimeMs: st.mtimeMs, size: st.size, index: null };
    return null;
  }
}

/** Fence interior of a SCIP documentation string, compacted to one line. */
function _sigText(doc) {
  const m = /^```[\w-]*\n([\s\S]*?)\n?```/.exec(doc || '');
  const inner = m ? m[1] : '';
  return inner.replace(/\s+/g, ' ').trim().slice(0, SIG_TEXT_CHARS);
}

function _hint(doc) {
  return String(doc || '').replace(/\s+/g, ' ').trim().split(/[.!?]/)[0].trim().slice(0, HINT_CHARS);
}

/** Member-of relation from SCIP symbol structure: `...X#member().` ⊂ `...X#`. */
function _isMemberSymbol(symbol) {
  const hash = symbol.lastIndexOf('#');
  return hash !== -1 && hash < symbol.length - 1;
}

/**
 * Extract signatures for one file from the repo's SCIP index.
 * Returns null (caller falls back) when there is no usable entry.
 * @param {string} filePath - absolute path
 * @param {string} cwd - repo root (where index.scip lives)
 * @returns {{ sigs: string[], label: string }|null}
 */
function extractViaScip(filePath, cwd) {
  if (!cwd) return null;
  const index = _loadIndex(cwd);
  if (!index) return null;
  const rel = path.relative(cwd, path.resolve(filePath)).replace(/\\/g, '/');
  const doc = index.documents.get(rel);
  if (!doc || doc.defs.length === 0) return null;

  const rows = [];
  for (const def of doc.defs) {
    if (SKIP_SYMBOL.test(def.symbol)) continue;
    const docs = doc.symbols.get(def.symbol) || [];
    const text = _sigText(docs[0]);
    if (!text) continue;
    const startLn = (def.range[0] || 0) + 1;
    // Occurrence ranges cover the identifier; enclosing_range (when the
    // indexer emits it) covers the whole declaration and gives a real end.
    const endLn = def.enclosing && def.enclosing.length >= 3
      ? def.enclosing[def.enclosing.length === 3 ? 0 : 2] + 1
      : startLn;
    const hint = _hint(docs[1]);
    rows.push({
      text: `${_isMemberSymbol(def.symbol) ? '  ' : ''}${text}${anchor(startLn, Math.max(endLn, startLn))}${hint ? `  # ${hint}` : ''}`,
      start: startLn,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.start - b.start);
  const sigs = capWithNotice(rows.map((r) => r.text), PER_FILE_LIMIT, 'signatures');
  return { sigs, label: `scip:${index.tool || 'unknown'}` };
}

const _labels = new Set();

/** Register a label once the wiring has ACCEPTED the SCIP result. */
function acceptLabel(label) {
  if (label) _labels.add(label);
}

/** Toolchain labels for indexes whose entries were actually used this run. */
function toolchainLabels() {
  return [..._labels].sort();
}

module.exports = { extractViaScip, acceptLabel, toolchainLabels };
