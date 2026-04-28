# Plan: test-plan-review — QA fixture for Plan review UI

## Summary

Synthetic plan used to verify draft view, diff vs `plans/committed/`, and git history in the dashboard.

**Iteration 2:** Draft-only edit — `plans/committed/` still matches v1 so “Diff vs committed” should show adds here.

## Checklist (v1)

- [ ] Open Plan review with `bun run dashboard`
- [ ] Confirm this file appears in the plan picker
- [x] Second commit: draft updated, committed baseline unchanged

## Notes

- Baseline copy lives at `plans/committed/test-plan-review.md` (same id).
- **History (git):** use branch `drafts` — expect multiple commits after seeding.
