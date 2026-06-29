# Ship Report: rag-chat-service-typesafety — Service type-safety + validation + cleanup pass
Shipped: 2026-06-28
Epic/Feature: agent-forge-harness-02t.5 (parent epic 02t) · Branch: refactor/02t.5-service-typesafety · PR: _pending_

## What Shipped
A correctness + clarity pass over the rag-chat FastAPI service. The two untyped surfaces
(`SecondaryResult`, the LLM `client`) now carry real types; mode handling is fail-fast instead of
silently scoping-as-sage then crashing at response build; empty prompts are refused before any
retrieval/LLM work; dead code (`GROUNDED_PROMPT`, nine custom `_run()` test harnesses) is gone; a
case-folding dedup bug is fixed; and **all 34 pre-existing ruff findings are cleared** (`ruff check
service ingestion` is now clean). 227 tests pass (221 baseline + 6 new); net −102 lines.

## Before → After
| Area | Before | After |
|------|--------|-------|
| `SecondaryResult` types | `chunks: list`, `full_texts: dict`, `book_by_id: dict` (untyped) | `list[RetrievedChunk]`, `dict[str, str]`, `dict[str, str]` |
| LLM `client` param | untyped `client=None` | minimal structural `LLMClient` Protocol (on `generate_answer` + `RagService.llm_client`) |
| Invalid mode (non-API caller) | silently scoped as sage, then a late `ValueError` at response build → 500 after wasted retrieval | validated at the top of `answer()` → clear `ValueError` **before** retrieval |
| Empty / whitespace prompt | flowed into retrieval + LLM | short-circuits to REFUSAL (`answerable=False`) with no retrieval/LLM call |
| Empty context to `generate_answer` | silently called the LLM | defensive `ValueError` (unreachable in normal flow past the grounding gate) |
| `build_sources` dedup | `.lower()` key merged distinct-cased entities (one dropped) | case-sensitive key keeps "Fireball" and "fireball" as two Sources |
| `GROUNDED_PROMPT` | dead constant kept "for backward compatibility" (test-only import) | removed |
| Test runners | 9 files carried dead `_run()`/`__main__` blocks | removed (pytest is the runner) |
| Lint | 34 ruff findings (E702/F401/E741/E701/F841) | `ruff check service ingestion` → All checks passed |

## Work Done
- Checkpoint A — type `SecondaryResult` + add minimal `LLMClient` Protocol on `generate_answer` and `RagService` (`9dcae8a`)
- Checkpoint B — validate mode at the top of `RagService.answer`; raise `ValueError` on unknown before retrieval; reuse `mode_enum` (`887d18b`)
- Checkpoint C — empty-prompt guard → REFUSAL in `answer()`; defensive empty-context `ValueError` in `generate_answer` (`59fbb2c`)
- Checkpoint D — remove dead `GROUNDED_PROMPT` constant + its test import (`dc53128`)
- Checkpoint E — make `build_sources` dedup case-sensitive (drop `.lower()`) (`e8d1a21`)
- Checkpoint F — remove 9 `_run()` harnesses; extract `_fake_completion` test helper; repoint `test_eval_golden` to `ingestion.retrieval`; rename ambiguous `l` vars; clear all ruff findings (`0a1f191`)

## Beads Completed
| Beads ID | Title | Status |
|----------|-------|--------|
| 02t.5 | [rag-chat][service] Type-safety + validation + cleanup (parent) | closed |
| 02t.5.1 | A: typed SecondaryResult + LLMClient Protocol | closed |
| 02t.5.2 | B: mode validation raises early | closed |
| 02t.5.3 | C: empty-prompt guard + defensive context guard | closed |
| 02t.5.4 | D: remove dead GROUNDED_PROMPT | closed |
| 02t.5.5 | E: case-sensitive build_sources dedup | closed |
| 02t.5.6 | F: remove _run harnesses + ruff clean | closed |

## Test It Yourself (walkthrough)
From `repos/rag-chat`:

1. **New behavior tests** (the two guards + dedup):
   ```bash
   uv run --with '.[test]' python -m pytest service/test_service.py \
     -k "unknown_mode or empty or distinct_cased" -q
   ```
   Expect: all pass — invalid mode raises before retrieval, empty prompt refuses, distinct-cased
   entities both kept.
2. **Full suite**:
   ```bash
   uv run --with '.[test]' python -m pytest -q
   ```
   Expect: `227 passed`.
3. **Lint is clean**:
   ```bash
   uv run --with ruff ruff check service ingestion
   ```
   Expect: `All checks passed!`.

## Follow-ups / Known Gaps
- **None for this task.** All planned checkpoints shipped; all 34 ruff findings cleared.
- Sibling 02t tech-debt work remains open (02t.3 config externalize, 02t.8/02t.9 UI, 02t.10 UI polish)
  — independent tasks, not gated by this one.
