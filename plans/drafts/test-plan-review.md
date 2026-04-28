# Plan: test-plan-review — QA fixture for Plan review UI

## Summary

Synthetic plan used to verify draft view, diff vs `plans/committed/`, and git history in the dashboard. **Rev4:** stress-test — large block removed (replaced with short line) so deletions appear in diffs.

**Iteration 2:** Draft-only edit — `plans/committed/` still matches v1 so “Diff vs committed” should show adds here.

## Checklist (v1)

- [x] Fourth commit: rev4 edits (try **From** parent commit **To** working tree in History)

## Notes

- Baseline copy at `plans/committed/test-plan-review.md` is still **v1** — use for “Diff vs committed”.
- **History (git):** in Plan review, set **History file** to **`plans/drafts/test-plan-review.md`** (not `committed`). The draft has **four** commits (rev1–rev4); the committed path only has the **single** v1 import commit, so its history table shows one revision instead of four.
