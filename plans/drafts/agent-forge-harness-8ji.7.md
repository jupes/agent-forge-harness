# Plan: agent-forge-harness-8ji.7 - Investigate and port skill: grill-me

## Summary
Port the upstream `grill-me` skill into a harness-native Agent Forge skill. The new skill will preserve the relentless plan/design interview behavior while adding local guidance to inspect Beads, alignment docs, knowledge files, and relevant code before asking questions the agent can answer itself.

## Implementation Steps
1. Compare source behavior - `repos/skills/grill-me/SKILL.md` - identify the core interaction rules to preserve.
2. Draft the harness-native skill - `.claude/skills/grill-me/SKILL.md` - add frontmatter, usage triggers, context-gathering rules, one-question interview flow, recommended-answer format, and shared-understanding summary guidance.
3. Validate manually against the alignment criteria - `.claude/skills/grill-me/SKILL.md` - confirm every acceptance criterion is represented in the instructions.
4. Run quality gates - repository root - run TypeScript and Bun tests even though the change is markdown-only.

## Files to Modify
| File | Change |
|------|--------|
| None | This task creates a new skill and plan file only. |

## Files to Create
| File | Purpose |
|------|---------|
| `.claude/skills/grill-me/SKILL.md` | Harness-native decision-interview skill. |
| `plans/drafts/agent-forge-harness-8ji.7.md` | Required feature workflow plan and validation trace. |

## Test Strategy
- Automated unit tests: Not applicable; this task is markdown-only and introduces no exported code.
- Manual verification: Compare the new skill against `repos/skills/grill-me/SKILL.md` and the alignment acceptance criteria.
- Quality gates: Run `bun run typecheck` and `bun run test` to confirm repo health.

## Validation Commands
```bash
bun run typecheck
bun run test
```

## Estimated Scope
- Files: 2
- Complexity: Low
- Estimated time: 30 minutes

## Interfaces
No shared TypeScript interfaces. Contract file `agent-forge-harness-8ji-batch-4-interfaces.md` specifies file exclusivity only for this task.

## AC Trace
| Criterion | Verification |
|-----------|--------------|
| Source intent is preserved | Manual comparison with `repos/skills/grill-me/SKILL.md`. |
| Harness-native skill exists | `.claude/skills/grill-me/SKILL.md` includes Agent Forge frontmatter and context guidance. |
| One question per turn is explicit | Skill rules forbid multi-question batches. |
| Recommended answers are required | Skill question format requires a recommended answer for every user-facing question. |
| Code-answerable questions are researched | Skill directs agents to inspect conversation, Beads, alignment docs, knowledge, code, and tests first. |
| Shared understanding is maintained | Skill requires running summaries and final shared-understanding summaries. |
| Repo health remains green | `bun run typecheck` and `bun run test`. |
