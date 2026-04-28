# Plan: agent-forge-harness-8ji.12 - Investigate and port skill: request-refactor-plan

## Summary

Port the upstream `request-refactor-plan` skill into a harness-native Agent Forge skill. The result will preserve the source skill's rigorous refactor-planning workflow while using Beads as the default durable tracker and avoiding brittle exact file paths or code snippets in issue bodies.

## Context Loaded

- Alignment: `.tmp/work/agent-forge-harness-8ji.12-alignment.md`
- Contract: `.tmp/work/agent-forge-harness-8ji-batch-4-interfaces.md`
- Workflow: `.claude/workflows/feature.md`
- Shared knowledge: `knowledge/_shared.yaml`
- Relevant repo knowledge: `knowledge/repos/skills.yaml`
- Source skill: `repos/skills/request-refactor-plan/SKILL.md`
- Local patterns: `to-prd`, `to-issues`, `tdd`, and `authoring-agent-skills`

## Implementation Steps

1. Create `.claude/skills/request-refactor-plan/SKILL.md` with Agent Forge frontmatter and Beads-first routing.
2. Preserve the upstream interview, repo verification, alternatives, exact scope/non-scope, test assessment, tiny working commit plan, and durable issue template.
3. Adapt durable issue creation to `bd create` with explicit priority and `--repo` guidance.
4. Add guardrails that durable issue bodies use stable module/interface/behavior language rather than exact file paths or code snippets.
5. Run repository quality checks requested by the task.

## Files

Create `.claude/skills/request-refactor-plan/SKILL.md` and `plans/drafts/agent-forge-harness-8ji.12.md`. No existing files should be modified.

## Test Strategy

- Automated tests: no new code paths or scripts are introduced, so no unit tests are required.
- Manual verification: inspect the skill for each acceptance criterion from the alignment document.
- Repo health: run `bun run typecheck` and `bun run test`.

## Validation Commands

```bash
bun run typecheck
bun run test
```

## Estimated Scope

Files: 2. Complexity: Low. Estimated time: 30 minutes. No shared TypeScript interfaces; the batch contract defines this as an independent markdown-only skill port.

## AC Trace

| Criterion | Verification |
|-----------|--------------|
| Source rigor preserved | Interview, repo verification, alternatives, scope, testing, tiny increments, and template are present. |
| Harness native | Local frontmatter, Agent Forge guidance, and Beads-first issue creation are present. |
| Durable and safe | Knowledge-first exploration, explicit priority, working increments, and no exact file paths/code snippets in issue bodies are required. |
| Repo health | Verify with `bun run typecheck` and `bun run test`. |
