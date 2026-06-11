# Research — Cross-Encoder Reranker (bo4)

> **Slug**: `dnd-cross-encoder-reranker` · **Bead**: agent-forge-harness-bo4
> **Date**: 2026-06-08 · **Phase**: 1 (research spike) · **Repo**: `repos/rag-chat`
> **Trigger**: 12-book corpus eval shows Recall@10 91.0% vs Hit@1 74.7% — a ranking gap.

---

## Question

bo4 was superseded twice ("metadata filtering already solves ranking") and reopened when the
8,851-chunk corpus produced a real Recall@10 ≫ Hit@1 gap. Before building, the spike answers
empirically: **does a CPU cross-encoder actually lift Hit@1/MRR by reranking the top-10, at
acceptable latency — and which model?**

## Method

Reused the stored `eval_results.json` (each positive query's top-10 chunk_ids + is_hit labels),
fetched chunk text from the DB, reranked the top-10 with a cross-encoder, and recomputed Hit@1/MRR on
the reranked order. No re-embedding, no OpenAI calls — isolates the reranker's effect on
already-retrieved candidates. Script: `ingestion/spike_rerank.py`. 166 positive queries; 27 of the 42
misses have the hit somewhere in the top-10 (the reranker-addressable set).

## Findings

### 1. The reranker helps — modestly but really

`cross-encoder/ms-marco-MiniLM-L-6-v2` (~80MB, CPU):

| metric | baseline | reranked |
|--------|----------|----------|
| Hit@1 | 74.7% | **80.7%** (+6.0pts) |
| MRR | 0.808 | **0.844** |
| net queries | — | **+10** (16 fixed, 6 broke) |

It captures 16 of 27 addressable misses and breaks 6 previously-correct queries.

### 2. Model choice matters enormously — MiniLM ≫ bge

| model | Hit@1 | net | latency p50 |
|-------|-------|-----|-------------|
| ms-marco-MiniLM-L-6-v2 | 80.7% | +10 | **234ms** |
| BAAI/bge-reranker-base | 75.3% | +1 (19 fixed / 18 broke = noise) | **1578ms** |

bge is 6.7× slower and barely better than baseline — it reorders aggressively without net benefit.
**MiniLM-L-6 is the clear choice.**

### 3. The effect is category-dependent — this is the key design signal

| category | fixed/broke | net |
|----------|-------------|-----|
| rule | 8/0 | **+8** |
| feat | 4/0 | **+4** |
| dm_guidance | 1/0 | +1 |
| spell_lookup | 2/2 | 0 |
| cross_book | 0/1 | −1 |
| monster | 1/3 | **−2** |

The reranker **helps prose-heavy categories** (rule, feat — where bi-encoder cosine is fuzzy over long
natural-language passages) and **hurts structured content** (monster stat blocks — terse, numeric
"Armor Class 17 / Hit Points 52 / STR 16" text that a CE trained on web prose mis-scores). Blanket
reranking nets +10; a content-type-gated reranker that skips structured categories could net the +13
from prose alone while dropping the −3.

### 4. Latency

234ms p50 / 344ms p95 per query on CPU for 10 pairs. Fine for offline eval; **borderline for a live
chat service** (adds a quarter-second). A GPU or a smaller top-k (rerank top-5 not top-10) would cut
it. Model loads in ~4–8s (one-time, lazy).

## Decision: build it, gated, with MiniLM

The reranker is worth building — but **not as a blanket reorder**. The design that the data supports:

- Model: `cross-encoder/ms-marco-MiniLM-L-6-v2`, lazy-loaded, CPU.
- **Content-type gate**: only rerank when the query's inferred content_type (amp already computes
  this) is prose-like (rule / feat / dm_guidance / unknown); skip for monster/spell/magic_item where
  the metadata filter + vector already nail rank-1 (MRR ≥ 0.9) and the CE only adds noise.
- Behind a `--rerank` flag in `eval_golden.py` so the default path stays light and the A/B is
  reproducible.
- Optional: rerank only the top-5 to halve latency.

Expected: Hit@1 ~82–83% (capture rule+feat+dm_guidance gains, avoid monster regressions) at ~120ms
(top-5) on the gated subset.

## Open questions for the plan

- **Gate granularity**: skip-by-category (simple, uses amp's inference) vs a confidence threshold on
  the CE score (more general but needs tuning). Recommend category-skip first — it's directly
  supported by the per-category data.
- **Live-service latency**: is the reranker for the eval harness only (measure quality), or also the
  future agent service (`88v`)? If the latter, top-5 + the gate, and consider GPU.
- **Dependency weight**: `sentence-transformers` pulls torch (~big). Acceptable for the eval repo;
  for the service, weigh a lighter ONNX-runtime cross-encoder.

## Files
- `repos/rag-chat/ingestion/spike_rerank.py` — the reproducible spike (this research).
- `repos/rag-chat/ingestion/eval_golden.py` — `--rerank` integration (plan).
- `repos/rag-chat/ingestion/rerank.py` — **new** reranker module (plan).
