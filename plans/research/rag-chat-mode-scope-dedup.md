# Research: rag-chat-mode-scope-dedup — Consolidate duplicated mode→scope mapping
Generated: 2026-06-25
Repo: rag-chat (`repos/rag-chat`)
Phase: research (1/4)
Beads: agent-forge-harness-02t.1 (child of epic agent-forge-harness-02t)

## Goal
The mode→scope mapping (which content-types and books each chat mode retrieves) is hardcoded in
**two** places that must be kept byte-identical. Collapse them into one canonical module both the
service and ingestion paths import, removing the frozenset duplication and the parity test that
exists only to police drift — without reintroducing the `retrieval ↔ rag` circular import the
duplication was created to dodge.

## What the Code Says (answered by exploration)

### The duplication
- **Service copy:** `service/rag.py:42` `_scope_for_mode(mode, query_ctypes)` plus module-level
  frozensets `_SPELL_BOOKS` (L28), `_RULES_CTYPES` (L33), `_GM_FORCED_CTYPES` (L37).
- **Ingestion copy:** `ingestion/retrieval.py:424` `_retrieval_scope_for_mode(mode, query_ctypes)`
  with the **same** three frozensets inlined as locals (L434-443). Logic is identical.
- **Which one runs in prod:** the ingestion copy — `RagRetriever.retrieve` calls
  `_retrieval_scope_for_mode` at `retrieval.py:482`. The service copy (`_scope_for_mode`) is called
  by **no production code**; it is referenced only by `service/test_service.py`.

### Why it was duplicated (the constraint to preserve)
- `service/rag.py:15-16` does `sys.path.insert(0, …/ingestion)` then `from retrieval import …`.
  So **rag depends on retrieval**. Having `retrieval` import `_scope_for_mode` from `service.rag`
  would create a cycle (`retrieval → rag → retrieval`). The duplicate + parity test was the
  workaround. The comment at `retrieval.py:479-481` documents this explicitly.
- **Resolution:** a *leaf* module that imports nothing from the project breaks the cycle — both
  `retrieval` and `rag` can depend on it, and it depends on neither.

### Packaging facts (determine import mechanics)
- `service/` **is** a package — has `service/__init__.py`; `rag.py` uses relative imports
  (`from .generate import …`, `from .models import …`).
- `ingestion/` is **not** a package — no `__init__.py`. Its modules are imported top-level
  (`from retrieval import …`) after the importer puts `ingestion/` on `sys.path`.
- In **every** context that touches the scope logic, `ingestion/` is already on `sys.path`:
  - `service/rag.py:15` inserts it.
  - `service/test_service.py:16` inserts it.
  - `ingestion/test_retrieval.py:18` inserts its own dir.
  → A sibling `ingestion/scope.py` is importable as `from scope import scope_for_mode` from all
    three.

### The behavior (must be preserved exactly)
`(effective_ctypes, allowed_books)` where `None` means unscoped:
- `spell` → `({"spell"}, set(_SPELL_BOOKS))` — forces spell ctype, restricts to spell-bearing books.
- `rules` → `(query_ctypes & _RULES_CTYPES or set(_RULES_CTYPES), None)` — intersection, fallback to
  full allowlist; no book restriction.
- `gm` → `(query_ctypes | set(_GM_FORCED_CTYPES), None)` — union with forced creative ctypes.
- `sage`/unrecognised → `(query_ctypes or None, None)` — pass-through, no book limit.

### Current test coverage of this area
- `ingestion/test_retrieval.py` — imports `_retrieval_scope_for_mode` (L20); behavioral cases for
  sage/spell/rules/gm at L85-137.
- `service/test_service.py` — imports `_scope_for_mode`; per-mode behavioral cases at L204-260
  **and** the parity test `test_scope_mappings_agree_across_modes_and_inputs` (L387-409) whose sole
  purpose is to assert the two copies agree.
- Both run under pytest: `uv run --with pytest --with "psycopg[binary]" python -m pytest <file> -q`
  (per the docstrings). `test_service.py` also has a custom `_run()` harness (L412) but is
  pytest-discoverable.

## Decisions Resolved with the User
| Question | Decision | Rationale |
|----------|----------|-----------|
| Where does the canonical module live + name? | `ingestion/scope.py`, function `scope_for_mode` | Leaf module → breaks the cycle; `ingestion/` is already on `sys.path` everywhere the logic is used; zero packaging changes; mirrors the existing "import `retrieval`" pattern. |
| Fate of the parity test | **Delete** `test_scope_mappings_agree_across_modes_and_inputs` | With one source of truth there is nothing to compare; the per-mode behavioral tests (repointed at the shared module) remain the real coverage. |

## Constraints & Non-Goals
- **Constraint:** No `retrieval → service.rag` import — preserve the acyclic layering. The shared
  module must import nothing from the project.
- **Constraint:** Byte-identical retrieval behavior for all four modes + unrecognised input. The
  existing behavioral tests are the safety net (keep them green, repointed).
- **Constraint:** Canonical name is public `scope_for_mode`; old private names
  (`_scope_for_mode`, `_retrieval_scope_for_mode`) are removed, call sites + test imports updated.
  No back-compat alias shims (one source of truth, per AC).
- **Non-goal:** Changing any scope behavior, ctypes, book lists, or the answerability gate.
- **Non-goal:** Other epic tasks (error handling, config externalization, UI work).

## Open Risks / Assumptions Carried Forward
- **Risk:** `ingestion/scope.py` collides with nothing — verified no existing `scope.py` / `scope`
  symbol in the tree (grep clean). Low.
- **Assumption:** No external/other module imports `_scope_for_mode` or `_retrieval_scope_for_mode`
  beyond the files found by grep (service/rag.py, ingestion/retrieval.py, the two test files). Grep
  across `*.py` confirmed those are the only references.
- **Assumption:** pytest is the verification path; the DB/network are not needed (scope logic is
  pure). Confirmed by the "pure, no DB" test docstrings.

## Recommended Scope for Planning
Create `ingestion/scope.py` with the three frozensets and a single pure `scope_for_mode(mode,
query_ctypes) -> tuple[set[str] | None, set[str] | None]` (verbatim behavior). Repoint
`ingestion/retrieval.py` (drop `_retrieval_scope_for_mode`, `from scope import scope_for_mode`, call
it at the L482 site) and `service/rag.py` (drop the frozensets + `_scope_for_mode`, import the shared
function). Update test imports in `ingestion/test_retrieval.py` and `service/test_service.py` to the
shared symbol, and **delete** the parity test. TDD: characterization test on the new module first
(red→green), then refactor the two call sites with the existing behavioral suites as the regression
guard. Verify with pytest on both test files.
