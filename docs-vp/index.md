---
layout: home
title: SigMap — the deterministic, verifiable grounding layer for AI code work
description: SigMap builds a deterministic, auditable signature-and-evidence map that AI agents, CI, and reviewers can trust and verify. Zero dependencies, no embeddings, fully offline. Proof — 78.6% hit@5, 43.4% fewer prompts, 95.8% average token reduction, 36 languages with R support.
head:
  - - meta
    - property: og:title
      content: "SigMap — the deterministic, verifiable grounding layer for AI code work"
  - - meta
    - property: og:description
      content: "A reproducible signature-and-evidence map agents and CI can audit. Proof — 78.6% hit@5, 43.4% fewer prompts, 95.8% overall token reduction."
  - - meta
    - property: og:url
      content: "https://sigmap.io/"
  - - meta
    - property: og:type
      content: website
  - - meta
    - name: twitter:title
      content: "SigMap — the deterministic, verifiable grounding layer for AI code work"
  - - meta
    - name: twitter:description
      content: "A reproducible signature-and-evidence map agents and CI can audit. Proof — 78.6% hit@5, 43.4% fewer prompts, 95.8% overall token reduction."
  - - meta
    - name: twitter:image:alt
      content: "SigMap — the deterministic, verifiable grounding layer for AI code work"
  - - meta
    - name: keywords
      content: "sigmap, ai grounding layer, ai code grounding, deterministic context, evidence pack, grounded ai answers, code retrieval, mcp, sigmap ask, sigmap judge"

hero:
  name: SigMap
  text: Grounded context AI can trust. Deterministic. Verifiable.
  tagline: "The deterministic, verifiable grounding layer for AI code work. Proof — 78.6% hit@5 · 95.8% token reduction · zero deps, fully offline."
  actions:
    - theme: brand
      text: Get Started →
      link: /guide/quick-start
    - theme: alt
      text: Benchmark Report →
      link: /guide/benchmark
    - theme: alt
      text: GitHub
      link: https://github.com/manojmallick/sigmap

features:
  - icon: 💬
    title: Fewer prompts to finish the task
    details: "Latest saved run: 2.84 prompts without SigMap vs 1.61 with SigMap. That is a 43.4% reduction across 105 real coding tasks."
    link: /guide/task-benchmark
    linkText: Task benchmark →
  - icon: 🎯
    title: Right file in context
    details: 78.6% hit@5 across 18 repos and 105 tasks. On the 125-task honest corpus SigMap scores 86.4% where a single-shot grep agent finds the right file 40.8% of the time — a measured 2.12× better.
    link: /guide/retrieval-benchmark
    linkText: Retrieval benchmark →
  - icon: ⚖️
    title: Trust the answer, not just the token count
    details: Use ask to build focused context, validate to check coverage, judge to score groundedness, and learn to reinforce the files that helped.
    link: /guide/judge
    linkText: Workflow docs →
  - icon: 🌐
    title: 36 languages, zero native deps
    details: TypeScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP, Swift, C#, C++, Dart, Scala, Vue, Svelte, GraphQL, SQL, Terraform, R, GDScript, and more.
    link: /guide/languages
    linkText: Language support →
  - icon: 🔌
    title: MCP-ready and IDE-friendly
    details: Works with Copilot, Claude Code, Cursor, Windsurf, Codex, OpenCode, and Gemini CLI. Use MCP for dynamic query_context lookups on demand.
    link: /guide/mcp
    linkText: MCP setup →
  - icon: 📈
    title: One report for the full story
    details: Run the benchmark matrix once and open a self-contained HTML dashboard with token, retrieval, quality, and task metrics together.
    link: /guide/benchmark
    linkText: Benchmark overview →
---

<div style="max-width:840px;margin:0 auto;padding:18px 24px 0;text-align:center">
<div style="display:inline-flex;flex-wrap:wrap;gap:.5rem;justify-content:center;background:var(--vp-c-brand-soft,#ede9fe);border:1px solid rgba(124,106,247,.25);border-radius:999px;padding:.55rem .9rem;font-size:.9rem;color:var(--vp-c-text-1)">
  <span><strong>Release:</strong> v8.54.0</span>
  <span>·</span>
  <span><strong>New — the judge was scoring English:</strong> <code>sigmap judge</code> was the last grounding surface whose <em>verdict</em> rested on raw word-overlap. An answer whose every claim was grounded <strong>failed at 0.212</strong> simply for containing ordinary prose, and <code>buildEvidencePack</code> scored <strong>0.750</strong> where <code>build evidence pack</code> — the same fact — scored <strong>0.333</strong>. The judge now shares the ranker's tokenizer and drops ordinary-English vocabulary from both sides: the prose case passes at <strong>0.643</strong>, and both identifier forms score identically. Hedging phrases like <em>&quot;typically,&quot;</em> used to fail a grounded answer with exit 1 <em>at high confidence</em> — they are now <strong>warnings</strong> that never flip a verdict. &quot;Nothing to judge&quot; got its own <code>inconclusive</code> verdict and exit code, so CI can tell a truncated model output from a wrong one. And <code>judge</code> finally reads <strong>stdin</strong>, defaults its own <code>--context</code>, warns when that context is <strong>older than the sources it describes</strong>, and prints the per-claim table it previously hid in <code>--json</code>. 36 languages, zero dependencies, offline, deterministic.</span>
