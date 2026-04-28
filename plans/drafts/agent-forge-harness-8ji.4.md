# Plan: agent-forge-harness-8ji.4 - Investigate and port skill: edit-article

## Summary

Port the upstream `edit-article` skill into a harness-native markdown skill. The port keeps the original order: identify heading-based sections, reason about main points and information dependencies, confirm the section plan with the user, then rewrite one section at a time for clarity, coherence, and flow.

## Implementation Steps

1. Compare upstream source - `repos/skills/edit-article/SKILL.md` - verify the required sectioning, dependency, confirmation, rewrite, and paragraph-limit behavior.
2. Create harness skill - `.claude/skills/edit-article/SKILL.md` - add frontmatter, use cases, guardrails, ordered workflow, and output expectations.
3. Verify acceptance criteria - `.claude/skills/edit-article/SKILL.md` - manually inspect that the confirmation gate, DAG ordering, section-by-section rewrite, and 240-character paragraph limit are explicit.

## Files to Modify

| File | Change |
|------|--------|
| `plans/drafts/agent-forge-harness-8ji.4.md` | Add this implementation plan and validation trace. |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/edit-article/SKILL.md` | Harness-native port of the upstream article-editing workflow. |

## Test Strategy

- Unit tests for: not applicable; this is a markdown-only skill with no executable code.
- Integration tests for: not applicable; no CLI, hook, script, or runtime integration is added.
- Manual verification: compare against upstream `repos/skills/edit-article/SKILL.md` and trace each acceptance criterion in the alignment document.

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

No shared TypeScript interfaces. The batch contract identifies this as an independent markdown-only skill port.

## AC Trace Matrix

| Criterion | Verification |
|-----------|--------------|
| Source intent is preserved | Manual comparison with `repos/skills/edit-article/SKILL.md`. |
| Harness-native skill exists | `.claude/skills/edit-article/SKILL.md` has harness skill frontmatter and process sections. |
| Dependency ordering is preserved | Workflow maps information dependencies as a DAG before proposing order. |
| User confirmation is required | Workflow stops before rewriting until the user approves the breakdown and order. |
| Section-by-section rewrite is preserved | Workflow rewrites one approved section at a time. |
| Paragraph limit is explicit | Workflow requires every rewritten paragraph to be 240 characters or fewer. |
| Repo health remains green | Run `bun run typecheck` and `bun run test`. |
