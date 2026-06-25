# Ship Report: rag-chat-mode-scope-dedup — Consolidate duplicated mode→scope mapping
Shipped: 2026-06-25
Epic: agent-forge-harness-02t · Task: agent-forge-harness-02t.1
Repo: rag-chat · Branch: `feat/mode-scope-dedup` (stacked on `feat/aetheril-overhaul`) · PR: _pending_

## What Shipped
The mode→scope mapping that decides which content-types and books each chat mode retrieves used to
exist as **two byte-identical copies** — one in `service/rag.py`, one in `ingestion/retrieval.py` —
kept in sync only by a parity test. It now lives in a single canonical leaf module
`ingestion/scope.py` (`scope_for_mode`). The production retriever imports it; the dead service copy
and the drift-policing parity test are gone. The module imports nothing from the project, so it
breaks the `retrieval ↔ rag` import cycle the duplication was originally created to dodge. Retrieval
behavior is unchanged — only the code organization improved.

## Before → After
| Area | Before | After |
|------|--------|-------|
| Source of truth | Two identical copies (`service/rag._scope_for_mode` + `ingestion/retrieval._retrieval_scope_for_mode`) that had to be hand-synced | One module `ingestion/scope.py::scope_for_mode`, imported by the production path |
| Drift protection | A parity test asserting the two copies agree | Not needed — there is only one implementation |
| Service copy | `service/rag.py` carried a full copy that no production code ever called (dead) | Deleted; service no longer duplicates scope logic |
| Circular-dep workaround | Comment + duplication explaining why the logic couldn't be shared | Removed; a dependency-free leaf module makes sharing safe |
| Test coverage of the mapping | Behavioral tests in two files + parity test | Behavioral tests repointed + a new truth-table characterization suite (`ingestion/test_scope.py`) pinning every mode × query-ctype combination |

## Work Done
- **Checkpoint A** — Created `ingestion/scope.py` (`scope_for_mode` + the three frozensets) and a
  12-test truth-table suite `ingestion/test_scope.py`, including a full regression matrix and a
  no-mutation guard. (`ead839f`)
- **Checkpoint B** — Repointed the production consumer `ingestion/retrieval.py` at the shared
  function, deleting its local copy and the circular-dep comment; repointed `test_retrieval.py`.
  (`9cb580f`)
- **Checkpoint C** — Deleted the dead `service/rag.py` copy (frozensets + `_scope_for_mode`),
  repointed `service/test_service.py`, and removed the now-pointless parity test. (`845278b`)
- **Packaging fix** — `Dockerfile.service` copies an explicit file manifest from `ingestion/`
  (not the whole dir), so the new `scope.py` was missing in the image and the container crashed at
  import (`ModuleNotFoundError: No module named 'scope'`). Added `COPY ingestion/scope.py`; verified
  with a real `docker build` + in-image `import service.rag` smoke test. (`1097585`)

Net: the non-test code shrank (two ~35-line copies removed, one ~68-line module added); the line
growth is the new characterization suite.

## Beads Completed
| Beads ID | Title | Status |
|----------|-------|--------|
| agent-forge-harness-02t.1 | [rag-chat][service] Consolidate duplicated mode→scope mapping into one shared module | closed |

Parent epic `agent-forge-harness-02t` remains open (12 sibling tech-debt tasks still to do).

## Test It Yourself (walkthrough)
From the rag-chat repo root (`repos/rag-chat`):

1. **New canonical module's characterization suite:**
   ```bash
   uv run --with pytest python -m pytest ingestion/test_scope.py -q
   ```
   Expect: `12 passed`.
2. **Production retriever still scopes correctly:**
   ```bash
   uv run --with pytest --with "psycopg[binary]" python -m pytest ingestion/test_retrieval.py -q
   ```
   Expect: `14 passed`.
3. **Service unchanged + parity test gone:**
   ```bash
   uv run --with pytest --with "psycopg[binary]" --with pydantic python -m pytest service/test_service.py -q
   ```
   Expect: `52 passed`.
4. **No duplication remains** (must print nothing but the doc-comment line in test_scope.py):
   ```bash
   grep -rn "_scope_for_mode\|_retrieval_scope_for_mode" --include=*.py . | grep -v __pycache__
   ```
   Expect: only the historical reference inside `ingestion/test_scope.py`'s docstring — no code symbols.

## Follow-ups / Known Gaps
- None for this task. Remaining epic work (error handling, config externalization, UI passes, etc.)
  is tracked under the sibling children of `agent-forge-harness-02t`.
