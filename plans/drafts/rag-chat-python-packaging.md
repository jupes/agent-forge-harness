# Plan: rag-chat-python-packaging — Fix Python packaging (installable package, no sys.path hacks)
Generated: 2026-06-26
Repo: rag-chat
Phase: plan (2/4) — from plans/research/rag-chat-python-packaging.md
Bead: agent-forge-harness-02t.4 (parent epic 02t)

## Summary
Turn rag-chat into a properly installable Python project: one `pyproject.toml` declaring `service`
and `ingestion` as packages (plus runtime + test deps), an empty `ingestion/__init__.py`, and a root
`conftest.py`. Rewrite all 14 `sys.path.insert` sites (across 13 files — `test_service.py` has two) and bare
cross-imports to package-qualified form (`ingestion.*`), hoist the one mis-labelled `rerank` "lazy"
import in `retrieval.py`, and replace the fragile per-file Docker COPY manifest with `pip install .`. Pure
packaging/imports refactor — runtime behavior unchanged; the ~211-function pytest suite is the safety
net. The new durable artifact is a `test_packaging.py` guard that fails if `sys.path.insert` ever
returns or a package stops importing cleanly.

## Existing Code to Reuse
- `service/__init__.py` — the package pattern to mirror for `ingestion/` (from research).
- The existing ~211 pytest functions across 11 `test_*.py` files — the behavioral safety net; they
  must stay green unchanged.
- `.dockerignore` — already trims data/test/non-runtime ingestion modules; reused so a broad
  `COPY ingestion/` brings only `retrieval.py`/`scope.py`/`rerank.py`/`__init__.py`.

## Tooling note (binds every demo command)
Bare `python` is **not** on PATH in this environment — only `uv` (0.10.6). All test/run commands go
through `uv run --with <deps> python -m pytest …`. Docker (29.4.1) + compose v5 are available.

## TDD Strategy (red-green-refactor)
Following `.claude/skills/tdd`. This is a refactor, so the discipline is inverted from feature work:
the **existing suite is the green-keeping net** (must never go red), and we add **one new guard test**
that starts RED (hacks still present) and is driven GREEN by the refactor. Behaviors are observable
via imports and the test runner, not internals.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | All packages import cleanly from repo root with no `sys.path` manipulation: `import ingestion.retrieval, ingestion.scope, ingestion.rerank, service.rag, service.app` succeeds | `test_packaging.py` | **yes** |
| 2 | No `sys.path.insert` exists in any `service/*.py` or `ingestion/*.py` (source or test) | `test_packaging.py` | no |
| 3 | The full existing suite stays green after each import rewrite (no behavior change) | all 11 existing `test_*.py` | no |
| 4 | The built service image imports `service.app` (deployment path proven, manifest gone) | docker smoke (build + `python -c "import service.app"`) | no |

Refactor watch-list (after green): the `rerank` import hoist removes a needless in-function import;
confirm no other in-function imports of sibling modules linger; keep `ingestion/__init__.py` empty
(non-eager) so `.dockerignore`-trimmed modules never break package import.

## Build Sequence & Checkpoints

### Checkpoint A — Packaging skeleton (importable, no rewrites yet)
Steps:
1. Add `ingestion/__init__.py` — empty (must NOT import submodules; keeps Docker-trimmed modules safe). — `ingestion/__init__.py`
2. Add root `conftest.py` — empty file; it anchors pytest's `rootdir` to the repo root. (The actual sys.path mechanism is `pythonpath = ["."]` below, not conftest alone — see step 3.) — `conftest.py`
3. Add `pyproject.toml` — `[build-system]` setuptools>=61; `[project]` deps `fastapi, uvicorn[standard], openai, psycopg[binary], pydantic` (verified against the runtime import audit of `service/app,rag,generate,models` + `ingestion/retrieval,scope,rerank`); `[project.optional-dependencies] test = [pytest, httpx]`; `[tool.setuptools] packages = ["service", "ingestion"]`; `[tool.pytest.ini_options] pythonpath = ["."]` — **this** is what puts repo root on `sys.path` (pytest ≥7) so `import service` / `import ingestion` resolve with no install. — `pyproject.toml`

