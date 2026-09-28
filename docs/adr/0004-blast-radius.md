# ADR 0004 – Blast-Radius Formula

**Status:** Accepted

**Context:**
- SigMap reports impact at two layers: which *files* break if one changes, and how much *code* transitively calls into a changed method.
- The original design used simple depth-based traversal, which was too shallow for JVM projects — Java puts one directory per package segment.
- Issue #561 raised the dependency-graph walk to 12; #590 raised extraction depth to match, so the two halves stopped disagreeing about how deep the repo goes.
- Review output has to be byte-stable for a fixed tree, so the scorer can contain no heuristic that varies run to run.

**Decision:**
- File-level impact (`src/graph/impact.js`) BFSes the reverse **import** graph from the changed file, splitting results into direct, transitive, tests and routes. Depth comes from `impact.depth` in `gen-context.config.json`, default **3**, where `0` means unlimited.
- Method-level blast radius (`src/graph/blast-radius.js`) resolves the functions the changed file defines, BFSes the reverse **call** graph, and scores:

  `score = min(100, direct × 4 + transitive × 1)`

  `direct` are first-level callers, `transitive` everything deeper. Default `depth` is **0 = unlimited** — the ceiling is the 100 cap, not a hop limit.
- A direct caller weighs 4× a transitive one because the caller wired straight to the change is the one that must be edited; deeper breakage is real but diffuse, so it counts once each rather than decaying per hop.
- Tiers are fixed bands on that score: `0 → none · 1–9 → low · 10–29 → medium · 30–59 → high · 60+ → critical`.
- `impactedFunctions` lists at most 12 names per file and test callers are counted separately, so large fan-in moves the score without moving the report's size.
- Hub suppression is **not** part of this formula. It is a ranking concern: `src/retrieval/ranker.js` declines to graph-boost files whose fanout exceeds 20% of the graph (plus known utility paths) so high-fanout files don't surface on every query.

**Consequences:**
- Same tree in, same numbers out — PR Evidence lines and review findings can be diffed and gated in CI.
- JVM projects get real coverage from the depth-12 walk instead of reading as leaf files.
- Scores saturate: 25 direct callers and 400 both read `critical`. Ranking severity past that point is left to the reader.
- Unlimited default depth makes the call graph's completeness a precondition, because an empty graph reports zero impact rather than an error — the failure mode #586 hit when Kotlin and Scala had no `extractDefs` entries.
- No false positives from highly connected utility files, since those are suppressed where they would distort ranking rather than in the impact number itself.

**References:**
- `src/graph/blast-radius.js` (`DIRECT_WEIGHT`, `TRANSITIVE_WEIGHT`, `tierFor`)
- `src/graph/impact.js` (file-level BFS and `depth` semantics)
- `src/graph/call-graph.js` (the reverse call edges it consumes)
- `src/retrieval/ranker.js` (hub suppression — a separate concern)
- Issue [#561](https://github.com/manojmallick/sigmap/issues/561) (graph walk depth and srcDirs), [#590](https://github.com/manojmallick/sigmap/issues/590) (JVM extraction depth), [#586](https://github.com/manojmallick/sigmap/issues/586) (empty graph reads as zero)