# Plan: agent-forge-harness-mk4.1 — Top-level plans/ layout and storage contract

## Summary
Define and document a harness-root `plans/` contract so plan files are durable, enumerable, and ready for review/diff UX. Keep `.tmp/work/` focused on ephemeral task wisps.

## Implementation Steps
1. Add `plans/README.md` describing layout, naming, and ownership rules.
2. Create `plans/drafts/` and `plans/committed/` scaffolding.
3. Update workflow/command/agent docs to write plan artifacts into `plans/drafts/`.
4. Update top-level docs and `.gitignore` to reflect durable plans and ignore transient draft temp files.

## Validation
- `bun run typecheck`
- `bun test`
