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

This directory contains ADRs for major design choices in SigMap. Each ADR records a deliberate, defensible, often counter-consensus decision so that evaluators and future maintainers can understand *why* the project is built this way.

## Index

- [ADR 0001 – BM25 over Embeddings](./0001-bm25-over-embeddings.md)
- *(more ADRs to be added: Tree-sitter rejection, LLM-edge separation, blast-radius formula, centrality flag-gating)*

## Template

Use [ADR 0000 – Template](./0000-template.md) for new decisions.