Precondition (already true — verified): `.dockerignore` excludes `ingestion/test_*.py`, data files, and named non-runtime modules but has **no** pattern matching `ingestion/__init__.py`, so the new `__init__.py` survives `COPY ingestion/` in Checkpoint E. No `.dockerignore` change is required there.

Demo: `uv run --with pytest --with "psycopg[binary]" python -m pytest --collect-only -q` still collects all suites (nothing broken); `uv run python -c "import ingestion, service"` exits 0. — user sees the skeleton is importable and the suite is intact.

### Checkpoint B — Guard test goes RED (tracer)
Steps:
1. Add `test_packaging.py` at repo root asserting behaviors #1 and #2: import the five package modules; walk `service/` + `ingestion/` `.py` files and assert none contain `sys.path.insert`. — `test_packaging.py`

Demo: `uv run --with pytest --with fastapi --with httpx --with openai --with "psycopg[binary]" python -m pytest test_packaging.py -q` → **RED**, listing the 14 offending sites (across 13 files). — user sees the failing spec that the refactor must satisfy.

### Checkpoint C — Rewrite source imports (drive toward GREEN)
**Scope rule:** only sibling-module imports that used `sys.path` get package-qualified, plus the one
`rerank` dodge gets hoisted. **Heavy third-party lazy imports stay lazy by design** — the
`from openai import OpenAI` deferrals at `retrieval.py:56`, `generate.py:110`, `embed.py:70` are
intentional (avoid loading the OpenAI SDK until needed) and are **not** touched (they're third-party,
no path change). Likewise the `rerank` import in `eval_golden.py` stays gated (see step 4).

Steps:
1. `service/rag.py` — delete `sys.path.insert` (line 15); `from ingestion.retrieval import RagRetriever, RetrievalResult`. — `service/rag.py`
2. `service/generate.py` — delete `sys.path.insert` (line 16); `from ingestion.retrieval import RetrievalResult`. (Leave the lazy `from openai import OpenAI` at line 110 as-is.) — `service/generate.py`
3. `ingestion/retrieval.py` — `from ingestion.scope import scope_for_mode`; **hoist** the in-function `from rerank import should_rerank` (line 463) to a top-level `from ingestion.rerank import should_rerank` (safe: `rerank` has no heavy top-level imports — `should_rerank` is pure logic; the torch model loads only on `CrossEncoderReranker` *instantiation*, not module import). Leave the lazy `from openai import OpenAI` at line 56 as-is. — `ingestion/retrieval.py`
4. `ingestion/eval_golden.py` — `from ingestion.retrieval import (…)` at top; **keep** the rerank import gated *in place* inside `if args.rerank:` (line 269) as `from ingestion.rerank import CrossEncoderReranker, should_rerank` — it sits immediately before `CrossEncoderReranker()` which triggers the torch load, so hoisting would change runtime cost. Package-qualify only; do not move it. — `ingestion/eval_golden.py`
5. `ingestion/ingest_books.py` — delete `sys.path.insert` (line 25); `from ingestion.embed import …`. — `ingestion/ingest_books.py`

Demo: `uv run --with pytest --with fastapi --with httpx --with openai --with "psycopg[binary]" python -m pytest service/ ingestion/test_retrieval.py ingestion/test_scope.py ingestion/test_rerank.py -q` → green (source modules import package-qualified). Guard still RED (test files unchanged). — user sees source rewrites didn't break behavior.

### Checkpoint D — Rewrite test imports + delete remaining sys.path hacks (GREEN)
Steps:
1. All 11 `test_*.py` (`service/test_app.py`, `service/test_service.py`, and 9 `ingestion/test_*.py`) — delete each `sys.path.insert` header; package-qualify imports (`from ingestion.retrieval import …`, `from service.rag import …`, etc.). — 11 files

Demo: `uv run --with pytest --with fastapi --with httpx --with openai --with "psycopg[binary]" python -m pytest -q` → **full suite green from repo root** and `test_packaging.py` now **GREEN**. — user sees the whole suite pass with zero sys.path hacks.

