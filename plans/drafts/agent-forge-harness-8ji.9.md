# Plan: agent-forge-harness-8ji.9 - Investigate and port skill: migrate-to-shoehorn

## Summary

Port the upstream `migrate-to-shoehorn` skill into a harness-native skill without installing dependencies or migrating this repository's tests. The port preserves the upstream test-only Shoehorn migration intent while replacing npm-only and grep-based examples with package-manager-aware install guidance and safe `rg` searches scoped to test files.

## Implementation Steps

1. Review upstream source - `repos/skills/migrate-to-shoehorn/SKILL.md` - identify required migration guidance.
2. Create harness skill - `.claude/skills/migrate-to-shoehorn/SKILL.md` - document test-only usage, install guidance, mappings, workflow, and validation.
3. Validate scope - confirm no dependency install, package changes, codemods, or test migrations were performed.

## Files to Modify

| File | Change |
|------|--------|
| None | This task creates a new skill and plan only. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/migrate-to-shoehorn/SKILL.md` | Harness-native Shoehorn migration skill. |
| `plans/drafts/agent-forge-harness-8ji.9.md` | Plan and AC trace for the port. |

## Test Strategy

- Automated unit tests: not applicable because this is a markdown-only skill port with no executable logic.
- Manual inspection: compare the generated skill against upstream source and agreed acceptance criteria.
- Repo validation: run `bun run typecheck` and `bun run test`.

## Validation Commands

```bash
bun run typecheck
bun run test
```

## AC Trace Matrix

| Criterion | Verification |
|-----------|--------------|
| Source intent is preserved | Manual comparison with `repos/skills/migrate-to-shoehorn/SKILL.md`. |
| Harness-native skill exists | Inspect `.claude/skills/migrate-to-shoehorn/SKILL.md`. |
| Test-only constraint is explicit | Skill states Shoehorn is only for tests and forbids production/source use. |
| Migration mappings are present | Skill documents `fromPartial`, `fromAny`, and `fromExact` with imports. |
| Package-manager install is conditional | Skill documents Bun, pnpm, yarn, and npm commands and lockfile selection. |
| Search is safe | Skill uses `rg` scoped to `*.test.*` / `*.spec.*` globs. |
| Repo health remains green | Run `bun run typecheck` and `bun run test`. |

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 30 minutes

## Interfaces

No shared TypeScript interfaces. Contract compliance is file exclusivity only:

- `.claude/skills/migrate-to-shoehorn/SKILL.md`
- `plans/drafts/agent-forge-harness-8ji.9.md`
