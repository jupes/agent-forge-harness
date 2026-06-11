# Research — D&D Agent Service (POST /chat) [bo 88v]

> **Slug**: `dnd-agent-service` · **Bead**: agent-forge-harness-88v (epic)
> **Date**: 2026-06-08 · **Phase**: 1 (research) · **Repo**: `repos/rag-chat`
> **Goal**: a **stateless** `POST /chat` that embeds a prompt, retrieves with the
> filtered+gated+reranked pipeline we built, calls an LLM, and returns a grounded
> answer with source citations.

---

## Current state (what exists)

- **Retrieval primitives all exist — but trapped in `ingestion/eval_golden.py`** (a CLI eval
  script): `embed_query`, `extract_query_entities` (+ generic-entity stoplist), `extract_query_content_types`,
  `build_vector_sql` (class/entity ILIKE + content_type, stemmed), `retrieve_top_k`, `load_vocabulary`,
  `is_answerable` (koz gate), and the rerank wiring. `rerank.py` exposes `should_rerank` +
  `CrossEncoderReranker`.
- **No generation code** anywhere (no chat/completions). Only `OPENAI_API_KEY` is configured
  (embeddings). The corpus is **live**: 9,048 chunks across 12 books in `dnd.chunks`.
- Retrieval quality (179-query eval): **Hit@1 80.5%, MRR 0.854, Recall@10 92%** with the gated
  reranker available; `is_answerable` refuses 5/5 out-of-corpus negatives at 0.50 cosine.
- `plan.md` describes an aspirational GCP/hosted-vector vision; reality is **local Docker pgvector**.
  v1 targets the real local stack behind the same retrieval functions.

## Decisions (this phase)

1. **Generation LLM → OpenAI `gpt-4o-mini`** *(user)*. `OPENAI_API_KEY` already present → no new
   secrets, single provider. Embeddings stay `text-embedding-3-small`.
2. **v1 scope → minimal `POST /chat`** *(user)*: JSON, non-streaming, stateless. One endpoint:
   `{prompt} → retrieve+rerank+gate → LLM → {answer, sources[], answerable}`. Streaming and a raw
   `/search` are deferred to the UI epic (3zs).
3. **Framework → FastAPI** *(research)*: the standard for a typed Python stateless JSON API; ships
   with `TestClient` for endpoint tests and OpenAPI docs for free.
4. **Refactor retrieval into a shared module** *(research)*: extract the query→chunks pipeline from
   `eval_golden.py` into `ingestion/retrieval.py` (or `service/retrieval.py`). Both the eval and the
   service import it. Coupling the service to an eval CLI would be wrong; this is a prerequisite,
   kept behaviour-preserving (the eval's numbers must not move).

## Proposed shape

```
service/
  app.py          # FastAPI app, POST /chat, startup loads vocab + reranker
  rag.py          # RagService: retrieve(prompt) -> (chunks, answerable) using the shared retrieval
  generate.py     # build_context(chunks) + call gpt-4o-mini -> answer; grounded prompt template
  models.py       # pydantic: ChatRequest{prompt}, ChatResponse{answer, sources[], answerable}
  test_*.py       # TestClient + mocked retrieval/LLM; one real grounded check (opt-in)
ingestion/retrieval.py   # extracted shared pipeline (embed→filter→retrieve→rerank→gate)
```

**Flow** (stateless per request): embed prompt → `extract_query_entities`/`content_types` (vocab
loaded once at startup) → `retrieve_top_k` (filtered vector) → optional gated rerank → `is_answerable`
on top-1 distance. If not answerable → return `{answer: "I couldn't find that in the D&D sources I
have.", sources: [], answerable: false}` (the koz gate, productized). Else assemble the top-K chunk
texts into a grounded context, call gpt-4o-mini with a "answer only from the context, cite sources"
prompt, return the answer + `sources[]` derived from chunk metadata (`book_slug`, `chapter`,
`section`, `entity_name`, `page_start`).

**Citations**: one per contributing chunk, deduped by (book_slug, entity_name/section), carrying a
short snippet. The LLM is instructed to grant the answer only from the provided context.

## Open questions for the plan

- **Retrieval extraction boundary**: which functions move to `retrieval.py` vs stay in `eval_golden`
  (embed/vocab/filters/retrieve/rerank/gate move; metric/golden/CLI stay). Keep a `RagRetriever`
  class that loads vocab + reranker once and exposes `retrieve(prompt) -> RetrievalResult`.
- **DB connection management**: per-request connect vs a small pool. For a stateless v1, a pool
  (psycopg_pool) is cleaner; a per-request connect is simpler. Decide in plan.
- **Context budget**: how many chunks into the LLM context (top-5 reranked?), truncation, token cap.
- **Prompt template**: grounding instructions + citation format + refusal behaviour for thin context.
- **Reranker at request time**: 234ms CPU latency — acceptable for v1 JSON; gate by query type
  (reuse `should_rerank`). Lazy-load the model at startup.
- **Config/secrets**: reuse the repo `.env` loader pattern; `OPENAI_API_KEY`, `DATABASE_URL`.
- **Testing**: endpoint tests with mocked retrieval + LLM (deterministic); one opt-in live
  smoke test ("What is the range of Fireball?" → grounded + sources). No DB/LLM in unit tests.
- **Error handling**: empty prompt, DB down, LLM error → typed error responses.

## Risks

- **Refactor regresses the eval** → keep `retrieval.py` behaviour-identical; re-run the 179-q eval
  after extraction and confirm 80.5% holds before building the service on top.
- **Latency** (embed + rerank + LLM) → fine for v1 JSON; note it, optimise later (top-5 rerank).
- **Hallucination** → grounded prompt + the answerability gate; sources always reflect real chunks.

## Files
- new: `service/app.py`, `service/rag.py`, `service/generate.py`, `service/models.py`, `service/test_*.py`
- new: `ingestion/retrieval.py` (extracted shared pipeline)
- edit: `ingestion/eval_golden.py` (import from `retrieval.py`)
- new: `service/requirements` or pyproject extra (fastapi, uvicorn, openai, psycopg, sentence-transformers)
