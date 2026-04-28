# Plan: agent-forge-harness-8ji.10 - Investigate and port skill: obsidian-vault

## Summary

Port the upstream `obsidian-vault` skill into a harness-native Agent Forge skill. Preserve the note-management workflow while replacing the private vault default and shell-oriented search examples with explicit vault-root safety and Cursor-native tools.

## Implementation Steps

1. Source review - `repos/skills/obsidian-vault/SKILL.md` - compare upstream workflow for search, note creation, wikilinks, index notes, backlinks, and index discovery.
2. Skill port - `.claude/skills/obsidian-vault/SKILL.md` - create local skill frontmatter and harness-native guidance for safe Obsidian vault operations.
3. Validation - `.claude/skills/obsidian-vault/SKILL.md` - manually verify acceptance criteria and run repository health checks.

## Files to Modify

| File | Change |
|------|--------|
| None | No existing files need modification. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/obsidian-vault/SKILL.md` | Harness-native Obsidian vault skill instructions. |
| `plans/drafts/agent-forge-harness-8ji.10.md` | Feature workflow plan and validation record. |

## Test Strategy

- Unit tests for: not applicable; this is a markdown-only skill port with no runtime code.
- Integration tests for: not applicable; no Obsidian plugin, helper script, or vault mutation is in scope.
- Edge cases: manually verify no private path is presented as a default, writes outside the repo require explicit vault-root confirmation, and the original search/create/manage/index/backlink workflow is preserved.

## Validation Commands

```bash
bun run typecheck
bun run test
```

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 20 minutes

## Interfaces

No shared interfaces. The batch contract defines this as an independent markdown-only skill port.

## AC Trace Matrix

| Criterion | Verification |
|-----------|--------------|
| Source intent is preserved | Manual comparison against `repos/skills/obsidian-vault/SKILL.md`. |
| Harness-native skill exists | Inspect `.claude/skills/obsidian-vault/SKILL.md`. |
| Vault writes are safe | Confirm skill requires explicit vault root and confirmation before outside-repo writes. |
| Private path is not universalized | Confirm the upstream private path is not included as a default. |
| Cursor-native tooling is preferred | Confirm guidance uses `Glob`, `rg`, and `ReadFile`. |
| Scope is proportional | Confirm only markdown skill and plan files were added. |
| Repo health remains green | Run `bun run typecheck` and `bun run test`. |