### Checkpoint E — Docker: pip install . (deployment path)
Steps:
1. Rewrite `Dockerfile.service` — replace the per-file COPY manifest + hand-maintained pip list with: `COPY pyproject.toml ./`, `COPY ingestion/ ingestion/`, `COPY service/ service/`, `RUN pip install --no-cache-dir .`; keep `CMD ["uvicorn", "service.app:app", …]`. — `Dockerfile.service`
2. `.dockerignore` is **already compatible** (verified in Checkpoint A precondition) — no change expected; only touch it if the build smoke reveals a trimmed module is imported at runtime. — `.dockerignore`

Demo: `docker compose build service` succeeds, then smoke: `docker compose run --rm --no-deps service python -c "import service.app; print('ok')"` prints `ok`. — user sees the image builds and imports without the explicit manifest.

### Checkpoint F — Docs (no live demo)
Steps:
1. Update `README.md`, `service/README.md`, and the per-test "Run from repo root" docstrings to the package-aware commands (`uv run --with '.[test]' python -m pytest` / `pip install -e '.[test]'`). — docs
2. `bd close` 02t.4 child tasks; worklog on 02t.4.

Demo: `(no live demo)` — documentation only; verified by re-reading.

## Files to Create / Modify
| File | Create/Modify | Purpose |
|------|---------------|---------|
| `pyproject.toml` | Create | Declare packages + deps + test extra + pytest config |
| `ingestion/__init__.py` | Create | Make `ingestion` a package (empty/non-eager) |
| `conftest.py` | Create | Root marker → pytest puts repo root on path |
| `test_packaging.py` | Create | Guard: clean imports + no `sys.path.insert` regresses |
| `service/rag.py`, `service/generate.py` | Modify | Package-qualified ingestion imports; drop sys.path |
| `ingestion/retrieval.py` | Modify | `ingestion.scope` import + hoist rerank import |
| `ingestion/eval_golden.py`, `ingestion/ingest_books.py` | Modify | Package-qualified imports; drop sys.path |
| 11 `test_*.py` (service + ingestion) | Modify | Drop sys.path headers; package-qualified imports |
| `Dockerfile.service` | Modify | `pip install .` replaces per-file COPY manifest |
| `.dockerignore` | Verify/Modify | Keep `__init__.py`, keep trimming data/tests |
| `README.md`, `service/README.md` | Modify | Package-aware run/test commands |

## Validation Commands
```bash
# From repos/rag-chat — full suite green from repo root (AC #1):
uv run --with pytest --with fastapi --with httpx --with openai --with "psycopg[binary]" \
  python -m pytest -q

# Lint (repo already uses ruff — .ruff_cache present):
uv run --with ruff ruff check service ingestion

# Docker build + import smoke (AC #2 — pytest/import passes in Docker):
docker compose build service
docker compose run --rm --no-deps service python -c "import service.app; print('ok')"
```

## Beads Issue Map
Child tasks created under existing bead **agent-forge-harness-02t.4** (no duplicate epic). `bd`
auto-assigns child IDs — the IDs below are recorded back after creation. Sequential deps A→B→C→D→E→F.

| Checkpoint | Beads ID (assigned) | Type | Title | Depends on | Priority |
|-----------|---------------------|------|-------|-----------|----------|
| (parent) | 02t.4 | task | [rag-chat][service] Fix Python packaging (tracking) | — | P2 |
| A | 02t.4.1 | task | Packaging skeleton: pyproject + ingestion/__init__ + conftest | — | P2 |
| B | 02t.4.2 | task | Guard test test_packaging.py (RED) | 02t.4.1 | P2 |
| C | 02t.4.3 | task | Rewrite source imports + hoist rerank | 02t.4.2 | P2 |
| D | 02t.4.4 | task | Rewrite test imports; delete all sys.path.insert (GREEN) | 02t.4.3 | P2 |
| E | 02t.4.5 | task | Dockerfile.service → pip install . + build/import smoke | 02t.4.4 | P2 |
| F | 02t.4.6 | task | Update README/service docs to package-aware commands | 02t.4.5 | P3 |

## Estimated Scope
- Files: 4 new / ~16 modified; Complexity: **Medium** (mechanical breadth, low conceptual risk);
  Checkpoints: 6.
- Primary risk: Docker `pip install .` + `.dockerignore` interaction (Checkpoint E) — mitigated by the
  build+import smoke. Secondary: a missed bare import surfacing only at runtime — mitigated by the
  full-suite run and the import-everything guard test.
