'use strict';

/**
 * One read path for run history (#773).
 *
 * Four surfaces published a token-reduction figure and no two were comparable:
 *
 *   --health   "no history", 0 runs      read usage.ndjson
 *   gain       2,047 operations, 96.5%   read gain.ndjson
 *   budget     142 ops, session window   read gain.ndjson, windowed
 *   --report   97.6%                     this run only
 *
 * The cause was not arithmetic. `tracking` defaults to FALSE, so
 * `.context/usage.ndjson` is never written — and that is the store `--health`,
 * `history` and the dashboard read. Meanwhile `recordUsage` writes
 * `.context/gain.ndjson` unconditionally. Two stores for one concept, and the
 * three surfaces that looked empty were reading the one nobody fills.
 *
 * (`.context/usage.json` is NOT a third token store despite appearances — it is
 * the star-nudge run counter and has nothing to do with tokens.)
 *
 * This module is the single read path. It normalises both stores into one
 * record shape and reports which contributed, so a caller can label what it is
 * showing rather than implying a population it does not have.
 */

const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join('.context', 'usage.ndjson');
const GAIN_FILE  = path.join('.context', 'gain.ndjson');

function readNdjson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

/**
 * Normalised run record. Only `generate` operations are runs — `gain` also
 * records `ask` queries, which are a different population and must not be
 * counted as runs (that conflation is how "2,047" and "525" both described
 * the same log).
 *
 * @returns {{ts:string, version:string, rawTokens:number, finalTokens:number,
 *            reductionPct:number, source:'usage'|'gain'}[]} oldest first
 */
function readRuns(cwd) {
  const out = [];

  for (const e of readNdjson(path.join(cwd, USAGE_FILE))) {
    if (!e || typeof e.rawTokens !== 'number') continue;
    out.push({
      ts: e.ts, version: e.version || 'unknown',
      rawTokens: e.rawTokens, finalTokens: e.finalTokens || 0,
      reductionPct: typeof e.reductionPct === 'number' ? e.reductionPct : 0,
      // Only the tracked store records these. `null` means NOT RECORDED, not
      // zero/false — rendering an unrecorded field as a measured value is the
      // same defect #764 fixed in `bench --submit`.
      fileCount: typeof e.fileCount === 'number' ? e.fileCount : null,
      overBudget: typeof e.overBudget === 'boolean' ? e.overBudget : null,
      source: 'usage',
    });
  }

  for (const e of readNdjson(path.join(cwd, GAIN_FILE))) {
    if (!e || e.op !== 'generate' || typeof e.baselineTokens !== 'number') continue;
    out.push({
      ts: e.ts, version: e.v || 'unknown',
      rawTokens: e.baselineTokens, finalTokens: e.actualTokens || 0,
      reductionPct: typeof e.savedPct === 'number' ? e.savedPct : 0,
      fileCount: null,   // gain does not record it
      overBudget: null,  // gain does not record it
      source: 'gain',
    });
  }

  // A run logged to both stores appears twice; the timestamps are written in
  // the same call, so dedupe on the second.
  const seen = new Set();
  return out
    .filter((r) => {
      const key = String(r.ts).slice(0, 19);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/** Which stores actually hold data, for labelling the window a figure covers. */
function describeSource(cwd) {
  const tracked = readNdjson(path.join(cwd, USAGE_FILE)).length;
  const gain = readNdjson(path.join(cwd, GAIN_FILE)).filter((e) => e && e.op === 'generate').length;
  return {
    tracked, gain,
    total: readRuns(cwd).length,
    stores: [tracked ? 'usage.ndjson' : null, gain ? 'gain.ndjson' : null].filter(Boolean),
  };
}

/** Task-weighted reduction over the given runs, with the baseline named. */
function summarizeRuns(runs) {
  if (!runs || runs.length === 0) {
    return { totalRuns: 0, avgReductionPct: null, rawTokens: 0, finalTokens: 0 };
  }
  const rawTokens = runs.reduce((n, r) => n + (r.rawTokens || 0), 0);
  const finalTokens = runs.reduce((n, r) => n + (r.finalTokens || 0), 0);
  const avg = runs.reduce((n, r) => n + (r.reductionPct || 0), 0) / runs.length;
  return {
    totalRuns: runs.length,
    avgReductionPct: parseFloat(avg.toFixed(1)),
    rawTokens, finalTokens,
  };
}

module.exports = { readRuns, describeSource, summarizeRuns, USAGE_FILE, GAIN_FILE };
