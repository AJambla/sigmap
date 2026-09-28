# ADR 0005 – Why Centrality Was Shipped Flag-Gated

**Status:** Accepted

**Context:**
- Centrality blend (import-graph centrality) shipped in **v8.21.0** (#501, PR #502) as a small additive prior.
- `src/graph/centrality.js` runs zero-dependency power iteration over the forward import graph (damping 0.85, 20 iterations, sorted nodes, dangling mass redistributed, deterministic) and max-normalizes to (0,1].
- `rank()` then blends `0.3 × centrality` onto **positively-scored files only** — a tie-breaker among matches, never a way to surface non-matches.
- It was shipped flag-gated (`retrieval.centralityBlend: false`) because:
  - Impact on benchmark scores was unknown
  - Risk of changing ranking behavior for existing users
  - Need to measure before enabling universally

**Decision:**
- Ship with the feature disabled (`false` by default).
- Keep the implementation and configuration exposed for opt-in testing.
- Measure impact on retrieval and task benchmarks before enabling by default, via the A/B gate `npm run benchmark:centrality-blend` (`scripts/run-centrality-blend-benchmark.mjs`).
- The flag remains available for users who want the boost today.

**Consequences:**
- Users enable it by setting `"centralityBlend": true` under `"retrieval"` in the project's `gen-context.config.json`. There is no CLI flag for it — config file is the mechanism, same as every other `retrieval.*` key.
- The first A/B (90 tasks / 18 repos) scored both arms at 77.8% hit@5 — non-regressing but neutral on a lexical-favoring corpus, so the measure gate kept it **off**. A neutral result is a reason to keep measuring, not to enable.
- Future releases can enable it by default after sufficient positive data.
- No breaking change for existing users.
- Benchmarks continue to measure the feature without affecting default behavior.

**References:**
- `src/graph/centrality.js` (power iteration)
- `src/retrieval/ranker.js` (`CENTRALITY_BLEND_WEIGHT = 0.3`, positive-score-only application)
- `src/config/defaults.js` (`retrieval.centralityBlend` default `false`)
- `scripts/run-centrality-blend-benchmark.mjs` (the A/B gate)
- Issue [#703](https://github.com/manojmallick/sigmap/issues/703) (re-measure and decide on enabling)