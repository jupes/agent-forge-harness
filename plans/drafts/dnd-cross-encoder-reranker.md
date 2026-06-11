# Plan — Cross-Encoder Reranker (bo4)

> **Slug**: `dnd-cross-encoder-reranker` · **Bead**: agent-forge-harness-bo4
> **Phase**: 2 (plan) · **Research**: [plans/research/dnd-cross-encoder-reranker.md](../research/dnd-cross-encoder-reranker.md)
> **Repo**: `repos/rag-chat` · **Approach**: TDD (pure gate + ordering first), demo-able, Beads-tracked.

---

## What the research settled

- **Model**: `cross-encoder/ms-marco-MiniLM-L-6-v2` (CPU, ~80MB). bge-reranker-base rejected
  (6.7× slower, no net benefit).
- **Reranking must be content-type gated.** Blanket rerank nets +10 Hit@1 queries but the gain is
  entirely in prose categories (rule +8, feat +4, dm_guidance +1); it is net-negative on structured
  content (monster −2, cross_book −1) and a wash on spell/magic_item (already MRR ≥ 0.9). The gate
  reuses amp's `extract_query_content_types` to decide.
- **Integration**: behind a `--rerank` flag in `eval_golden.py`; default path stays light.

## Open questions — resolved

1. **Gate granularity** → *category-skip*, not a tuned confidence threshold. The per-category data
   directly supports it and it needs no tuning. `SKIP_RERANK_CTYPES = {monster, spell, magic_item,
   condition, race_feature}` — skip when the query's inferred content_type is one of these (vector +
   metadata filter already nail rank-1 there); rerank otherwise (prose: rule/feat/dm_guidance, or
   unknown).
2. **top-k** → rerank **top-10** (matches the spike; some fixed hits sit at ranks 6–10). Expose
   `--rerank-topk` with a documented top-5 option for latency-sensitive use.
3. **Scope** → **eval harness only** this run (measure quality, prove the gate). Service integration
   (`88v`) is a noted follow-up, not built here.

---

## Build — 2 checkpoints + ship

### Checkpoint 1 — `rerank.py` module  *(task)*

A small module with the model wrapper + the pure gate/ordering logic.

- `should_rerank(query_content_types: set[str]) -> bool` — **pure**; False if the set intersects
  `SKIP_RERANK_CTYPES`, else True. Unit-tested across the category matrix.
- `rerank_order(scores: list[float]) -> list[int]` — **pure**; returns indices sorted by descending
  score (stable). Unit-tested.
- `CrossEncoderReranker` — lazy-loads MiniLM on first use; `rescore(query, texts) -> list[float]`.
  Not unit-tested against the real model (integration); guarded so import doesn't pull torch until
  used.
- **Tests**: `test_rerank.py` — gate truth table (monster/spell skip; rule/feat/dm_guidance/empty
  rerank), ordering correctness, stability. No torch in unit tests (inject scores).
- **Demo**: `python -c` showing `should_rerank({'monster'})==False`, `should_rerank({'rule'})==True`,
  and `rerank_order([0.1,0.9,0.5])==[1,2,0]`.

### Checkpoint 2 — `--rerank` integration + full A/B  *(task)*

- `eval_golden.py`: add `--rerank` / `--rerank-topk`. In the retrieval path, when reranking is on and
  `should_rerank(match_ctypes)` is True, fetch the top-k chunk texts, rescore with the reranker, and
  reorder before scoring. (The chunk text is already available from the retrieval rows — no extra DB
  trip; `RetrievedChunk` currently carries `text_preview`; extend the select to carry enough text, or
  fetch by id once.)
- Keep the existing metrics/stratified report; add a one-line "(reranked: N/M queries)" note.
- **Tests**: existing 29 eval unit tests stay green; gate wiring covered by `test_rerank.py`.
- **Demo**: `eval_golden.py --mode vector --rerank` over the full 171-query suite; show Hit@1/MRR
  before vs after and the per-category table. Target: Hit@1 ~82–83% (capture prose gains, no monster
  regression), confirming the gate beats blanket rerank's +10.

### Checkpoint 3 — report + ship  *(task)*

Reranker eval report (gated vs blanket vs baseline, per-category, latency) in `docs/`; PR; close bo4.

---

## Beads

bo4 is the feature. Child tasks:
- bo4.a — `rerank.py` module (gate + ordering + lazy model)  *(P3)*
- bo4.b — `--rerank` integration + full-suite A/B  *(P3, depends a)*
- bo4.c — reranker eval report + ship  *(P3, depends b)*

## Test strategy (TDD)

Pure-first: `should_rerank` truth table and `rerank_order` correctness are unit-tested with injected
scores — no torch, no DB, no network. The model wrapper and `--rerank` path are verified by the
real A/B run at the Checkpoint-2 demo. Existing 29 eval + 37 extract + 20 QA + 9 gen_golden tests
stay green.

## Risks & mitigations

- **torch dependency weight** → confined to the eval repo, lazy-imported; unit tests never load it.
- **Reranker regresses structured queries** → the content-type gate is the whole point; the A/B must
  show no monster regression, else tighten the skip set.
- **Latency** → 234ms CPU is eval-acceptable; `--rerank-topk 5` documented for the service path.
- **Gate mis-infers query type** → falls back to "rerank" on unknown (prose-biased), which is the
  safe direction (prose is where rerank helps).

## Definition of done

`rerank.py` + tests; `--rerank` flag; a full-suite A/B showing gated rerank lifts Hit@1 above the
74.7% baseline without regressing monster; reranker report; bo4 closed; PR.
