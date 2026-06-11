# Plan — D&D Agent Service (POST /chat) [88v]

> **Slug**: `dnd-agent-service` · **Bead**: agent-forge-harness-88v (epic)
> **Phase**: 2 (plan) · **Research**: [plans/research/dnd-agent-service.md](../research/dnd-agent-service.md)
> **Repo**: `repos/rag-chat` · **Approach**: TDD, demo-able checkpoints, Beads-tracked.

---

## Resolved decisions

- **LLM**: OpenAI `gpt-4o-mini` (key present). **Embeddings**: `text-embedding-3-small` (unchanged).
- **Framework**: FastAPI + `TestClient`; `uvicorn` to run.
- **Scope**: one stateless `POST /chat` → `{answer, sources[], answerable}`. No streaming/UI.
- **Shared retrieval**: extract the query→chunks pipeline into `ingestion/retrieval.py`; both the
  eval and the service import it. The eval's 80.5% Hit@1 must not move (parity gate).
- **DB connections**: per-request `psycopg.connect` for v1 (stateless, low traffic); pooling noted
  as a follow-up. Vocab + reranker loaded **once at startup**.
- **Full chunk text** *(review High)*: `RetrievedChunk` carries only `text_preview = left(text,120)`.
  The LLM context and source snippets need full text, so `RagRetriever.retrieve` fetches it by
  `chunk_id` (one batched `SELECT chunk_id, text WHERE chunk_id = ANY(...)` — the pattern already used
  by the rerank path at `eval_golden.py:760`) and carries it on the result. `build_context` uses full
  text; `Source.snippet` truncates only for display.
- **Context budget**: top-5 reranked chunks (full text) into the LLM context.
- **Refusal**: when `is_answerable` is false, return a fixed "not in my sources" answer with empty
  `sources[]` and `answerable=false` — no LLM call.

---

## Build — 4 checkpoints

### C1 — extract `ingestion/retrieval.py`, eval parity  *(feature → 88v.a)*

Move the query→chunks pipeline out of `eval_golden.py` into `retrieval.py`: `embed_query`,
`extract_query_entities` (+ `_GENERIC_ENTITY_STOPLIST`), `extract_query_content_types`,
`build_vector_sql` (+ `_stem`), `RetrievedChunk`, `retrieve_top_k`, `load_vocabulary`,
`is_answerable`, `needs_unfiltered_fallback`, and the `EMBED_MODEL` / `TOP_K` / IPL / KOZ constants.
**Keep `PRECISION_K`, `compute_metrics`, the golden set, and the CLI in `eval_golden.py`** (review
Low — they're eval-specific). Add a `RagRetriever` class that loads vocab once and exposes
`retrieve(prompt, *, rerank=False) -> RetrievalResult` (chunks **with full text** + top1_distance +
answerable). `eval_golden.py` imports from `retrieval.py` (no behaviour change).

- **Tests**: the existing pure tests move to `test_retrieval.py` (or `test_eval_golden` imports from
  the new module); all stay green.
- **Demo + parity gate**: re-run `eval_golden.py --mode vector` → **Hit@1 80.5% must hold**. If it
  moves, the extraction changed behaviour — stop and fix.

### C2 — generation + `RagService`  *(feature → 88v.b)*

- `service/models.py` — pydantic `ChatRequest{prompt: str}`, `Source{book, chapter, section, entity,
  page, snippet}`, `ChatResponse{answer, sources, answerable}`.
- `service/generate.py` — `build_context(chunks) -> str` (numbered source blocks, **full chunk
  text** per the review); `GROUNDED_PROMPT` (answer only from context, cite by source number, say so
  if not covered); `generate_answer(prompt, context) -> str` calling gpt-4o-mini.
- `service/rag.py` — `RagService.answer(prompt) -> ChatResponse`: retrieve (gated rerank, full text
  fetched by chunk_id) → if not answerable, refusal response (no LLM) → else build context from
  top-5 full texts, generate, assemble `sources[]` from chunk metadata (deduped by book+entity/
  section; `snippet` truncated for display only).
- **Tests**: `build_context` and source assembly are pure (unit-tested); `generate_answer` and
  `RagService.answer` tested with **mocked** retrieval + LLM (deterministic, no network). Refusal
  path tested (answerable=false → no LLM call, empty sources).
- **Demo**: `RagService.answer("What is the range of Fireball?")` (live, opt-in) → grounded answer +
  Fireball source; and an out-of-corpus prompt → refusal.

### C3 — FastAPI app + endpoint tests  *(feature → 88v.c)*

- `service/app.py` — FastAPI app; `@app.on_event("startup")` loads vocab + reranker into a single
  `RagService`; `POST /chat` validates `ChatRequest`, calls `RagService.answer`, returns
  `ChatResponse`; typed errors (empty prompt → 422; downstream failure → 503). Stateless.
- **Tests**: `TestClient` with a mocked `RagService` — happy path, refusal path, empty-prompt 422,
  response schema. No DB/LLM in these tests.
- **Demo**: `uvicorn service.app:app` + `curl POST /chat` with a covered prompt (grounded + sources)
  and an out-of-corpus prompt (refusal).

### C4 — service docs + ship  *(task → 88v.d)*

`service/README.md` (run, env, endpoint contract, curl examples) + a short ship report; PR; close
88v's children and the epic.

---

## Beads

Epic **88v** (exists). Child features:

- 88v.a — extract `retrieval.py` + eval parity  *(P2)*
- 88v.b — generation + `RagService`  *(P2, depends a)*
- 88v.c — FastAPI app + endpoint tests  *(P2, depends b)*
- 88v.d — service docs + ship  *(P2, depends c)*

`c7v` (ingestion epic) is satisfied in practice (corpus live); note on 88v.

## Test strategy (TDD)

- **Pure-first**: `build_context`, source assembly, and the already-tested retrieval primitives —
  unit-tested with no DB/LLM/network.
- **Mocked integration**: `RagService.answer` and the `/chat` endpoint with injected fake
  retriever + LLM (deterministic).
- **Parity gate**: the 179-q eval after C1 must read 80.5% Hit@1.
- **One opt-in live smoke** (env-gated): real retrieve + gpt-4o-mini on "range of Fireball".
- Existing 124 unit tests stay green.

## Risks & mitigations

- **Refactor regresses the eval** → C1 parity gate (re-run, must hold) before building on top.
- **Hallucination** → grounded prompt + answerability gate; `sources[]` always real chunks.
- **Latency** (embed + rerank + LLM, ~0.5–1s) → acceptable for v1 JSON; top-5 rerank caps it.
- **Secrets** → reuse the `.env` loader; never commit keys; `.env` already gitignored.
- **Dep weight** (fastapi/uvicorn/openai/sentence-transformers) → declared for the service; unit
  tests mock them so CI stays light.

## Definition of done

`POST /chat` returns a grounded answer + populated `sources[]` for a covered prompt, refuses an
out-of-corpus prompt (`answerable=false`), is stateless, and is covered by endpoint + unit tests;
the eval still reads 80.5%; service README + ship report; 88v epic + children closed; PR.
