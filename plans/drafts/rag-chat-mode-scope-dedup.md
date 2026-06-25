# Plan: rag-chat-mode-scope-dedup — Consolidate duplicated mode→scope mapping
Generated: 2026-06-25
Repo: rag-chat (`repos/rag-chat`)
Phase: plan (2/4) — from plans/research/rag-chat-mode-scope-dedup.md
Beads: agent-forge-harness-02t.1 (child of epic agent-forge-harness-02t)

## Summary
Extract the mode→scope mapping (three frozensets + the per-mode `(effective_ctypes, allowed_books)`
logic) into one leaf module `ingestion/scope.py` exposing `scope_for_mode`. Repoint the single
production consumer (`ingestion/retrieval.py`) and delete the dead duplicate in `service/rag.py`.
The shared module imports nothing from the project, so it breaks the `retrieval ↔ rag` cycle the
duplication originally dodged. Behavior is frozen; the existing per-mode behavioral tests (repointed)
are the regression net, and the now-pointless parity test is deleted.

## Existing Code to Reuse
- `ingestion/retrieval.py:424-458` `_retrieval_scope_for_mode` — the canonical behavior to lift
  verbatim into the new module (this copy is what runs in production).
- `ingestion/test_retrieval.py:81-137` + `service/test_service.py:204-260` — behavioral scope tests;
  repoint their imports at the shared module, no logic change. They become the regression guard.
- The `sys.path.insert(.../ingestion)` already present in `service/rag.py:15`,
  `service/test_service.py:16`, `ingestion/test_retrieval.py:17` — `ingestion/scope.py` is importable
  as `from scope import scope_for_mode` in all three with zero new wiring. Inside `retrieval.py`
  itself the import resolves by **same-directory** lookup (`scope.py` sits next to `retrieval.py` in
  `ingestion/`), so no sys.path setup is needed there either.

## Key finding refining the research
`service/rag.py` **defines** `_scope_for_mode` but never calls it — `RagService.answer` delegates
retrieval (and thus scoping) to `retrieval.py`. The service copy is dead except for its tests.
DRY outcome: **delete** it from `rag.py` (do not re-import the shared fn there — nothing in `rag.py`
needs it); only the tests move to the shared module. AC "both paths use it" is satisfied by the one
real consumer (retrieval); there is no second runtime consumer to wire.

## TDD Strategy (red-green-refactor)
Following .claude/skills/tdd. Behaviors tested through the public `scope_for_mode` interface,
vertically. The mapping is a pure function → a truth-table characterization test is the right shape.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | `scope_for_mode("spell", …)` forces `{"spell"}` ctype and restricts to the spell-book set | `ingestion/test_scope.py` | yes |
| 2 | `scope_for_mode("rules", q)` returns `q ∩ rules-allowlist` (or full allowlist if empty), books None | `ingestion/test_scope.py` | no |
| 3 | `scope_for_mode("gm", q)` returns `q ∪ forced-creative-ctypes`, books None | `ingestion/test_scope.py` | no |
| 4 | `scope_for_mode("sage" / unrecognised, q)` passes `q or None` through, books None | `ingestion/test_scope.py` | no |
| 5 | Shared fn output equals the pre-refactor values for the full mode × query-ctype matrix (regression) | `ingestion/test_scope.py` | no |
| 6 | `retrieval.py` still scopes correctly after repoint (existing suite green) | `ingestion/test_retrieval.py` | no |
| 7 | `service` scope tests green against the shared module; refusal/persona behavior unchanged | `service/test_service.py` | no |

Tracer bullet: behavior #1 — the first test that proves the new module exists, imports cleanly, and
returns the expected tuple shape end-to-end.

Refactor watch-list (after green): ensure no stray `_scope_for_mode` / `_retrieval_scope_for_mode`
references remain (grep clean); confirm no new import cycle (`scope.py` imports only stdlib/typing).

## Build Sequence & Checkpoints

