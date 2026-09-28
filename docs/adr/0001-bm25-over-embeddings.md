# ADR 0001 – BM25 over Embeddings

**Status:** Accepted

**Context:**
- SigMap aims to be deterministic, zero‑dependency, and offline‑first.
- Embedding models introduce non‑determinism, large model files, and external API costs.

**Decision:**
- Use an identifier‑aware BM25 ranking algorithm as the base relevance signal, modulated by keyword/symbol/path weights, dependency‑graph and centrality boosts, and learned file weights — see `src/retrieval/ranker.js` and `src/retrieval/bm25.js`.
- This approach guarantees byte‑stable results, zero external dependencies, and fast execution.

**Consequences:**
- No need for a vector database or embedding extraction pipeline.
- Future work may add optional embedding support behind a feature flag, but the default remains BM25.

**References:**
- `src/retrieval/bm25.js`
- Benchmark results in `docs-vp/guide/benchmark.md` and `benchmarks/latest.json`
- `package.json` (zero runtime dependencies) and `README.md` ("no LLM calls, no embeddings, byte-stable output") — the two public properties an embedding backend would cost. Adding one brings a model artifact plus a network or native-runtime requirement, which collapses the zero-dependency and determinism guarantees at once. That is the core reason BM25 was chosen and embeddings rejected.
