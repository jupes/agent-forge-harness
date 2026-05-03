# Harness RAG — Local Vector DB (Implementation Plan)

> **Status**: Draft  
> **Last updated**: 2026-05-03  
> **Scope**: [Agent Forge](https://github.com/jupes/agent-forge-harness) — RAG over **harness dev repos** (`repos/` clones, optional `knowledge/`) using **PostgreSQL + pgvector in Docker** (no hosted vector store required for v1).

**Related**: The **D&D 5e RAG** product plan lives in the **rag-chat** sub-repo: `repos/rag-chat/plan.md` (cloned path; not committed in this harness root). This document is **harness-only**.

**Beads**: Epic **agent-forge-harness-9n1** (Harness vector DB + dev-repo RAG); infra slice **agent-forge-harness-7fx**; ingestion **agent-forge-harness-c7v**.

---

## Goals

1. Give agents and tools **chunk-grounded context** from code and docs checked out under `repos/`.
2. Run entirely on a **developer machine or CI** with Docker: **no cloud vector dependency** for the default harness path.
3. Keep **embedding + LLM** behind adapters so later options (hosted index, different models) do not require redesign.

---

## Architecture (harness)

```
repos/<name>/          # Registered clones (see repos/repos.json, add-repo skill)
        ↓
ingestion              # Chunk → embed → upsert into pgvector (compose job or harness script)
        ↓
vector-db (pgvector)  # Docker service on Compose network; named volume for persistence
        ↑
agent-service / tools  # Query top-K by prompt embedding; cite source + chunk_id in context
```

Implementation may live in the **rag-chat** repository (same stack: `vector-db/`, `ingestion/`, `agent-service/`) or be mirrored by harness-specific scripts under `scripts/` — pick one source of truth and document it here when code lands.

---

## Phase 1 — Local pgvector

**Goal**: The existing **pgvector** Docker service is validated, documented, and used as the only vector store for harness RAG v1.

- Image and compose wiring (e.g. `pgvector/pgvector`) — keep `vector-db/README.md` in the implementation repo aligned with `docker-compose.yml`.
- **Schema**: embedding column dimension = chosen model; metadata columns at minimum `source`, `chunk_id`, `text`; add **`repo`**, **`commit`**, **`path`** (or equivalent) for multi-repo harness indexing.
- **Persistence**: named volume; verify survive `docker compose down` + `up`.
- Smoke test: insert + similarity query returns expected row.

**Acceptance**

- `docker compose up vector-db` healthy.
- Script or automated test proves round-trip against the container.
- README documents connection from sibling containers (service DNS + port + env vars).

---

## Phase 2 — Ingestion for `repos/`

**Goal**: Idempotent pipeline from harness checkout paths into pgvector.

- Input: paths under `repos/<repo>/` (and optionally `knowledge/**/*.yaml` if you want structured docs in the same index or a separate namespace/table).
- Chunking: configurable size + overlap; stable **natural key** per chunk (`repo` + `commit` + `path` + chunk index or content hash).
- Embeddings: one chosen API or local model; document cost and dimension in README.
- Upsert: SQL `INSERT ... ON CONFLICT` or equivalent so re-runs do not duplicate.

**Acceptance**

- One full **repos/** repo ingested end-to-end; query returns sensible neighbors for a harness-specific prompt (e.g. “where is X implemented?”).
- Re-run ingestion: no duplicate chunks for unchanged content.

---

## Phase 3 — Retrieval contract for agents

**Goal**: Any harness consumer can call a small API or library: **embed(query) → topK rows → structured citations**.

- Top-K, similarity metric, and optional score floor documented and tunable.
- Response shape includes **source path**, **repo**, **snippet** / `text`, and **chunk_id** for UI or logs.
- Stateless service preferred; secrets only via env.

**Acceptance**

- Harness or rag-chat **agent-service** (or equivalent) retrieves from pgvector over the **internal Compose network** only.
- Grounded answer + `sources[]` for at least one golden prompt (see Phase 4).

---

## Phase 4 — Evaluation (harness golden set)

Build a small golden set **about the indexed repos** (not D&D rules), for example:

- `question`, `expected_behavior`, `expected_files_or_symbols`, `must_include`, `must_not_include`.

Use it to tune `topK`, chunk size, and thresholds after each major corpus change.

---

## Open questions (harness)

- [ ] Single implementation repo (**rag-chat** only) vs. split **scripts/** in harness — ownership boundary.
- [ ] First corpus: one pilot repo vs. all registered `repos.json` entries.
- [ ] Include `knowledge/` YAML in the same embedding space or separate index?
- [ ] CI: run smoke ingestion + query on PR (optional; may need secrets for embeddings).

---

## Next steps (checklist)

1. Align compose service name, ports, and `vector-db/README.md` with the actual **rag-chat** (or other) repo that hosts the Dockerfiles.
2. Land **pgvector** adapter (upsert + top-K) used by ingestion and retrieval.
3. Pilot ingestion on one `repos/` checkout; add golden prompts.
4. Wire harness dashboard or agent tooling to the retrieval API when ready.
