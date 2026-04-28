# Plan: test-plan-review — QA fixture for Plan review UI

## Summary

Synthetic plan used to verify draft view, diff vs `plans/committed/`, and git history in the dashboard. **Rev3:** tightened summary and added validation steps.

**Iteration 2:** Draft-only edit — `plans/committed/` still matches v1 so “Diff vs committed” should show adds here.

## Checklist (v1)

- [ ] Open Plan review with `bun run dashboard`
- [ ] Confirm this file appears in the plan picker
- [x] Second commit: draft updated, committed baseline unchanged
- [x] Third commit: summary + checklist touched (test line diff)

## Validation steps (rev3)

1. Select plan id `test-plan-review` in the picker.
2. **Draft** tab — should show this full text (live reload on save).
3. **Diff vs committed** — green lines for everything not in baseline `plans/committed/`.
4. **History (git)** — pick `drafts`; table should list ≥3 commits; compare **From** an older SHA **To** Working tree.

## Notes

- Baseline copy lives at `plans/committed/test-plan-review.md` (same id).
- **History (git):** use branch `drafts` — expect multiple commits after seeding.
