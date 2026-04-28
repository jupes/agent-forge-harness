# Plan: agent-forge-harness-8ji.21 - Investigate and port skill: zoom-out

## Summary

Port the upstream `zoom-out` prompt into a harness-native, markdown-only skill that helps agents step back from unfamiliar code and produce a concise architecture/context map. The skill will preserve the original request for relevant modules and callers while adding Agent Forge conventions: knowledge-first exploration, Beads/alignment awareness, callers/callees, dependencies, data/control flow, and actionable next context.

## Implementation Steps

1. Create `zoom-out/SKILL.md` - `.claude/skills/zoom-out/SKILL.md` - add harness frontmatter and a repeatable exploration workflow.
2. Keep the port markdown-only - `.claude/skills/zoom-out/SKILL.md` - omit scripts, references, generated docs, and tests because the source skill is prompt-style guidance.
3. Validate repository health - run `bun run typecheck` and `bun test` from the worktree.

## Files to Modify

| File | Change |
|------|--------|
| None | No existing files require modification. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/zoom-out/SKILL.md` | Harness-native skill entrypoint for higher-level codebase mapping. |
| `plans/drafts/agent-forge-harness-8ji.21.md` | Required feature workflow plan for this task. |

## Test Strategy

- Unit tests: Not applicable; this is a markdown-only prompt/process skill with no executable code.
- Manual verification: Compare against `repos/skills/zoom-out/SKILL.md` to confirm the higher-level mapping behavior remains central.
- Scope verification: Confirm only `.claude/skills/zoom-out/SKILL.md` and this plan file changed.

## Validation Commands

```bash
bun run typecheck
bun test
```

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 20 minutes

## Interfaces

No shared TypeScript interfaces. The interface contract only constrains file exclusivity for this markdown-only port.
