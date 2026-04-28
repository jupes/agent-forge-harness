# Plan: agent-forge-harness-8ji.19 - Investigate and port skill: ubiquitous-language

## Summary

Port the upstream `ubiquitous-language` skill into a harness-native Agent Forge skill. Preserve glossary extraction, canonical terminology, ambiguity detection, relationships, and example dialogue while adapting persistence away from default file creation and toward inline output, explicit targets, `bd remember`, or `knowledge/` conventions.

## Implementation Steps

1. Inspect source and contracts - `repos/skills/ubiquitous-language/SKILL.md`, `.tmp/work/agent-forge-harness-8ji.19-alignment.md`, `.tmp/work/agent-forge-harness-8ji-interfaces.md` - confirm scope and file exclusivity.
2. Draft harness skill - `.claude/skills/ubiquitous-language/SKILL.md` - add frontmatter, triggers, process steps, persistence rules, output format, canonicalization rules, and rerun behavior.
3. Validate scope - `.claude/skills/ubiquitous-language/SKILL.md` - confirm no scripts or extra docs are needed for markdown-only guidance.
4. Run health checks - worktree root - execute `bun run typecheck` and `bun test`.

## Files to Modify

| File | Change |
|------|--------|
| None | No existing files are modified. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/ubiquitous-language/SKILL.md` | Harness-native skill guidance for extracting and maintaining a DDD-style ubiquitous language glossary. |
| `plans/drafts/agent-forge-harness-8ji.19.md` | Required feature workflow plan and validation record. |

## Test Strategy

- Unit tests for: Not applicable; this task introduces markdown-only agent guidance and no executable behavior.
- Integration tests for: Not applicable; no runtime integration is introduced.
- Edge cases: Manual inspection covers inline-first persistence, durable knowledge guidance, ambiguity handling, canonical terms, grouped glossary tables, relationships, example dialogue, and rerun updates.

## Validation Commands

```bash
bun run typecheck
bun test
```

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 30 minutes

## Interfaces (if shared with other tasks)

```typescript
// None. Interface contract agent-forge-harness-8ji defines independent markdown-only skill ports.
```
