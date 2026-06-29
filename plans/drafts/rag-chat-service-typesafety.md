# Plan: rag-chat-service-typesafety — Service type-safety + validation + cleanup pass
Generated: 2026-06-28
Repo: rag-chat
Phase: plan (2/4) — from plans/research/rag-chat-service-typesafety.md
Bead: agent-forge-harness-02t.5 (parent epic 02t)

## Summary
A service-focused quality refactor on `refactor/02t.5-service-typesafety` (off master). Add real types
to `SecondaryResult` and the LLM `client` (a minimal `LLMClient` Protocol); make mode handling
fail-fast (raise on unknown instead of silently scoping-as-sage then crashing at response build); guard
empty prompt → REFUSAL; delete dead code (`GROUNDED_PROMPT`, the 9 `_run()` test harnesses); make
`build_sources` dedup case-sensitive; and clear all 34 ruff findings. Behavior is unchanged except two
new explicit guards. The 221-test suite stays green; new tests cover each new behavior.

## Existing Code to Reuse
- `ingestion.retrieval.RetrievedChunk` (`retrieval.py:324`) — the element type for `SecondaryResult.chunks`.
- `ChatMode` enum (`models.py:10`) — already raises `ValueError` on unknown; reuse it as the validator.
- `REFUSAL` constant (`rag.py:18`) — reuse for the empty-prompt response.
- Existing mocked-`RagService` tests in `service/test_service.py` and TestClient tests in
  `service/test_app.py` — the regression net; new behavior tests slot in alongside.

## TDD Strategy (red-green-refactor)
Following `.claude/skills/tdd`, vertical slices via public interfaces. Type-only changes (A) are
refactors under green; B/C/E are red→green behavior slices; D/F are cleanup verified by the suite + ruff.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | `RagService.answer(prompt, mode="bogus")` raises `ValueError` *before* doing retrieval (not a late 500) | `service/test_service.py` | **yes** |
| 2 | `answer("")` / `answer("   ")` returns REFUSAL (`answerable=False`) without calling the retriever or LLM | `service/test_service.py` | no |
| 3 | `generate_answer(q, "")` (empty context) raises `ValueError` (defensive) | `service/test_service.py` | no |
| 4 | `build_sources` keeps two entities differing only by case as two distinct Sources | `service/test_service.py` | no |
| 5 | Typed `SecondaryResult` + `LLMClient` Protocol — existing merge/generate tests stay green (no behavior change) | existing | no |
| 6 | Suite green + `ruff check service ingestion` clean after dead-code/harness removal | all | no |

Refactor watch-list (after green): keep the OpenAI lazy import in `generate_answer`; ensure removing
`_run` blocks also drops the now-unused `import sys`/helpers so no new F401 appears.

## Build Sequence & Checkpoints

### Checkpoint A — Typed surfaces (type-only, under green)
Steps:
1. `service/rag.py` — `from ingestion.retrieval import RagRetriever, RetrievalResult, RetrievedChunk`; type `SecondaryResult`: `chunks: list[RetrievedChunk]`, `full_texts: dict[str, str]`, `book_by_id: dict[str, str]`. — `service/rag.py`
2. `service/generate.py` — add a minimal `LLMClient` Protocol (nested `chat.completions.create(...)`; response loosely typed) and type `generate_answer(..., client: LLMClient | None = None)`. — `service/generate.py`
3. `service/rag.py` — type `RagService.__init__(llm_client: LLMClient | None = None)` and the `self.llm_client` attr (import the Protocol). — `service/rag.py`

Demo: `uv run --with '.[test]' python -m pytest -q` → **221 passed** (no behavior change). — user sees the suite unaffected by the typing. `(no live behavioral demo — type-only)`

### Checkpoint B — Mode validation raises early (TRACER)
Steps:
1. RED — add `test_answer_unknown_mode_raises` (mocked retriever): `answer("x", mode="bogus")` raises `ValueError`, and the retriever mock is **not** called. — `service/test_service.py`
2. GREEN — at the top of `RagService.answer`, validate: `try: mode_enum = ChatMode(mode) except ValueError: raise ValueError(f"unknown mode: {mode!r}")` *before* `self.retriever.retrieve(...)`; reuse `mode_enum` in the `ChatResponse(...)` constructions (replacing the three `ChatMode(mode)` calls). — `service/rag.py`

Demo: `uv run --with '.[test]' python -m pytest service/test_service.py -k mode -q` → green; existing valid-mode + `test_chat_invalid_mode_422` (app) still green.

