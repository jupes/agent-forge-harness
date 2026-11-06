# Plan: <slug> — <feature title>
Generated: <date>
Repo: <repo>
Phase: plan (2/4) — from plans/research/<slug>.md

## Summary
<~100 tokens: what is being built, why, the approach>

## Existing Code to Reuse
- `path` — <how it is reused> (from research)

## TDD Strategy (red-green-refactor)
Following .claude/skills/tdd. Behaviors are tested through public interfaces, vertically.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | <observable behavior> | `x.test.ts` | yes |
| 2 | <observable behavior> | `x.test.ts` | no |

Refactor watch-list (after green): <duplication / deep-module opportunities>.

## Build Sequence & Checkpoints
### Checkpoint A — <name>
Label: `complexity:<low|medium|high>`
Steps:
1. <step> — `path` — <change>
2. <step> — `path` — <change>
Demo: `bun test path/x.test.ts` (or `bun run dev` → /route) — user sees <observable result>.

#### Files
<!-- This task's file map: one glob per line, relative to the repository root. Replace ** with the paths this task touches. -->
**

### Checkpoint B — <name>
Label: `complexity:<low|medium|high>`
...
Demo: `(no live demo)` — internal refactor, verified by tests only.

#### Files
<!-- Replace ** with the paths this task touches. -->
**

## Files to Create / Modify
| File | Create/Modify | Purpose |
|------|---------------|---------|

## Validation Commands
```bash
bun run typecheck
bun test <paths>
```

## Beads Issue Map
| Beads ID | Type | Title | Depends on | Priority | Complexity |
|----------|------|-------|-----------|----------|------------|

## Estimated Scope
- Files: <n new / n modified>; Complexity: Low|Medium|High; Checkpoints: <n>
