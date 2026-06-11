# Plan Review: dnd-agent-service — D&D Agent Service (POST /chat)
Source: plans/drafts/dnd-agent-service.md · Reviewed: 2026-06-08

## Verdict: NEEDS REVISION — 0 Blocker / 1 High / 0 Medium / 1 Low

The extraction plan is accurate — every function and constant it names to move into `retrieval.py`
exists, and there's no import cycle. The one real gap is the same one the bo4 review caught:
`RetrievedChunk` carries only a 120-char `text_preview`, but the service's LLM context (and the
source snippets) need the **full** chunk text. The codebase already solves this in the rerank path;
the plan must do the same for context assembly.

## Findings

### [High] Context assembly needs full chunk text, but retrieval returns only `text_preview` (120 chars) — C2 (88v.b)
**What:** C2 says "assemble the top-K chunk texts into context" and `build_context(chunks)`. But
`retrieve_top_k` returns `RetrievedChunk` whose only text field is `text_preview = left(text, 120)` —
the first 120 characters. A Fireball description is ~500 chars; a stat block 2,000+.
**Why it's an issue:** Feeding the LLM 120-char snippets would starve it of the content needed to
answer — the grounded answer would be thin or wrong, defeating the service. The `Source.snippet` would
likewise be truncated.
**Evidence:** `ingestion/eval_golden.py:172,328` (`left(text, 120) AS text_preview`), `:513`
(`text_preview: str` is the only text on `RetrievedChunk`). The rerank path **already works around
this** by fetching full text by id: `:760` `SELECT chunk_id, text FROM dnd.chunks WHERE chunk_id =
ANY(%s)` then `:762` `tmap.get(c.chunk_id, c.text_preview)`. — Confidence: Confirmed
**Suggested correction:** In `RagRetriever.retrieve`, fetch full text for the returned chunks by
`chunk_id` (one batched `SELECT chunk_id, text WHERE chunk_id = ANY(...)`, exactly as the rerank path
does) and carry it on the result, OR widen `build_vector_sql`'s select to return full `text`
alongside the preview. `build_context` and `Source.snippet` must use the full text (snippet can
truncate for display). Add this to C2's scope explicitly.

### [Low] `PRECISION_K` is eval-specific and shouldn't move to `retrieval.py` — C1 (88v.a)
**What:** C1 lists `PRECISION_K` among the constants to extract into `retrieval.py`.
**Why it's an issue:** `PRECISION_K` is the P@5 metric denominator — an eval concept, not retrieval.
Moving it muddies the module boundary (the service never needs it).
**Evidence:** `ingestion/eval_golden.py:50` (`PRECISION_K = 10`-area, used only by `compute_metrics`/
P@5 reporting). — Confidence: Confirmed
**Suggested correction:** Keep `PRECISION_K` (and `compute_metrics`, golden set, CLI) in
`eval_golden.py`. Move only `EMBED_MODEL`, `TOP_K`, and the retrieval pipeline.

## Verified as accurate (spot-checks)
- Every function the plan extracts exists — `embed_query:146`, `extract_query_entities:203`,
  `_GENERIC_ENTITY_STOPLIST:195`, `_stem:247`, `build_vector_sql:262`,
  `extract_query_content_types:376`, `needs_unfiltered_fallback:421`, `is_answerable:436`,
  `load_vocabulary:448`, `RetrievedChunk:504`, `retrieve_top_k:517`, constants `EMBED_MODEL:46`,
  `TOP_K:49`, `IPL_FALLBACK_DISTANCE:414`, `KOZ_ANSWERABLE_DISTANCE:418` ✓
- No import cycle: the moved functions depend only on each other + stdlib/psycopg/openai, not on
  eval-only code (`GOLDEN_SET`, `compute_metrics`, `gen_golden`). `eval_golden` importing from
  `retrieval` is acyclic ✓
- `rerank.py` `should_rerank` / `CrossEncoderReranker` exist for the request-time gated rerank ✓
- `is_answerable` (koz) exists and returns the refusal signal the service productizes ✓
- Only `OPENAI_API_KEY` configured; gpt-4o-mini reuses it (no new secret) ✓

## Not verified
- **FastAPI `on_event("startup")`** vs the newer `lifespan` API — both work; a deprecation nuance,
  not a plan error. Decide at implement.
- **Realized answer quality / latency** — only the C2/C3 live smoke will settle it.
- **Per-request connect vs pool** under real load — fine for v1; revisit if load grows.
