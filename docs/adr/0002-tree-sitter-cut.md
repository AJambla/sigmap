# ADR 0002 – Tree-sitter Permanently Cut

**Status:** Accepted

**Context:**
- SigMap originally considered Tree-sitter for parsing to get exact symbol locations.
- Tree-sitter would introduce a heavy dependency (C library + JS bindings) and compile-time complexity.
- An opt-in form was also considered and rejected: it carries the same per-language grammar maintenance burden while leaving the default path unchanged, so it buys no determinism.
- Regex plus a shared balanced scanner covers the supported languages; the residual gaps are documented in `KNOWN_LIMITATIONS.md`.

**Decision:**
- Permanently removed Tree-sitter from the dependency graph.
- Keep regex-based extraction as the primary method.
- Use manual parsing only for edge cases where regex fails.
- Where more exactness is wanted, the opt-in `exactness` tiers reuse toolchains the repository *already has* rather than adding one: `exactness.typescript` parses `.ts` with the target repo's own `node_modules/typescript`, `exactness.lsp` uses a language server already on the machine, `exactness.scip` reads a CI-produced `index.scip`. All default to `false` with silent regex fallback, and the generated header labels the toolchain version used.
- Document known regex limitations in KNOWN_LIMITATIONS.md.

**Consequences:**
- Zero external dependencies (aligned with zero-dep score).
- Deterministic output (no compiled binary variations).
- Simpler build and CI.
- Reduced maintenance surface area.
- Some edge cases may have slightly less precise extraction, but acceptable given the trade-offs.

**References:**
- `src/extractors/scan.js` (shared balanced scanner)
- `src/extractors/typescript_native.js`, `src/extractors/lsp_symbols.js`, `src/extractors/scip_symbols.js` (opt-in exactness tiers)
- `src/config/defaults.js` (`exactness.*`, all off by default)
- `KNOWN_LIMITATIONS.md` (regex gaps)
- `src/extractors/*` (current extraction implementations)