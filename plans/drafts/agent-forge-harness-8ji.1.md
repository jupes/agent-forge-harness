# Plan: agent-forge-harness-8ji.1 - Investigate and port skill: caveman

## Summary

Port `repos/skills/caveman/SKILL.md` into Agent Forge as `.claude/skills/caveman/SKILL.md`. Preserve upstream ultra-compressed persistent mode while clarifying safety, irreversible action, ambiguity, and multi-step clarity exceptions for this harness.

## Source and Contract

- Source: `repos/skills/caveman/SKILL.md`
- Alignment: `.tmp/work/agent-forge-harness-8ji.1-alignment.md`
- Contract: `.tmp/work/agent-forge-harness-8ji-batch-7-interfaces.md`

Batch 7 defines no shared TypeScript or runtime interfaces. This is an independent markdown-only skill port.

## Implementation

1. Create `.claude/skills/caveman/SKILL.md` with harness-native frontmatter and explicit triggers.
2. Preserve persistence: once triggered, mode stays active until the user says to stop or return to normal mode.
3. Preserve compression rules: remove filler, articles, pleasantries, hedging, and prefer compact fragments/abbreviations.
4. Preserve accuracy rules: exact code blocks, exact errors, exact technical terms, exact commands/paths/identifiers.
5. Adapt safety behavior for Agent Forge: clarity wins for security warnings, irreversible confirmations, destructive git or data operations, ambiguity, and ordered multi-step instructions.

## Acceptance Criteria Verification

| Criterion | Verification |
|-----------|--------------|
| Source intent preserved | Skill retains terse "smart caveman" behavior, token-saving compression, examples, and response pattern. |
| Persistence rules preserved | Skill states caveman mode remains active every response until "stop caveman" or "normal mode". |
| Technical accuracy preserved | Skill requires exact code blocks, errors, commands, paths, API names, schema fields, and snippets. |
| Harness-native skill exists | Skill lives under `.claude/skills/caveman/SKILL.md` with Agent Forge-specific safety guidance and explicit trigger description. |
| Repo health | Validate with `bun run typecheck` and `bun run test`. |

## Validation Commands

```bash
bun run typecheck
bun run test
```

## Contract Status

Contract: COMPLIANT. No shared interfaces required; implementation stayed within the two allowed files.
