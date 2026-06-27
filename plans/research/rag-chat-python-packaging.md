# Research: rag-chat-python-packaging — Fix Python packaging (remove sys.path hacks + lazy-import dodge)
Generated: 2026-06-26
Repo: rag-chat
Phase: research (1/4)
Bead: agent-forge-harness-02t.4 (parent epic 02t)

## Goal
rag-chat reaches its `ingestion/` modules from `service/` and from test files via 14
`sys.path.insert` hacks plus bare imports (`from retrieval import …`), and dodges a
mis-diagnosed "circular dep" with an in-function `from rerank import …`. This is fragile
across CI / Docker / IDE cwd. Restructure into a proper installable package so all imports
are explicit, no `sys.path` hacks remain, and `pytest` passes from the repo root **and**
inside Docker.

## What the Code Says (answered by exploration)

### Current import topology
- **`service/` is already a real package** — has `__init__.py`, uses relative imports for its
  own modules (`from .generate import …`, `from .models import …`, `from .rag import …` in
  `service/app.py`, `service/rag.py`). Its *only* sin is reaching `ingestion/` via
  `sys.path.insert` → bare import:
  - `service/rag.py:15-16` — `sys.path.insert(... / "ingestion")` then `from retrieval import RagRetriever, RetrievalResult`
  - `service/generate.py:16-17` — same, then `from retrieval import RetrievalResult`
- **`ingestion/` is NOT a package** — no `__init__.py`. Flat modules cross-import by bare name:
  - `ingestion/retrieval.py:27` — `from scope import scope_for_mode`
  - `ingestion/retrieval.py:463` — **in-function** `from rerank import should_rerank` (the "lazy" dodge)
  - `ingestion/eval_golden.py:47` — `from retrieval import (…)`; `:269` — in-function `from rerank import …`
  - `ingestion/ingest_books.py:25,29` — `sys.path.insert(parent)` then `from embed import …`
- **14 `sys.path.insert` sites total** (confirmed via grep):
  - Source: `service/rag.py:15`, `service/generate.py:16`, `ingestion/ingest_books.py:25`
  - Tests: `service/test_app.py:14`, `service/test_service.py:15-16`, and 9 ingestion `test_*.py`
    (`test_eval_golden:13`, `test_extract_scan:13`, `test_gen_golden:13`, `test_ocr_normalize:14`,
    `test_qa_chunks:17`, `test_rerank:13`, `test_retrieval:17`, `test_scope:18`)

### The "circular dep" is a misdiagnosis
`ingestion/rerank.py` has **no top-level imports beyond `from __future__`** — it never imports
`retrieval`. There is no import cycle. The lazy `from rerank import should_rerank` inside
`retrieval.py:463` is only a micro-optimization (skip the import when `reranker is None`). Per the
`rerank.py` docstring, only the *torch model* is lazy-loaded; importing the module is already cheap.
**→ Safe to hoist to an explicit top-level `from ingestion.rerank import should_rerank`.**

### Packaging / build / test status
- **No `pyproject.toml`, `setup.py`, `setup.cfg`, `conftest.py`, or `pytest.ini` anywhere** in the repo.
- **No `.github/workflows/`** — no CI in this repo today.
- **Runtime deps declared in two disconnected places:**
  - Docs (`README.md:95`, `service/README.md`) use `uv run --with fastapi --with uvicorn --with openai --with "psycopg[binary]" …`
  - `Dockerfile.service:7` hand-maintains `pip install --no-cache-dir fastapi "uvicorn[standard]" openai "psycopg[binary]"`
- **Tests are plain pytest-style functions** (zero files import `unittest`). `ingestion/test_retrieval.py`
  docstring already prescribes `python -m pytest …`. So pytest is the intended runner; AC aligns.
- **Docker build (`Dockerfile.service`)** uses a fragile explicit per-file manifest — the exact trap
  recorded in beads memory (extracting `ingestion/scope.py` in 02t.1 crashed the container until a
  `COPY ingestion/scope.py` line was added):
  ```
  COPY ingestion/retrieval.py ingestion/retrieval.py
  COPY ingestion/scope.py    ingestion/scope.py
  COPY ingestion/rerank.py   ingestion/rerank.py
  COPY service/              service/
  CMD ["uvicorn", "service.app:app", …]
  ```
- **`.dockerignore`** already trims `ingestion/test_*.py`, `*.jsonl`, `*.json`, `embed.py`,
  `extract*.py`, `ingest_books.py`, `qa_chunks.py`, `eval_*.py`, `gen_*.py`, `spike_*.py`, plus
  `vector-db/ spikes/ docs/ ui/`. So a broad `COPY ingestion/` would still bring only the runtime
  `.py` files (`retrieval.py`, `scope.py`, `rerank.py`, and a new `__init__.py`).
