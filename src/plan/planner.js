'use strict';

const fs = require('fs');
const { buildFromCwd } = require('../graph/builder');
const { getImpact } = require('../graph/impact');
const { buildSigIndex, rank, detectIntent } = require('../retrieval/ranker');
const { buildTestIndex, isTested } = require('../extractors/coverage');

module.exports = { createPlan };

function createPlan(goal, cwd, config = {}) {
  // Step 1: Detect intent and rank files for the goal
  const intent = detectIntent(goal);
  const sigIndex = buildSigIndex(cwd);
  if (sigIndex.size === 0) {
    return { error: 'no context found' };
  }

  const ranked = rank(goal, sigIndex, { topK: 15, cwd });

  // Step 2: Separate into confidence levels
  const highConf = ranked.filter(r => r.confidence === 'high').slice(0, 5);
  const medConf = ranked.filter(r => r.confidence === 'medium').slice(0, 5);

  // Step 3: Impact radius — union the reverse-dependency blast radius of EVERY
  // high-confidence file (not just the top one), bounded to 3 hops. Note the
  // dependency graph resolves relative imports only, so this is a *lower bound*
  // on real coupling (aliased/bare/dynamic imports are invisible). Previously
  // this passed `{ maxDepth: 3 }`, which getImpact ignores — it reads `depth`,
  // so the traversal silently ran unbounded (depth 0). Fixed to `depth: 3`.
  let impact = null;
  if (highConf.length > 0) {
    try {
      const graph = buildFromCwd(cwd);
      // getImpact already returns repo-relative, original-case paths (it renders
      // lowercased graph keys through the graph's realPaths map). Only the
      // separator needs normalising so dedup against the entry set matches.
      const clean = (f) => String(f).replace(/\\/g, '/');
      const entrySet = new Set(highConf.map(r => r.file));
      const direct = new Set();
      const transitive = new Set();
      for (const r of highConf) {
        const imp = getImpact(r.file, graph, { depth: 3, cwd });
        for (const f of (imp.direct || [])) direct.add(clean(f));
        for (const f of (imp.transitive || [])) transitive.add(clean(f));
      }
      // The files we plan to change are not their own blast radius; and a file
      // reached directly from one entry outranks a transitive reach from another.
      for (const e of entrySet) { direct.delete(e); transitive.delete(e); }
      for (const f of direct) transitive.delete(f);
      impact = { direct: [...direct], transitive: [...transitive] };
    } catch (_) {
      // Graph build failed, continue without impact
    }
  }

  // Step 4: Flag which files-to-inspect have detectable test coverage. The test
  // index maps test-*name tokens*, not test files, so `isTested` can only tell
  // us a source file is covered — it cannot name the test file. We therefore
  // report the covered SOURCE files honestly rather than pretending to list the
  // tests to run.
  let coveredFiles = [];
  try {
    const testIndex = buildTestIndex(cwd, config.testDirs || ['test', 'tests', '__tests__', 'spec']);
    coveredFiles = highConf.filter(r => {
      const fnNames = (r.sigs || []).map(s => {
        const m = s.match(/(?:function|def|fn)\s+(\w+)/);
        return m ? m[1] : null;
      }).filter(Boolean);
      return fnNames.some(fn => isTested(fn, testIndex));
    }).map(r => r.file);
  } catch (_) {
    // Coverage index failed, continue without test info
  }

  return {
    goal,
    intent,
    inspectFirst: highConf.map(r => r.file),
    likelyToChange: medConf.map(r => r.file),
    impactRadius: impact,
    coveredFiles,
    // `testsAffected` retained for backward compatibility; it is the set of
    // covered source files, NOT the test files (which the index cannot name).
    testsAffected: coveredFiles,
  };
}
