# Plan: agent-forge-harness-8ji.14 - Investigate and port skill: setup-pre-commit

## Summary

Port the upstream `setup-pre-commit` skill into Agent Forge as markdown-only guidance. The new skill should preserve Husky, lint-staged, Prettier, conditional typecheck/test, verification, and smoke-test guidance while avoiding any actual repo configuration changes during this task.

## Implementation Steps

1. Compare source intent - `repos/skills/setup-pre-commit/SKILL.md` - capture the setup sequence and safety requirements.
2. Create harness skill - `.claude/skills/setup-pre-commit/SKILL.md` - write package-manager-aware, non-interactive guidance for Bun, pnpm, yarn, and npm.
3. Validate scope - git status and diff - confirm only the allowed markdown files changed and no package/config/hook files were mutated.
4. Run quality gates - worktree root - run `bun run typecheck` and `bun run test`.

## Files to Modify

| File | Change |
|------|--------|
| `.claude/skills/setup-pre-commit/SKILL.md` | New harness-native guidance-only skill for pre-commit setup. |
| `plans/drafts/agent-forge-harness-8ji.14.md` | Required feature plan and validation trace. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/setup-pre-commit/SKILL.md` | Agent skill entrypoint for safe Husky/lint-staged/Prettier setup guidance. |
| `plans/drafts/agent-forge-harness-8ji.14.md` | Plan artifact required by the feature workflow. |

## Test Strategy

- No unit tests are needed because this is a markdown-only guidance port with no executable code.
- Manual verification will compare the skill against the source for Husky, lint-staged, Prettier, conditional scripts, verification, and smoke-test coverage.
- Repository health will be checked with `bun run typecheck` and `bun run test` from the isolated worktree.

## Validation Commands

```bash
bun run typecheck
bun run test
git status --short
```

## Acceptance Criteria Trace

| Criterion | Verification |
|-----------|--------------|
| Source intent is preserved | Manual comparison with `repos/skills/setup-pre-commit/SKILL.md`. |
| Harness-native skill exists | Inspect `.claude/skills/setup-pre-commit/SKILL.md`. |
| Package-manager guidance is conditional | Inspect package-manager detection and command tables for Bun, pnpm, yarn, and npm. |
| Existing scripts/configs are respected | Inspect preflight, hook composition, and config-preservation steps. |
| Port does not mutate repo config | `git status --short` shows only allowed markdown files. |
| Repo health remains green | `bun run typecheck` and `bun run test`. |

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 30 minutes

## Interfaces

No shared TypeScript interfaces. File exclusivity comes from `agent-forge-harness-8ji-batch-3-interfaces.md`.
