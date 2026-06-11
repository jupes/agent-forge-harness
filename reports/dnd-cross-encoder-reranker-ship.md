# Ship Report — Cross-Encoder Reranker (bo4)

> **Slug**: `dnd-cross-encoder-reranker` · **Bead**: agent-forge-harness-bo4
> **Date**: 2026-06-08 · **Repo**: `repos/rag-chat` (pushed to `master`)
> **Pipeline**: Forge full (research → plan → review → implement → ship)

---

## What shipped

A **content-type-gated cross-encoder reranker** for the D&D RAG eval harness. It lifts
**Hit@1 74.7% → 79.5%** and **MRR 0.808 → 0.839** on the 12-book / 8,851-chunk corpus with
**zero regressions**, by reranking only prose-category queries and skipping structured ones.

This closes the loop opened by the corpus expansion: that run's Recall@10 91% vs Hit@1 74.7% gap was
the documented trigger to reopen bo4, and this run delivered the fix the data called for.

### Checkpoints (TDD, demo-verified)

| # | Task | Bead | Commit |
|---|------|------|--------|
| bo4.a | `rerank.py` — gate + ordering + lazy MiniLM | 0qx | (rerank module) |
| bo4.b | `--rerank` integration + full A/B | zzm | (eval integration) |
| bo4.c | reranker eval report + ship | l0y | (this) |

---

## Before / after

| metric | baseline | gated rerank |
|--------|----------|--------------|
| Hit@1 | 74.7% | **79.5%** |
| MRR | 0.808 | **0.839** |
| regressions | — | **0** (8 fixed, 0 broke) |
| queries reranked | — | 77/166 (prose only) |

rule category 70% → 82%; monster correctly untouched (skipped by the gate).

---

## How to verify it yourself

```bash
cd repos/rag-chat && docker compose up -d
# Unit tests (no torch/DB) — 105 total across the suite; reranker:
uv run python ingestion/test_rerank.py                    # 10/10

# A/B: baseline vs gated rerank over the 171-query suite
PYTHONIOENCODING=utf-8 uv run --with "psycopg[binary]" --with openai \
    python ingestion/eval_golden.py --mode vector                       # Hit@1 74.7%
PYTHONIOENCODING=utf-8 uv run --with "psycopg[binary]" --with openai --with sentence-transformers \
    python ingestion/eval_golden.py --mode vector --rerank              # Hit@1 79.5%, fixed 8 broke 0
```

Report: `repos/rag-chat/docs/dnd-reranker-eval-2026-06-08.md`.

---

## Decisions / deviations (folded-in review fixes)

1. **Gated, not blanket** (research) — blanket scores 1.2pt higher but breaks 6 queries; gated breaks
   zero. "Never worse" was chosen over "higher average."
2. **Full-text fetch** (plan-review High) — `RetrievedChunk` carries only a 120-char preview; the
   reranker fetches full chunk text by id (one batched query), matching the spike. Reranking the
   preview would not reproduce the gains.
3. **Per-category fixed/broke measured** (plan-review Medium) — the gate keys on inferred ctype, so
   the realized effect (+8) is measured, not assumed from the spike's golden-category projection
   (+13).
4. **MiniLM over bge** (research) — bge 6.7× slower, no benefit.

---

## Beads

**Closed**: bo4.a (0qx), bo4.b (zzm), bo4.c (l0y), and **bo4** itself.
**Follow-ups**: `88v` (wire gated reranker into the chat service with top-5), `qg4` (OCR cleanup —
the real lever for the monster category the reranker skips).

## Quality gates

105/105 unit tests green (10 rerank + 37 extract + 20 QA + 9 gen_golden + 29 eval). rag-chat pushed
to `master` (`b90804f..5c2ae66`). torch lazy-loaded; no secrets committed.
