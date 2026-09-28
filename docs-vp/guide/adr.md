---
title: Architecture Decision Records
description: Architecture Decision Records for SigMap — the reasoning behind key design choices.
head:
  - - meta
    - property: og:title
      content: "Architecture Decision Records — SigMap"
  - - meta
    - property: og:description
      content: "The reasoning behind SigMap's key design choices: BM25 over embeddings, no Tree-sitter, no LLM in the core, blast-radius formula, and centrality flag-gating."
---

# Architecture Decision Records

These ADRs record SigMap's major design choices. Each one captures a deliberate, defensible, often counter-consensus decision so that evaluators and future maintainers can understand *why* the project is built this way.

The canonical copies are the markdown files under `docs/adr/` in the repository. This page embeds those files directly at build time, so the site never carries a second copy that can drift away from the record it documents.

<!--@include: ../../docs/adr/0001-bm25-over-embeddings.md-->

<!--@include: ../../docs/adr/0002-tree-sitter-cut.md-->

<!--@include: ../../docs/adr/0003-llm-core-separation.md-->

<!--@include: ../../docs/adr/0004-blast-radius.md-->

<!--@include: ../../docs/adr/0005-centrality-flag-gating.md-->

## Recording a new decision

Copy `docs/adr/0000-template.md`, add the new file to this page's includes, and link it from `docs/adr/README.md`.

<!--@include: ../../docs/adr/0000-template.md-->