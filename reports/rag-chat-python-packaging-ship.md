# Ship Report: rag-chat-python-packaging — Fix Python packaging (installable package, no sys.path hacks)
Shipped: 2026-06-26
Epic/Feature: agent-forge-harness-02t.4 (parent epic 02t) · Branch: refactor/02t.4-python-packaging · PR: _pending_

## What Shipped
rag-chat is now a proper installable Python package. The 14 `sys.path.insert` hacks across
`service/` and `ingestion/` are gone, every cross-module import is explicit (`from ingestion.… import …`),
and the service Docker image installs via `pip install .` instead of a hand-maintained per-file
`COPY` manifest — permanently closing the recurring `ModuleNotFoundError`-in-container trap. A new
`test_packaging.py` guard keeps the invariant from rotting. All 217 tests pass from the repo root and
the service image builds and imports cleanly.

## Before → After
| Area | Before | After |
|------|--------|-------|
| Cross-module imports | `sys.path.insert(...)` + bare `from retrieval import …` in 13 files (14 sites); ordering-fragile | Explicit `from ingestion.retrieval import …`; zero `sys.path.insert` repo-wide |
| `rerank` import | In-function "lazy" import in `retrieval.py` (mislabelled circular-dep dodge) | Hoisted to a normal top-level import (no real cycle) |
| Packaging | No `pyproject.toml`; `ingestion/` not a package; deps declared twice (uv docs + Docker list) | One `pyproject.toml` declaring `service`+`ingestion` packages, runtime + `test` deps |
| Run tests from repo root | Worked only via per-file `sys.path` shims / `python module.py` | `uv run --with '.[test]' python -m pytest -q` → 217 passed |
| Docker build | Fragile `COPY ingestion/retrieval.py …` per-file manifest; broke on every new runtime import | `COPY pyproject + ingestion/ + service/` then `pip install .`; new imports can't break it |
| Regression safety | None — nothing caught a reintroduced hack | `test_packaging.py` fails CI if `sys.path.insert` returns or a package stops importing |

## Work Done
- Checkpoint A — pyproject.toml + empty `ingestion/__init__.py` + root `conftest.py`; `.gitignore` for Python artifacts (`d9b6922`)
- Checkpoint B — `test_packaging.py` guard, committed RED (`a2004fa`)
- Checkpoint C — package-qualify source imports across rag/generate/retrieval/eval_golden/extract_scan/ingest_books; hoist `rerank` import; `eval_golden` rerank stays gated; OpenAI lazy imports left intentional (`78ecfa0`)
- Checkpoint D — package-qualify all 11 test files incl. 7 in-function `from scope import` in test_service; delete every `sys.path.insert`; guard now GREEN (`a9fc331`)
- Checkpoint E — `Dockerfile.service` → `pip install .`; verified `docker compose build service` + container import smoke (`a592bb3`)
- Checkpoint F — README.md, service/README.md, and all 11 test docstrings to package-aware commands (`80c80c8`)

## Beads Completed
| Beads ID | Title | Status |
|----------|-------|--------|
| 02t.4 | [rag-chat][service] Fix Python packaging (parent/tracking) | closed |
| 02t.4.1 | A: packaging skeleton (pyproject + __init__ + conftest) | closed |
| 02t.4.2 | B: guard test test_packaging.py (RED) | closed |
| 02t.4.3 | C: rewrite source imports + hoist rerank | closed |
| 02t.4.4 | D: rewrite test imports; delete all sys.path.insert | closed |
| 02t.4.5 | E: Dockerfile.service → pip install . + smoke | closed |
| 02t.4.6 | F: update README/service docs | closed |

## Test It Yourself (walkthrough)
From `repos/rag-chat`:

1. **Full suite from repo root** (no install needed — `pythonpath=["."]` + the `test` extra):
   ```bash
   uv run --with '.[test]' python -m pytest -q
   ```
   Expect: `217 passed`.
2. **Prove no hacks remain**:
   ```bash
   grep -rn "sys.path.insert" --include=*.py service ingestion   # → no output
   ```
3. **Docker build + container import smoke** (the per-file manifest is gone):
   ```bash
   docker compose build service
   docker compose run --rm --no-deps service \
     python -c "import service.app; import ingestion.retrieval, ingestion.scope, ingestion.rerank; print('ok')"
   ```
   Expect: build succeeds; prints `ok`.

## Follow-ups / Known Gaps
- **Branch topology (pre-existing, NOT introduced here):** this PR is based on `feat/mode-scope-dedup`
  because that branch holds the `ingestion/scope.py` extraction this work builds on. PR #2 (mode-scope)
  was merged into `feat/aetheril-overhaul` rather than `master`, so the scope-dedup change never
  reached `master`, and `master` has separately advanced (PRs #3/#4/#5). Untangling that — getting
  mode-scope + this packaging work onto `master` cleanly — is a separate repo-hygiene task and should
  be a new Beads issue.
- **Pre-existing lint (out of scope → 02t.5):** 13 F401-family findings (unused imports in
  `eval_golden.py`, `gen_golden.py`, and a few test files) predate this work and belong to the
  "Type-safety + validation + cleanup pass" task. This refactor introduced zero net-new lint.
