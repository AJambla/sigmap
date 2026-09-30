'use strict';

/**
 * Notes as a retrieval signal (#776).
 *
 * `sigmap note` writes human-authored facts to `.context/notes.ndjson`, and
 * until now nothing in the retrieval path read them: every `readNotes` call
 * site was the `note` command listing its own notes, `status` counting them, or
 * the MCP `read_memory` tool. A note saying "the redaction logic lives in
 * src/security/patterns.js" could not influence a query about redaction — the
 * one thing a decision log is for.
 *
 * This module turns notes into a bounded, relevance-gated signal:
 *   - a note is considered only if it shares substantive vocabulary with the query
 *   - a relevant note boosts the files whose paths it names
 *   - relevant notes are rendered into the emitted context so the agent sees them
 *
 * Deliberately inert when no notes exist, so a repo that never ran `note` —
 * including every benchmark repo — produces byte-identical ranking.
 *
 * Deterministic, offline, zero dependencies. Reuses the ranker's tokenizer so
 * notes and queries are tokenized the same way the index is.
 */

const { tokenize } = require('../retrieval/bm25');

/** Most recent notes considered for a single query. */
const MAX_NOTES = 20;

/**
 * Minimum share of a note's tokens that must also appear in the query.
 *
 * Gated rather than unconditional: appending every note to every answer would
 * make notes noise, and the issue's own criterion is that notes must not leak
 * into unrelated queries.
 */
const RELEVANCE_FLOOR = 0.2;

/**
 * Share of the query's own top score granted to a file a relevant note names.
 *
 * Relative, not a fixed constant: observed scores span roughly 4–30 depending
 * on the query and repo, so any absolute number would be decisive on one query
 * and invisible on another. Scaling by the top score makes the boost mean the
 * same thing everywhere — "worth about half of the best hit, weighted by how
 * well the note matches".
 *
 * It is ADDITIVE rather than multiplicative because a multiplier cannot lift a
 * zero-scoring file, and zero is exactly the case a note is most valuable in:
 * the ranker found no lexical overlap and a human already knew the answer. The
 * `max(top, 1)` floor keeps that case working when every score is 0.
 */
const NOTE_BOOST = 0.5;

/** Path-shaped tokens inside a note, e.g. `src/security/patterns.js`. */
const PATH_RE = /\b[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]+\b/g;

/**
 * Overlap between a note and a query, as a share of the note's own tokens.
 *
 * Normalizing by the note (not the query) keeps a long note from scoring highly
 * just for being long, and lets a short, pointed note match strongly.
 *
 * @returns {number} 0–1
 */
function relevance(noteText, queryTokens) {
  const noteTokens = tokenize(noteText || '');
  if (noteTokens.length === 0 || queryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of noteTokens) if (queryTokens.has(t)) hits++;
  return Math.round((hits / noteTokens.length) * 1000) / 1000;
}

/** Repo-relative paths a note mentions. */
function pathsIn(noteText) {
  return [...new Set(String(noteText || '').match(PATH_RE) || [])];
}

/**
 * Select the notes relevant to a query.
 *
 * @param {object[]} notes  entries from `readNotes` (chronological)
 * @param {string} query
 * @returns {Array<{text:string, ts:string, branch:string|null, score:number, paths:string[]}>}
 *          most relevant first; empty when nothing clears the floor
 */
function selectRelevant(notes, query) {
  if (!Array.isArray(notes) || notes.length === 0 || !query) return [];
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const recent = notes.slice(-MAX_NOTES);
  const scored = [];
  for (const n of recent) {
    const score = relevance(n && n.text, queryTokens);
    if (score < RELEVANCE_FLOOR) continue;
    scored.push({
      text: n.text,
      ts: n.ts || '',
      branch: n.branch || null,
      score,
      paths: pathsIn(n.text),
    });
  }
  // Most relevant first; ties broken by recency (later ts wins), then text, so
  // the order is total and reproducible.
  scored.sort((a, b) => b.score - a.score || String(b.ts).localeCompare(String(a.ts)) || a.text.localeCompare(b.text));
  return scored;
}

/**
 * Re-order ranked results so files named by a relevant note rise.
 *
 * Applied AFTER ranking rather than inside `rank()` so the scoring core stays
 * free of session state and the benchmark harness is unaffected.
 *
 * @param {Array<{file:string, score:number}>} ranked
 * @param {Array<{paths:string[]}>} relevantNotes
 * @returns {Array} a new array; the input is not mutated
 */
function applyNoteBoost(ranked, relevantNotes) {
  if (!Array.isArray(ranked) || ranked.length === 0) return ranked;
  if (!Array.isArray(relevantNotes) || relevantNotes.length === 0) return ranked;

  const named = new Set();
  for (const n of relevantNotes) for (const p of n.paths || []) named.add(p.replace(/^\.\//, ''));
  if (named.size === 0) return ranked;

  const matches = (file) => {
    const f = String(file).replace(/\\/g, '/');
    for (const p of named) {
      if (f === p || f.endsWith('/' + p) || p.endsWith('/' + f)) return true;
    }
    return false;
  };

  // Best note relevance per named path, so a strongly-matching note lifts more
  // than a marginal one.
  const weightFor = (file) => {
    let best = 0;
    for (const n of relevantNotes) {
      for (const p of (n.paths || [])) {
        const q = p.replace(/^\.\//, '');
        const f = String(file).replace(/\\/g, '/');
        if (f === q || f.endsWith('/' + q) || q.endsWith('/' + f)) {
          if (n.score > best) best = n.score;
        }
      }
    }
    return best;
  };

  const top = ranked.reduce((m, r) => (typeof r.score === 'number' && r.score > m ? r.score : m), 0);
  const scale = Math.max(top, 1);

  const out = ranked.map((r) => {
    if (!matches(r.file)) return r;
    const gain = scale * NOTE_BOOST * weightFor(r.file);
    return Object.assign({}, r, {
      score: Math.round((r.score + gain) * 1000) / 1000,
      signals: Object.assign({}, r.signals, { noteBoost: Math.round(gain * 1000) / 1000 }),
    });
  });
  out.sort((a, b) => b.score - a.score || String(a.file).localeCompare(String(b.file)));
  return out;
}

/** Render relevant notes as a `## Notes` context section, or '' when there are none. */
function formatNotesSection(relevantNotes) {
  if (!Array.isArray(relevantNotes) || relevantNotes.length === 0) return '';
  const lines = ['## Notes', '', '_Human-authored notes matching this query (`sigmap note`)._', ''];
  for (const n of relevantNotes) {
    const when = String(n.ts).replace('T', ' ').slice(0, 16);
    const br = n.branch ? ` (${n.branch})` : '';
    lines.push(`- [${when}${br}] ${n.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  selectRelevant,
  applyNoteBoost,
  formatNotesSection,
  relevance,
  pathsIn,
  MAX_NOTES,
  RELEVANCE_FLOOR,
  NOTE_BOOST,
};
