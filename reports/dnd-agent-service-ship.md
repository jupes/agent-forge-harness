# Ship Report — D&D Agent Service (POST /chat) [88v]

> **Slug**: `dnd-agent-service` · **Epic**: agent-forge-harness-88v (+ 5bm/7ro/a87/bmr)
> **Date**: 2026-06-08 · **Repo**: `repos/rag-chat` (pushed to `master`)
> **Pipeline**: Forge full (research → plan → review → implement → ship)

---

## What shipped

A **stateless `POST /chat`** agent service over the D&D corpus: embed → filtered+gated retrieval →
grounded `gpt-4o-mini` answer → response with source citations, refusing out-of-corpus questions
instead of hallucinating. Every acceptance criterion on the bead is met.

### Checkpoints

| # | Checkpoint | Bead | Commit |
|---|-----------|------|--------|
| C1 | extract shared `ingestion/retrieval.py` | 5bm | (refactor) |
| C2 | generation + `RagService` (gpt-4o-mini) | 7ro | (service core) |
| C3 | FastAPI app + endpoint tests | a87 | (app) |
| C4 | README + ship | bmr | (this) |

### Architecture

```
POST /chat → RagService.answer(prompt):
  embed → detect class/entity/ctype (stoplist) → filtered vector retrieve
        → fetch FULL chunk text by id → is_answerable gate
        → [refuse]  or  build_context(top-5) → gpt-4o-mini → cite sources
```

`ingestion/retrieval.py` (`RagRetriever`, extracted from the eval CLI) is the shared retrieval core;
`service/` holds the API (`app.py`), orchestration (`rag.py`), generation (`generate.py`), and
models (`models.py`).

---

## Demo (live, real DB + LLM)

`POST /chat {"prompt": "What does a Mind Flayer do with its tentacles?"}` →

> A Mind Flayer uses its tentacles to make a melee weapon attack, dealing 15 (2d10 + 4) psychic
> damage. If the target is Medium or smaller, it is grappled (escape DC 15) and must succeed on a
> DC 15 Intelligence saving throw or be stunned until the grapple ends **[1]**.

`sources`: mm-5e *Mind Flayer* (p.223) + vgm-5e *Mind Flayer Thralls* / *Roleplaying a Mind Flayer*.

`{"prompt": "What is the stock price of Apple?"}` → `{answer: "I couldn't find that in the D&D 5e
sources I have.", sources: [], answerable: false}`. Empty prompt → `422`.

## How to verify

```bash
cd repos/rag-chat && docker compose up -d
# unit + endpoint tests (no DB/LLM):
uv run --with pydantic --with "psycopg[binary]" python -m service.test_service   # 6/6
uv run --with fastapi --with pydantic --with httpx python -m service.test_app     # 6/6
# live:
uv run --with fastapi --with uvicorn --with openai --with "psycopg[binary]" \
    uvicorn service.app:app --port 8000
curl -s -X POST localhost:8000/chat -H 'Content-Type: application/json' \
    -d '{"prompt":"How does the Shield spell work?"}'
```

## Decisions / deviations

- **gpt-4o-mini** generation (key already present); embeddings stay `text-embedding-3-small`.
- **Shared `retrieval.py`** extracted from `eval_golden.py` (the eval imports it; `PRECISION_K`/CLI
  stay eval-side). The plan-review High — context needs full text, not the 120-char preview — was
  folded in: `RagRetriever` fetches full text + `book_slug` by chunk_id.
- **Per-request DB connect** (pooling deferred); vocab + reranker loaded once at startup.
- **Reranker off by default** in the running service (pluggable) to avoid the torch dependency.

## Quality gates

12 service tests (6 unit + 6 endpoint, all mocked — no DB/LLM) + 124 ingestion tests green. Live
uvicorn+curl demo passes. Pushed to rag-chat `master`. No secrets committed.

## Beads

Closed 88v.a/b/c/d and the 88v epic. Filed during the build: `eue` (junk 1-char entity over-restricts),
`7p3` (Fireball/core-PHB spells missing from corpus), `6sa` (re-run 179-q eval parity once the
transient OpenAI 431 on rapid loops clears). These unblock the UI epic `3zs` (which can call this API).
