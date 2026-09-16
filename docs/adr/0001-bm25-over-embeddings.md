# ADR 0001 – BM25 over Embeddings

**Status:** Accepted

**Context:**
- SigMap aims to be deterministic, zero‑dependency, and offline‑first.
- Embedding models introduce non‑determinism, large model files, and external API costs.

**Decision:**
- Use a TF‑IDF based BM25 ranking algorithm for query‑file relevance.
- This approach guarantees byte‑stable results, zero external dependencies, and fast execution.

**Consequences:**
- No need for a vector database or embedding extraction pipeline.
- Future work may add optional embedding support behind a feature flag, but the default remains BM25.

**References:**
- `src/retrieval/bm25.js`
- Benchmark results in `docs/benchmarks.md`
