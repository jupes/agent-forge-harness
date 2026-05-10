# Harness RAG — Local Vector DB (Implementation Plan)

> **Status**: Draft  
> **Last updated**: 2026-05-09  
> **Scope**: [Agent Forge harness](https://github.com/jupes/agent-forge-harness) only — RAG over **harness dev repos** (`repos/` clones) and `knowledge/` YAML files to give harness agents grounded context about the codebase. Uses **PostgreSQL + pgvector in Docker**.

**Not in scope**: The D&D 5e RAG (rules/spell lookup for the rag-chat app) is a **separate project** documented in [dnd-rag-ingestion.md](./dnd-rag-ingestion.md) and implemented in the `rag-chat` sub-repo. The two projects share the same pgvector Docker container but use **separate PostgreSQL schemas** (`harness.*` vs `dnd.*`). Neither plan overlaps the other.

**Beads**: Epic **agent-forge-harness-9n1**; infra slice **agent-forge-harness-7fx**; ingestion **agent-forge-harness-c7v**.

---

## Goals

1. Give harness agents **chunk-grounded context** from code and docs checked out under `repos/`.
2. Run entirely on a **developer machine or CI** with Docker — no cloud vector dependency for the default harness path.
3. Keep **embedding + LLM** behind adapters so later options (hosted index, different models) do not require redesign.

---

## Database Topology

The pgvector Docker service hosts **one database per project/app**. The harness uses the `harness` PostgreSQL schema:

```
pgvector container (shared Docker service)
├── schema: harness.*    ← this plan
│     └── harness.chunks (repo, commit, path, text, embedding)
└── schema: dnd.*        ← dnd-rag-ingestion.md / rag-chat sub-repo
      └── dnd.chunks     (book_slug, chapter, content_type, text, embedding)
```

Adding a new project = add a new schema. No cross-schema queries in normal operation.

---

## Architecture

```
repos/<name>/          # Registered clones (repos/repos.json, add-repo skill)
knowledge/**/*.yaml    # Domain YAML files (optional, same index or separate table)
        ↓
ingestion              # Chunk → embed → upsert into harness.chunks
        ↓
vector-db (pgvector)  # Docker service; named volume for persistence
        ↑
harness agents/tools   # Query top-K by prompt embedding; cite source + chunk_id in context
```

Implementation lives in **`scripts/`** in this harness repo (not rag-chat — that sub-repo owns D&D content).

---

## Phase 1 — Local pgvector

**Goal**: pgvector Docker service validated and documented as shared infra.

- Image: `pgvector/pgvector`; compose service `vector-db`.
- `harness` schema created on first run; `dnd` schema owned by rag-chat.
- **Persistence**: named Docker volume; verify survives `docker compose down` + `up`.
- Smoke test: insert a row into `harness.chunks`, similarity query returns it.

**Acceptance**

- `docker compose up vector-db` healthy.
- Script or automated test proves round-trip against `harness.chunks`.
- README documents connection string + env vars for sibling containers.

---

## Phase 2 — Ingestion for `repos/`

**Goal**: Idempotent pipeline from harness checkout paths into `harness.chunks`.

- Input: `repos/<repo>/` paths (and optionally `knowledge/**/*.yaml`).
- Chunking: configurable size + overlap; stable natural key (`repo` + `commit` + `path` + chunk index).
- Embeddings: local model via Ollama (same runtime as D&D pipeline; model TBD for harness).
- Upsert: `INSERT ... ON CONFLICT` — re-runs do not duplicate.

**Acceptance**

- One full repo ingested end-to-end; query returns sensible neighbors for a harness prompt.
- Re-run: no duplicate chunks for unchanged content.

---

## Phase 3 — Retrieval contract for agents

**Goal**: Harness agents call a small function: `embed(query) → topK rows → structured citations`.

- Response shape: `source_path`, `repo`, `snippet`, `chunk_id`.
- Stateless; secrets via env only.
- Queries scoped to `harness.*` — never touches `dnd.*`.

**Acceptance**

- Retrieval function returns grounded answer + `sources[]` for at least one golden harness prompt (e.g. "where is the add-repo skill implemented?").

---

## Phase 4 — Evaluation (harness golden set)

Small golden set about indexed repos:

- `question`, `expected_behavior`, `expected_files_or_symbols`, `must_include`, `must_not_include`.

Use to tune `topK`, chunk size, and thresholds after each major corpus change.

---

## Open Questions

- [ ] **Harness embedding model**: use same `mxbai-embed-large` (1024d via Ollama) as D&D pipeline for operational simplicity, or a lighter model for code search?
- [ ] **`knowledge/` YAML**: same `harness.chunks` table with a `source_type` column, or a separate `harness.knowledge_chunks` table?
- [ ] **First corpus**: one pilot repo (e.g. `rag-chat`) vs. all registered `repos.json` entries?
- [ ] **CI**: smoke ingestion + query on PR (needs Ollama in CI or a pre-embedded fixture set).

---

## Next Steps

1. Validate pgvector container and create `harness` schema (Phase 1).
2. Decide embedding model for harness (reuse `mxbai-embed-large` or pick lighter model).
3. Pilot ingestion on one `repos/` checkout.
4. Wire retrieval into harness agent tooling.
