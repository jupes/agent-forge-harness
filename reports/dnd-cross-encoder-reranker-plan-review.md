# Plan Review: dnd-cross-encoder-reranker — Cross-Encoder Reranker (bo4)
Source: plans/drafts/dnd-cross-encoder-reranker.md · Reviewed: 2026-06-08

## Verdict: NEEDS REVISION — 0 Blocker / 1 High / 1 Medium / 0 Low

The design is sound and well-grounded in the research spike, but Checkpoint 2 rests on one false
premise about data availability: full chunk text is **not** in the retrieval rows, only a 120-char
preview — and the spike's +6 Hit@1 was measured on *full* text. Implemented as the plan's "already
available — no extra DB trip" sentence reads, the reranker would score 120-char snippets and
underperform the spike. The fix is small (the plan even names it) but must be made explicit.

## Findings

### [High] Full chunk text is not available in the retrieval path — Checkpoint 2
**What:** The plan says "The chunk text is already available from the retrieval rows — no extra DB
trip." It is not. `RetrievedChunk` carries only `text_preview`, and both vector SQL templates select
`left(text, 120) AS text_preview` — the first 120 characters.
**Why it's an issue:** The research spike reranked on **full** chunk text (`SELECT … text …`,
`CrossEncoder(max_length=512)`) and that is where the +6 Hit@1 / net +10 came from. A cross-encoder
scoring a 120-char snippet of a stat block or rule passage loses most of the signal — the eval A/B
would not reproduce the spike and could even look like the reranker doesn't help. This is the result
the whole feature is judged on.
**Evidence:** `ingestion/eval_golden.py:436` (`text_preview: str` is the only text field on
RetrievedChunk), `:152` and `:288` (`left(text, 120) AS text_preview`); vs spike
`ingestion/spike_rerank.py:54` (`SELECT chunk_id, text`) and `:61` (`max_length=512`). — Confidence:
Confirmed
**Suggested correction:** In bo4.b, fetch full text for the top-k chunk_ids once (a single
`SELECT chunk_id, text FROM dnd.chunks WHERE chunk_id = ANY(...)`, exactly as the spike does) before
reranking, OR widen the select to return more text. Do not rerank on `text_preview`. Drop the "no
extra DB trip" claim — one extra batched fetch per reranked query is the correct, cheap approach.

### [Medium] The gate keys on query-inferred content_type, but the spike's per-category projection keyed on the golden label — heading "What the research settled" / Checkpoint 1
**What:** The plan projects the gated benefit (+13) from the spike's per-category table, which was
bucketed by each query's **golden `category`** label. The runtime gate, however, decides via
`should_rerank(match_ctypes)` where `match_ctypes = extract_query_content_types(query, …)` — the
content_type **inferred from the query string**, not the golden label.
**Why it's an issue:** Inferred ctype and golden category are correlated but not identical. A monster
query like "What is the armor class of Basilisk?" infers `{monster}` (entity→ctype) and is correctly
skipped; but a rule/feat query that happens to name no known entity infers `{}` (empty) and is
reranked — which is the intended prose-biased fallback, fine. The risk is the realized per-category
gate behavior drifting from the spike's projection (e.g. a monster query whose name isn't in the
vocab infers empty → gets reranked → possible regression). The +13 is a projection, not a guarantee.
**Evidence:** gate input `ingestion/eval_golden.py:610` (`match_ctypes = extract_query_content_types(...)`)
returns `set[str]` (`:336-340`); the spike bucketed by `r.get("category")`
(`ingestion/spike_rerank.py`, per-category `by_cat` keyed on the golden category). — Confidence:
Confirmed
**Suggested correction:** Keep the category-skip gate (it's the right call), but in the bo4.b A/B
**measure the realized per-category fixed/broke** (not just the headline) and confirm no monster
regression empirically. If monster queries with out-of-vocab names leak through, add those names to
the skip logic or fall back to skipping when the retrieved rank-1 is already a monster chunk.

## Verified as accurate (spot-checks)
- `extract_query_content_types` returns `set[str]` — matches `should_rerank(query_content_types: set[str])`
  — `ingestion/eval_golden.py:336-340` ✓
- `match_ctypes` is computed in `main()` before retrieval, so the gate has its input —
  `eval_golden.py:610` ✓
- Model choice + latency + the +6/net+10 effect — reproduced live in the spike (MiniLM 234ms;
  bge rejected) ✓
- 29 eval unit tests exist and pass (regression baseline) ✓
- Content-type values the gate skips (monster/spell/magic_item) are real `content_type`s in the
  corpus ✓

## Not verified
- **Realized gated Hit@1 (~82–83% projection)** — only the bo4.b A/B over the full 171-query suite
  will settle it; depends on the High fix (full text) and the Medium (inferred-vs-label gate).
- **Service-path latency** — out of scope this run (eval-only).
