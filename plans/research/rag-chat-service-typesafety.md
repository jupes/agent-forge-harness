# Research: rag-chat-service-typesafety — Service type-safety + validation + cleanup pass
Generated: 2026-06-28
Repo: rag-chat
Phase: research (1/4)
Bead: agent-forge-harness-02t.5 (parent epic 02t)

## Goal
Tidy the rag-chat FastAPI service for correctness and clarity: add real types to the untyped
`SecondaryResult` dataclass and the LLM `client` param, make mode handling consistent (no silent
default that then crashes at response build), guard empty inputs, delete dead code
(`GROUNDED_PROMPT`, the custom `_run()` test harnesses), fix a case-folding dedup bug, and clear the
34 pre-existing ruff findings. Pure quality refactor — externally observable behavior is unchanged
except the two new explicit guards (invalid mode, empty prompt).

## What the Code Says (answered by exploration)

### Base / branch
Built on **master** (PR #7 merged 2026-06-29 — packaging + mode-scope now on master). Work branch:
`refactor/02t.5-service-typesafety` off master. Tests: `uv run --with '.[test]' python -m pytest -q`
(217 passing on master baseline + 4 error-mapping = 221).

### Item 1 — Untyped `SecondaryResult` — `service/rag.py:29-35`
```python
@dataclass
class SecondaryResult:
    chunks: list = field(default_factory=list)
    full_texts: dict = field(default_factory=dict)
    book_by_id: dict = field(default_factory=dict)
    answerable: bool = False
```
From `_merge_results` (`rag.py:69-95`): `full_texts`/`book_by_id` are keyed by `chunk_id` (str) → text/book
(str); `chunks` are `RetrievedChunk`. **Types:** `list[RetrievedChunk]`, `dict[str, str]`, `dict[str, str]`.
`RetrievedChunk` is exported from `ingestion.retrieval` (already imported there as `RagRetriever, RetrievalResult`).

### Item 2 — Untyped LLM `client` — `service/generate.py:97-100`
`generate_answer(..., client=None)` calls `client.chat.completions.create(model, messages, temperature)`
and reads `resp.choices[0].message.content` (`generate.py:111-119`). The `client` is an OpenAI-like
object injected for tests. **Plan:** a minimal structural `LLMClient` Protocol (nested
`chat.completions.create(...) -> response`) kept deliberately small; response typed loosely (the SDK
return shape is large). Same Protocol typed onto `RagService.__init__(llm_client=...)` (`rag.py:60,66`).

### Item 3 — Mode handling inconsistency — `service/rag.py:97-132`, `service/app.py:78-99`, `models.py:10-19`
- API boundary already validates: `ChatRequest.mode: ChatMode` (pydantic enum) → invalid mode = **422**
  (test `test_chat_invalid_mode_422`). `app.py:81` calls `svc.answer(..., mode=req.mode.value)` — always valid.
- But `RagService.answer(mode: str = "sage")` is loosely typed. Internally `scope_for_mode(unknown)`
  silently behaves like sage (`ingestion/test_scope.py::test_unrecognised_mode_behaves_like_sage`),
  while `ChatMode(mode)` at response build (`rag.py:114,121,131`) **raises ValueError** on unknown.
  So a non-API caller passing a bad mode gets a 500 at the end, after doing retrieval work.

### Item 4 — Empty-input path — `service/rag.py:97`, `service/generate.py:97`
- `ChatRequest.prompt` has `min_length=1` (`models.py:18`) → API can't send empty prompt; a direct
  `RagService.answer("")` caller can. No guard today.
- `generate_answer` is only reached **after** the grounding gate (`rag.py:111/118` returns REFUSAL when
  `not result.chunks`), so empty `context` is unreachable in normal flow — a guard there is purely defensive.

### Item 5 — Dead `GROUNDED_PROMPT` — `service/generate.py:21-29`
Commented "Legacy constant kept for backward compatibility." **Confirmed only two references:** its
definition and `service/test_service.py:15` (`from service.generate import ... GROUNDED_PROMPT`). No
runtime use. `_GROUNDING_SUFFIX` + `PERSONA_PROMPTS` + `GROUNDED_TEMPLATE` are the live prompt path.

### Item 6 — Case-folding dedup — `service/generate.py:83`
`key = (c.entity_name or c.section or c.chunk_id).lower()` — lowercasing means two chunks whose entity
names differ only by case collapse to one Source (the later one is dropped). Bead flags this as
dropping distinct-cased entities.

### Item 7 — Custom `_run()` test harnesses — 9 test files
`service/test_app.py`, `service/test_service.py`, and 7 `ingestion/test_*.py` carry an
`if __name__ == "__main__": _run(...)` block that hand-runs the tests + `sys.exit`. These are dead
under pytest and hold the bulk of the lint (see below).

### Item 8 — Lint baseline (ruff, service + ingestion)
34 findings: **16 E702** (semicolons in `_run` blocks), **12 F401** (unused imports), **3 E741**
(ambiguous names in harness/loops), **2 E701**, **1 F841**. Removing the `_run` harnesses (item 7)
clears the E702/E701/E741 cluster (~21); the rest is `ruff --fix` for unused imports + the one unused var.

### Current test coverage
~221 pytest functions across 11 files; `service/test_service.py` (mocked RagService) and
`service/test_app.py` (TestClient, incl. mode-422 + error-mapping) cover the answer path. New behavior
(invalid-mode raise, empty-prompt REFUSAL) needs new tests; the dedup fix needs a distinct-cased test.

## Decisions Resolved with the User
| Question | Decision | Rationale |
|----------|----------|-----------|
| Invalid mode reaching `answer()` | **Raise early, explicitly** — coerce to `ChatMode` at the top of `answer()`, raise a clear `ValueError` on unknown | Fail-fast surfaces the programming error; API still 422s real users; ends the scope-vs-response inconsistency |
| Custom `_run()`/`__main__` harness blocks (9 files) | **Remove all** | pytest is the runner; dead code; clears ~21 of 34 lint findings |
| Empty-input guard scope | **Service-side only** — guard empty `prompt` in `answer()` → REFUSAL; defensive check in `generate_answer`; leave `ingestion/retrieval.py` untouched | Keeps PR focused; API already enforces `min_length=1` |
| `GROUNDED_PROMPT` (low-stakes, proceeding) | **Remove** + drop the test import/assertion | Dead code (test-only); CLAUDE.md forbids dead code |
| `build_sources` dedup `.lower()` (low-stakes, proceeding) | **Drop `.lower()`** (case-sensitive dedup) | Per bead intent; preserves genuinely distinct-cased entities; case-collision in D&D names is negligible |

## Constraints & Non-Goals
- **Constraint:** externally observable API behavior unchanged except the two new guards (invalid mode
  → still 422 at API; empty prompt → REFUSAL). The 221-test suite must stay green.
- **Constraint:** keep the OpenAI lazy import in `generate_answer` (heavy SDK, deferred by design).
- **Non-goal:** the LangGraph migration (3t2), externalizing tuning constants (02t.3, separate),
  touching `ingestion/retrieval.py` internals, and UI work.
- **Non-goal:** a full typing overhaul — the `LLMClient` Protocol is intentionally minimal, not a
  complete model of the OpenAI SDK surface.

## Open Risks / Assumptions Carried Forward
- **`LLMClient` Protocol depth** (implementation call, not a user question): model only
  `chat.completions.create(...)`; response typed loosely (`Any`-ish) to avoid mirroring the SDK. If a
  stricter return type is wanted later, it can be tightened.
- **Removing `_run` blocks** also removes each file's `sys.exit`, so some now-unused `import sys` lines
  drop out — fold those into the F401 cleanup so no new unused imports appear.
- **Dedup change** is a behavior tweak: a test that currently relies on case-folding (if any) could
  shift; verify against the suite and add a distinct-cased test.

## Recommended Scope for Planning
A single service-focused refactor on `refactor/02t.5-service-typesafety`: (1) type `SecondaryResult`
and add a minimal `LLMClient` Protocol used by `generate_answer` + `RagService`; (2) validate/normalize
mode at the top of `answer()` (raise `ValueError` on unknown) and guard empty `prompt` → REFUSAL, with
a defensive empty-context check in `generate_answer`; (3) delete `GROUNDED_PROMPT` (and its test
reference); (4) make `build_sources` dedup case-sensitive; (5) delete the 9 `_run()`/`__main__` harness
blocks and `ruff --fix` the remaining F401/F841 so `ruff check service ingestion` is clean. TDD: new
tests for invalid-mode-raises, empty-prompt-REFUSAL, and distinct-cased-entities-both-kept; the
existing 221 stay green. Verify with the full pytest run + `ruff check`.