- **docker-compose.yml** builds the service from `Dockerfile.service` with `context: .`; the uvicorn
  entry is `service.app:app`. The `ui` service builds separately (`context: ./ui`) — out of scope.

### Existing code to reuse
- `service/__init__.py` already exists — the package pattern to mirror for `ingestion/`.
- Tests are already discovery-friendly once the `sys.path.insert` headers are removed and imports
  are package-qualified.

## Decisions Resolved with the User
| Question | Decision | Rationale |
|----------|----------|-----------|
| How far to restructure? | **Two top-level packages** — keep `service/` as-is, make `ingestion/` a package; declare both in one `pyproject.toml`. Rewrite bare imports to `ingestion.*`. | Lowest churn; keeps uvicorn target `service.app:app` and the compose/Docker entrypoint unchanged; fully satisfies AC. Umbrella `rag_chat/` was the bead's suggestion but adds churn (entrypoint + every import path) without proportional benefit. |
| Runtime deps + Docker build? | **`pyproject.toml` + `pip install .`** — declare deps in pyproject; Docker copies `pyproject.toml` + `ingestion/` + `service/` then `pip install .`. | Package install pulls deps AND all needed modules → permanently kills the fragile per-file COPY manifest (the memory trap). `.dockerignore` still trims data/test files. |

## Constraints & Non-Goals
- **Constraint:** uvicorn target must stay `service.app:app` (compose + Dockerfile CMD depend on it).
- **Constraint:** `ingestion/__init__.py` must be **empty / non-eager** — must NOT import submodules at
  package-import time, or Docker (which `.dockerignore`-trims `embed.py`/`extract*.py`/etc.) would
  break on a missing module. Only `retrieval`/`scope`/`rerank` are present at service runtime.
- **Constraint:** AC requires `pytest` green **from repo root** (no install assumed) **and in Docker**.
  → A root `conftest.py` makes `import service` / `import ingestion` work without an install (pytest
  prepends rootdir to `sys.path`); `pip install .` covers the Docker/global path.
- **Non-goal:** the LangGraph migration (3t2), umbrella `rag_chat/` rename, UI build, and CI workflow
  creation are all out of scope.
- **Non-goal:** changing runtime behavior of retrieval/rerank/generate — this is a pure
  packaging/imports refactor; tests must stay green unchanged.

## Open Risks / Assumptions Carried Forward
- **Docker `pip install .` needs a build backend** — pyproject must declare `[build-system]`
  (setuptools>=61) and explicit `packages = ["service", "ingestion"]` (don't auto-discover, to avoid
  picking up `ui/`, `vector-db/`, `spikes/`, `docs/`).
- **`.dockerignore` interaction** — after `ingestion/` is a package, confirm `ingestion/__init__.py`
  is NOT matched by any ignore pattern (current patterns target `test_*.py` and named modules, so an
  `__init__.py` is safe). Verify the built image imports cleanly (`docker compose build service` +
  a smoke import) before closing.
- **Editable vs regular install for dev** — recommend documenting `pip install -e .` (or keeping
  `uv run`), but the AC's "pytest from repo root" is satisfied by the root `conftest.py` alone, so a
  dev install is a convenience, not a requirement.
- **`ingest_books.py` / `eval_golden.py`** are not service-runtime modules but still need their bare
  imports + `sys.path` fixed for the "no sys.path.insert in ingestion modules" AC to hold repo-wide.

## Recommended Scope for Planning
Add a single `pyproject.toml` declaring `service` + `ingestion` as packages with runtime deps
(fastapi, uvicorn[standard], openai, psycopg[binary], pydantic) and a `test` extra (pytest, httpx);
add an empty `ingestion/__init__.py` and a root `conftest.py`. Mechanically rewrite all bare
cross-imports to package-qualified (`from ingestion.retrieval import …`, `from ingestion.scope import …`,
`from ingestion.rerank import …`, `from ingestion.embed import …`) across source and tests, hoist the
`rerank` lazy import to top level, and delete all 14 `sys.path.insert` lines. Rewrite
`Dockerfile.service` to `COPY pyproject.toml` + `COPY ingestion/ service/` + `pip install .` (drop the
per-file manifest and hand-maintained pip list), keeping CMD `service.app:app`. Verify: `pytest` green
from repo root, and `docker compose build service` + container import smoke test green. Update README /
service README test+run commands to the new package-aware invocations.