</div>
<div style="margin-top:.4rem;display:inline-flex;flex-wrap:wrap;gap:.5rem;justify-content:center;background:var(--vp-c-default-soft,#f3f4f6);border:1px solid rgba(0,0,0,.08);border-radius:999px;padding:.55rem .9rem;font-size:.9rem;color:var(--vp-c-text-2)">
  <span><strong>Benchmark:</strong> sigmap-v8.54-main</span>
  <span>·</span>
  <span>78.6% hit@5 · 95.8% token reduction · 2026-09-30</span>
</div>
</div>

<div style="max-width:840px;margin:0 auto;padding:24px">

## Who is this for?

| I am… | Go to |
|---|---|
| New to SigMap | [Quick start](/guide/quick-start) |
| Using it daily | [ask](/guide/ask) · [validate](/guide/validate) · [judge](/guide/judge) |
| Setting up a team / CI | [Config](/guide/config) · [Strategies](/guide/strategies) |
| Using open-source agents (OpenCode, Aider, Cline) | [Open-source agents guide](/guide/agents) |
| Running local LLMs (Ollama, llama.cpp, vLLM) | [Local LLMs guide](/guide/local-llms) — zero cost, full privacy |
| Integrating with MCP, Claude, or Cursor | [MCP setup](/guide/mcp) |
| Evaluating for a monorepo | [Strategies](/guide/strategies) · [Generalization](/guide/generalization) |
| Comparing against embeddings or RAG | [Compare alternatives](/guide/compare-alternatives) |

</div>

<div style="max-width:840px;margin:0 auto;padding:0 24px 8px">

## 30-second start

**Step 1: Generate context for your project**
```bash
npx sigmap
```

**Step 2: Ask for relevant files (query-specific context)**
```bash
sigmap ask "explain the auth flow"
# Outputs: ranked file list + .context/query-context.md (ready to paste)
```

**Step 3: Copy context to your AI assistant**
- Open `.context/query-context.md` 
- Paste the content into Claude, Copilot, ChatGPT, or your IDE's AI chat
- Ask: "Explain the auth flow"

**Step 4: Save the AI response**
```bash
# Copy the AI's answer into a file
echo "Paste AI response here..." > response.txt
```

**Step 5: Validate coverage (optional)**
```bash
sigmap validate --query "auth login token"
# Check if coverage is high enough to trust the response
```

**Step 6: Judge groundedness**
```bash
sigmap judge --response response.txt --context .context/query-context.md
# Score: shows if the answer is grounded in your code
```

That flow gives you: a compact signature map · a focused query context · a coverage sanity check · a groundedness score for the answer.

</div>

<div style="max-width:840px;margin:0 auto;padding:0 24px 8px">

## The workflow

SigMap is no longer just "shrink the context file." Every step has a purpose:

- **Generate** a compact signature map once
- **Ask** for the files that matter to the current task
- **Validate** whether coverage is high enough to trust the context
- **Judge** whether an answer is grounded in the supplied code
- **Learn** from good and bad results locally, inside the repo

See the full [end-to-end walkthrough](/guide/walkthrough) to watch this in action on a real repo.

</div>

<div style="max-width:840px;margin:0 auto;padding:0 24px 24px">

## Latest saved benchmark snapshot

| Metric | Without SigMap | With SigMap |
|---|:---:|:---:|
| Task success proxy | — (proxy, modeled from retrieval tiers) | **61.0%** |
| Prompts per task | 2.84 | **1.61** |
| Retrieval hit@5 (retrieval corpus) | — | **78.6%** |
| Honest corpus hit@5 (125 tasks) | 40.8% (single-shot grep) | **86.4%** (2.12× lift) |
| Overall token reduction | — | **95.8%** |
| GPT-4o overflow repos | 14/21 | **0/21** |

Latest saved benchmark run: **2026-09-30 (v8.54.0)**.

</div>

<div style="max-width:840px;margin:0 auto;padding:0 24px 24px">

## Benchmark proof, by question

| If you want to prove... | Open |
|---|---|
| SigMap reduces token load dramatically | [Token benchmark](/guide/benchmark) |
| SigMap finds the right file more often | [Retrieval benchmark](/guide/retrieval-benchmark) |
| SigMap reduces retries and wrong-context answers | [Task benchmark](/guide/task-benchmark) |
| SigMap keeps large repos inside model limits | [Quality benchmark](/guide/quality-benchmark) |

</div>

<div style="max-width:840px;margin:0 auto;padding:0 24px 32px">

## Where to go next

- New to the product: [Quick start](/guide/quick-start)
- Want the core daily flow: [ask](/guide/ask), [validate](/guide/validate), [judge](/guide/judge), [learning](/guide/learning)
- Using Claude Code or Cursor: [MCP setup](/guide/mcp)
- Evaluating the launch claims: [Benchmark overview](/guide/benchmark)
- 🌍 See the community: [where SigMap's stargazers are around the world](https://starmapper.bruniaux.com/manojmallick/sigmap)

</div>
