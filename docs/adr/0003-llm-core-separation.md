# ADR 0003 – No LLM in Deterministic Core

**Status:** Accepted

**Context:**
- SigMap's core extraction and indexing must be deterministic and reproducible.
- LLMs introduce non-determinism, API costs, and privacy concerns.
- The core product (CLI, MCP server) should work offline with zero external dependencies.
- Agents consume SigMap's output; SigMap does not consume an agent's output. The integration point is a *rendered artifact*, not a model call.

**Decision:**
- Core extraction uses regex-based parsers only (no LLM calls).
- SigMap never calls an LLM API anywhere in the pipeline. There is no API key, no model artifact, and no inference path in the product.
- What the repo calls "adapters" are output formatters, not model clients: `packages/adapters/` renders the same deterministic context into the shape each host agent expects (`copilot`, `claude`, `cursor`, `windsurf`, `openai`, `gemini`, `codex`, `willow`). Choosing `--adapter openai` changes the file written, not who does the reasoning.
- The single outbound network path is opt-in and is a memory store rather than a model: the `willow` adapter POSTs signature atoms to a user-run Willow MCP server (default `http://localhost:8000`). Nothing else in the core opens a socket.
- Deterministic core ensures byte-stable output for CI, caching, and verification.
- Adapter rendering can evolve independently without touching core determinism.

**Consequences:**
- Zero dependency on any LLM library or API.
- Fully offline core functionality (matches zero-dep score).
- Clear separation of concerns: deterministic core vs. host-agent edge.
- Future LLM work won't affect core reproducibility.
- Users choose their own model — local or cloud — because the model lives on the other side of the artifact.

**References:**
- `packages/adapters/index.js` (`ADAPTER_NAMES`, the formatter contract)
- `packages/adapters/willow.js` (the one opt-in network path, to a local MCP store)
- `packages/cli/`, `src/mcp/server.js` (the offline surfaces that serve the core)
- `README.md` (adapter table)
- `docs/adr/0000-template.md` (template reference)