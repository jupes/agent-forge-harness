# Plan: agent-forge-harness-8ji.11 - Investigate and port skill: qa

## Summary
Port upstream `repos/skills/qa/SKILL.md` into an Agent Forge-native skill that keeps the conversational QA flow, background context gathering, issue-breakdown judgment, durable issue templates, and session continuation while replacing GitHub-first filing with Beads.

## Implementation Steps
1. Compare source intent against the alignment criteria and interface contract.
2. Create `.claude/skills/qa/SKILL.md` with local frontmatter and a Beads-first conversational QA workflow.
3. Verify the skill requires priority selection, durable user-facing issue bodies, Beads dependency links, and the continuation prompt.
4. Run `bun run typecheck` and `bun run test`.

## Files to Modify
| File | Change |
|------|--------|
| `plans/drafts/agent-forge-harness-8ji.11.md` | Plan and AC trace. |

## Files to Create
| File | Purpose |
|------|---------|
| `.claude/skills/qa/SKILL.md` | Harness-native QA session skill. |

## Test Strategy
- Unit tests: Not applicable; this is a markdown-only skill port.
- Integration tests: Not applicable; no runtime behavior was added.
- Manual verification: Compare against upstream `repos/skills/qa/SKILL.md` and the alignment AC.

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
None. The contract says these are independent markdown-only skill ports.

## AC Trace
| Criterion | Verification |
|-----------|--------------|
| Source intent preserved | Skill keeps light clarification, background exploration, breakdown logic, templates, and continuation. |
| Harness-native skill exists | `.claude/skills/qa/SKILL.md` has Agent Forge frontmatter and conventions. |
| Beads default tracker | Skill uses `bd create`, not a GitHub-first path. |
| Priority explicit | Skill requires `.claude/skills/beads-priority-assignment/SKILL.md`. |
| Durable issues | Skill forbids paths, lines, and internal names as primary evidence. |
| Breakdown maps to deps | Skill uses `bd dep add <blocker-id> --blocks <blocked-id>`. |
| Session continuation | Skill asks "Next issue, or are we done?" after filing. |
| Repo health | `bun run typecheck` and `bun run test`. |