### Checkpoint C — Empty-prompt guard (+ defensive context guard)
Steps:
1. RED — `test_answer_empty_prompt_refuses`: `answer("")` and `answer("   ")` return REFUSAL (`answerable=False`, empty sources) and the retriever mock is not called. — `service/test_service.py`
2. RED — `test_generate_answer_empty_context_raises`: `generate_answer("q", "")` raises `ValueError`. — `service/test_service.py`
3. GREEN — in `answer`, after mode validation: `if not prompt.strip(): return ChatResponse(answer=REFUSAL, sources=[], answerable=False, mode=mode_enum, conversation_id=conversation_id)`. In `generate_answer`, top: `if not context.strip() or not question.strip(): raise ValueError("empty context or question")`. — `service/rag.py`, `service/generate.py`

Demo: `uv run --with '.[test]' python -m pytest service/test_service.py -k "empty" -q` → green.

### Checkpoint D — Remove dead GROUNDED_PROMPT
Steps:
1. `service/generate.py` — delete the `GROUNDED_PROMPT` constant (lines 21-29) and its comment. — `service/generate.py`
2. `service/test_service.py` — drop `GROUNDED_PROMPT` from the import on line 15 (it is an unused import; one of the F401s). — `service/test_service.py`

Demo: `uv run --with '.[test]' python -m pytest -q` → green; `grep -rn GROUNDED_PROMPT service` → no output. `(no live demo — dead-code removal)`

### Checkpoint E — Case-sensitive source dedup
Steps:
1. RED — `test_build_sources_keeps_distinct_cased_entities`: two chunks with `entity_name` "Fireball" and "fireball" → `build_sources` returns two Sources. — `service/test_service.py`
2. GREEN — `service/generate.py:83` — drop `.lower()`: `key = c.entity_name or c.section or c.chunk_id`. — `service/generate.py`

Demo: `uv run --with '.[test]' python -m pytest service/test_service.py -k dedup -q` → green; existing `build_sources` tests still green.

### Checkpoint F — Remove _run harnesses + ruff clean
Steps:
1. Delete the `def _run(): … / if __name__ == "__main__": _run()` block from all 9 test files (`service/test_app.py`, `service/test_service.py` [~376-391], and 7 `ingestion/test_*.py`); remove the now-unused `import sys` / helper names they used. — 9 files
2. `uv run --with ruff ruff check --fix service ingestion`, then hand-fix any residual F401/F841 (e.g. `ChatMode`, `StubSecondaryRetriever` unused imports flagged earlier). — various
3. Confirm zero findings. — verify

Demo: `uv run --with ruff ruff check service ingestion` → **All checks passed!**; `uv run --with '.[test]' python -m pytest -q` → green. `(no live demo — cleanup)`

## Files to Create / Modify
| File | Create/Modify | Purpose |
|------|---------------|---------|
| `service/rag.py` | Modify | Type SecondaryResult + llm_client; mode validation; empty-prompt guard |
| `service/generate.py` | Modify | LLMClient Protocol; defensive context guard; remove GROUNDED_PROMPT; case-sensitive dedup |
| `service/test_service.py` | Modify | New tests (B/C/E); drop GROUNDED_PROMPT import; remove _run block |
| `service/test_app.py` | Modify | Remove _run block |
| 7 × `ingestion/test_*.py` | Modify | Remove _run blocks + unused imports |

## Validation Commands
```bash
# From repos/rag-chat
uv run --with '.[test]' python -m pytest -q          # full suite (221 + new) green
uv run --with ruff ruff check service ingestion      # → All checks passed!
```

## Beads Issue Map
Child tasks under existing bead **agent-forge-harness-02t.5** (no duplicate epic). `bd` auto-assigns
child IDs — recorded back after creation. Sequential deps A→B→C→D→E→F.

| Checkpoint | Beads ID (assigned) | Type | Title | Depends on | Priority |
|-----------|---------------------|------|-------|-----------|----------|
| (parent) | 02t.5 | task | [rag-chat][service] Type-safety + validation + cleanup (tracking) | — | P3 |
| A | 02t.5.1 | task | Typed SecondaryResult + LLMClient Protocol | — | P3 |
| B | 02t.5.2 | task | Mode validation raises early (tracer) | 02t.5.1 | P3 |
| C | 02t.5.3 | task | Empty-prompt guard + defensive context guard | 02t.5.2 | P3 |
| D | 02t.5.4 | task | Remove dead GROUNDED_PROMPT | 02t.5.3 | P3 |
| E | 02t.5.5 | task | Case-sensitive build_sources dedup | 02t.5.4 | P3 |
| F | 02t.5.6 | task | Remove _run harnesses + ruff clean | 02t.5.5 | P3 |

## Estimated Scope
- Files: 0 new / ~12 modified; Complexity: **Low–Medium** (small, well-bounded changes; the only new
  behavior is two guards); Checkpoints: 6.
- Primary risk: removing `_run` blocks dropping a still-needed `import sys` and reintroducing an F401 —
  mitigated by the ruff gate in Checkpoint F. Secondary: the dedup change shifting an existing test —
  mitigated by running the full suite after E.
