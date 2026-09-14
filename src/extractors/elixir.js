'use strict';

const { capWithNotice } = require('../util/truncate');

// Ceiling discloses what it drops rather than truncating silently (#576).
const PER_FILE_LIMIT = 200;
const HINT_CHARS = 60;
const SPEC_CHARS = 30;

/**
 * Extract signatures from Elixir source code (.ex/.exs) — Tier 3 (#538).
 *
 * Recognised constructs:
 *   - `defmodule Mod.Name do` blocks, with `@moduledoc` first sentence
 *   - `def`/`defp`/`defmacro`/`defmacrop name(params)` (parens optional,
 *     `when` guards stripped), indented under their module
 *   - `@spec name(...) :: ret` as a `→ ret` return hint on the next def
 *   - `@doc "..."` / `@doc \"\"\"..."\"\"` first sentence as a doc hint
 *
 * Regex-only and zero-dependency, in the Lua/Ruby Tier-3 family.
 *
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];
  const lines = stripComments(src).split('\n');

  // Pending attribute state: @doc/@spec bind to the NEXT def; @moduledoc to
  // the enclosing module line just emitted.
  let pendingDoc = '';
  let pendingSpec = '';
  let moduleIdx = -1; // index in sigs of the current module line, for @moduledoc

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const mod = /^\s*defmodule\s+([A-Z][\w.]*)\s+do\b/.exec(line);
    if (mod) {
      sigs.push(`defmodule ${mod[1]}`);
      moduleIdx = sigs.length - 1;
      pendingDoc = '';
      pendingSpec = '';
      continue;
    }

    const moduledoc = /^\s*@moduledoc\s+(.*)/.exec(line);
    if (moduledoc && moduleIdx !== -1) {
      const text = docText(moduledoc[1], lines, i);
      if (text && !sigs[moduleIdx].includes('  # ')) sigs[moduleIdx] += `  # ${text}`;
      continue;
    }

    const doc = /^\s*@doc\s+(.*)/.exec(line);
    if (doc) {
      pendingDoc = docText(doc[1], lines, i);
      continue;
    }

    const spec = /^\s*@spec\s+\w+[?!]?\s*\(.*::\s*(.+?)\s*$/.exec(line)
      || /^\s*@spec\s+\w+[?!]?\s+::\s*(.+?)\s*$/.exec(line);
    if (spec) {
      pendingSpec = spec[1].replace(/\s+/g, ' ').slice(0, SPEC_CHARS);
      continue;
    }

    const def = /^(\s*)(defmacrop?|defp?)\s+([a-z_]\w*[?!]?)\s*(?:\(([^)]*)\))?/.exec(line);
    if (def) {
      const name = def[3];
      if (name.startsWith('_') && !name.startsWith('__')) { pendingDoc = ''; pendingSpec = ''; continue; }
      const params = normalizeParams(def[4] || '');
      const ret = pendingSpec ? ` → ${pendingSpec}` : '';
      const hint = pendingDoc ? `  # ${pendingDoc}` : '';
      const indent = moduleIdx !== -1 ? '  ' : '';
      sigs.push(`${indent}${def[2]} ${name}(${params})${ret}${hint}`);
      pendingDoc = '';
      pendingSpec = '';
    }
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

/** First sentence of a @doc/@moduledoc value; follows heredocs one line in. */
function docText(rest, lines, i) {
  let text = rest.trim();
  if (text.startsWith('"""') || text.startsWith("'''")) {
    text = text.slice(3).trim();
    // Heredoc: take the first non-empty following line when the opener is bare.
    for (let j = i + 1; !text && j < lines.length && j < i + 4; j++) {
      const l = lines[j].trim();
      if (l.startsWith('"""') || l.startsWith("'''")) break;
      text = l;
    }
  }
  text = text.replace(/^["']|["']\s*\)?\s*$/g, '').replace(/\\n[\s\S]*$/, '');
  if (text === 'false') return '';
  return text.split(/[.!?]/)[0].trim().slice(0, HINT_CHARS);
}

function normalizeParams(params) {
  if (!params) return '';
  // Strip default values (`\\ default`) and pattern-match internals down to
  // the binding name where one is visible.
  return params
    .split(',')
    .map((p) => {
      let s = p.trim().split('\\\\')[0].trim();
      const asMatch = /=\s*([a-z_]\w*)\s*$/.exec(s); // %{...} = user
      if (asMatch) s = asMatch[1];
      return s.replace(/\s+/g, ' ');
    })
    .filter(Boolean)
    .join(', ');
}

/** Blank `#` comments while preserving line structure; strings kept. */
function stripComments(src) {
  return String(src)
    .split('\n')
    .map((line) => {
      let out = '';
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          out += ch;
          if (ch === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
        if (ch === '#') break;
        out += ch;
      }
      return out;
    })
    .join('\n');
}

module.exports = { extract };
