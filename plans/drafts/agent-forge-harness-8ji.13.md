# Plan: agent-forge-harness-8ji.13 - Investigate and port skill: scaffold-exercises

## Summary

Port the upstream `scaffold-exercises` skill into a harness-native Agent Forge skill. Preserve the original exercise structure guidance while replacing repo-specific assumptions with conditional validation based on the owning repository's docs.

## Implementation Steps

1. Compare upstream source - `repos/skills/scaffold-exercises/SKILL.md` - preserve section/exercise naming, variants, readme rules, optional `main.ts`, lint expectations, and rename flow.
2. Create skill - `.claude/skills/scaffold-exercises/SKILL.md` - add local frontmatter, Agent Forge preflight guidance, Beads/worklog conventions, scoped filesystem guidance, conditional validation, and safe rename instructions.
3. Validate scope - `git diff --name-only` - confirm only this plan and the scaffold skill changed, aside from Beads worklog metadata.
4. Run repo health checks - worktree root - run `bun run typecheck` and `bun run test`.

## Files to Modify

| File | Change |
|------|--------|
| None | This task creates a new harness-native skill and draft plan. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/scaffold-exercises/SKILL.md` | Harness-native scaffold-exercises skill instructions. |
| `plans/drafts/agent-forge-harness-8ji.13.md` | Required feature workflow plan and verification notes. |

## Test Strategy

This is markdown-only guidance, so no unit or integration tests are added. Verification is manual comparison against the upstream skill plus repository health checks.

Edge cases to verify manually:

- Default variant remains `explainer/` when the plan omits variants.
- Multi-variant exercises preserve `explainer`, `problem`, and `solution`.
- `main.ts` is optional for readme-only stubs and conditional on local repo requirements.
- `pnpm ai-hero-cli internal lint` is conditional, not universal.
- Rename guidance includes `git mv`, reference/link updates, and validation.

## Validation Commands

```bash
bun run typecheck
bun run test
git diff --name-only
```

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 30 minutes

## Interfaces

No shared TypeScript interfaces. Contract file states this is an independent markdown-only skill port.

## AC Trace Matrix

| Criterion | Verification |
|-----------|--------------|
| Source intent is preserved | Manual comparison with `repos/skills/scaffold-exercises/SKILL.md`. |
| Harness-native skill exists | Inspect `.claude/skills/scaffold-exercises/SKILL.md` frontmatter and Agent Forge guidance. |
| Commands are adaptable | Confirm validation uses owning repo checks and keeps `pnpm ai-hero-cli internal lint` conditional. |
| Safe rename guidance exists | Confirm rename section covers `git mv`, reference/link updates, and validation. |
| Scope is proportional | Confirm no scripts or tests are added for markdown-only content. |
| Repo health remains green | Run `bun run typecheck` and `bun run test` from the worktree. |