### Checkpoint A — Shared module + characterization tests (red → green)
Steps:
1. Write `ingestion/test_scope.py` — truth-table tests for behaviors #1-5 (imports `from scope
   import scope_for_mode`). **Red:** module does not exist yet.
2. Create `ingestion/scope.py` — module docstring, the three frozensets
   (`_SPELL_BOOKS`, `_RULES_CTYPES`, `_GM_FORCED_CTYPES`), and pure
   `scope_for_mode(mode, query_ctypes) -> tuple[set[str] | None, set[str] | None]` lifted verbatim
   from `retrieval._retrieval_scope_for_mode`. Imports only `from __future__ import annotations`.
Demo: `cd repos/rag-chat && uv run --with pytest python -m pytest ingestion/test_scope.py -q`
— user sees the new module's tests go green.

### Checkpoint B — Repoint the production consumer (refactor, stay green)
Steps:
1. `ingestion/retrieval.py` — delete `_retrieval_scope_for_mode` (L424-458) and its inlined
   frozensets; add `from scope import scope_for_mode` (after the sys.path/env setup near the top);
   change the call site at L482 to `scope_for_mode(mode, ctypes)`. Update the L479-481 comment
   (no longer "we duplicate the logic here").
2. `ingestion/test_retrieval.py` — change the import at L20 from `_retrieval_scope_for_mode` to
   `scope_for_mode` (from `scope`) and update the 4 call sites (L85-137).
Demo: `cd repos/rag-chat && uv run --with pytest --with "psycopg[binary]" python -m pytest ingestion/test_retrieval.py -q`
— user sees retrieval scope tests green against the shared module.

### Checkpoint C — Delete the dead service copy + parity test (refactor, stay green)
Steps:
1. `service/rag.py` — delete the three frozensets (L28-39) and `_scope_for_mode` (L42-76). No new
   import needed (rag.py has no scope call site). Keep the `# Mode → retrieval scope mapping` header
   only if other content remains; otherwise remove it.
2. `service/test_service.py` — change scope-test imports (L205-258) from
   `from service.rag import _scope_for_mode` to `from scope import scope_for_mode`; update call
   sites. **Delete** the parity test `test_scope_mappings_agree_across_modes_and_inputs` (function
   L387-409) **together with** its section-header comment block (L381-385) — there is one source of
   truth now, so both the test and the "logic is duplicated…" comment are obsolete.
Demo: `cd repos/rag-chat && uv run --with pytest --with "psycopg[binary]" python -m pytest service/test_service.py ingestion/test_retrieval.py ingestion/test_scope.py -q`
— full affected suite green; `grep -rn "_scope_for_mode\|_retrieval_scope_for_mode"` returns nothing.

## Files to Create / Modify
| File | Create/Modify | Purpose |
|------|---------------|---------|
| `ingestion/scope.py` | Create | Canonical frozensets + `scope_for_mode` (leaf module, no project imports) |
| `ingestion/test_scope.py` | Create | Characterization/truth-table tests for the shared fn |
| `ingestion/retrieval.py` | Modify | Drop local copy; import + call `scope_for_mode` |
| `ingestion/test_retrieval.py` | Modify | Repoint import at shared module |
| `service/rag.py` | Modify | Delete dead frozensets + `_scope_for_mode` |
| `service/test_service.py` | Modify | Repoint scope tests; delete parity test |

## Validation Commands
```bash
cd repos/rag-chat
# Per-checkpoint demos (above), then the full affected suite:
uv run --with pytest --with "psycopg[binary]" python -m pytest \
  ingestion/test_scope.py ingestion/test_retrieval.py service/test_service.py -q
# Drift gone — must print nothing:
grep -rn "_scope_for_mode\|_retrieval_scope_for_mode" --include=*.py .
```

## Beads Issue Map
Proportional process: this is a Low-complexity, single-concern refactor (1 new module, 5 edits).
The existing task **agent-forge-harness-02t.1** is the tracker; checkpoints A-C are tracked in this
plan rather than split into separate beads (each is ~minutes and the demos map 1:1 to the checkpoint
list above). 02t.1 closes when all three checkpoints are green and the drift grep is clean.

| Beads ID | Type | Title | Depends on | Priority |
|----------|------|-------|-----------|----------|
| agent-forge-harness-02t.1 | task | Consolidate duplicated mode→scope mapping into one shared module | — | P1 |

## Estimated Scope
- Files: 2 new / 4 modified; Complexity: **Low**; Checkpoints: 3.
- Risk: low — behavior frozen, pure function, comprehensive existing tests repointed as the guard.
