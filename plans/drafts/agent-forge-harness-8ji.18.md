# Plan: agent-forge-harness-8ji.18 - Investigate and port skill: triage-issue

## Summary

Port the upstream `repos/skills/triage-issue` workflow into an Agent Forge skill that investigates a reported problem, finds root cause, designs behavior-first RED/GREEN fix cycles, and files durable follow-up work in Beads by default.

## Implementation Steps

1. Compare source and harness patterns - `repos/skills/triage-issue/SKILL.md`, `.claude/skills/tdd/SKILL.md`, `.claude/skills/to-issues/SKILL.md` - preserve the core triage flow while adapting tracker and process language.
2. Create skill - `.claude/skills/triage-issue/SKILL.md` - add frontmatter, use cases, knowledge-first diagnosis, Beads priority requirements, issue body template, and TDD planning rules.
3. Validate scope - changed files only - confirm no real issue was created, no executable behavior was added, and no placeholder task tracking appears in changed markdown.
4. Run health checks - worktree root - execute `bun run typecheck` and `bun test`.

## Files to Modify

| File | Change |
|------|--------|
| None | This task creates a new harness-native skill and its plan. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/triage-issue/SKILL.md` | Beads-first bug triage skill preserving upstream root-cause investigation and TDD fix planning. |
| `plans/drafts/agent-forge-harness-8ji.18.md` | Required feature workflow plan and validation record. |

## Test Strategy

- Manual inspection: compare against upstream source for capture, diagnosis, root-cause analysis, TDD fix plan, and issue filing.
- Manual inspection: confirm Beads is the default tracker and priority assignment skill is required before issue creation or re-triage.
- Manual inspection: confirm guidance is behavior-level and avoids fragile line/path-specific issue descriptions.
- Automated repo health: run `bun run typecheck` and `bun test` because this markdown-only port should not break existing TypeScript or tests.

## Validation Commands

```bash
bun run typecheck
bun test
```

## Estimated Scope

- Files: 2
- Complexity: Low
- Estimated time: 30 minutes

## Interfaces

No shared TypeScript interfaces. The batch contract marks this as an independent markdown-only skill port.
