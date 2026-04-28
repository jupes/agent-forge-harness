# Draft Plan: agent-forge-harness-8ji.6

## Task

Port the upstream `github-triage` skill into Agent Forge as a harness-native skill under `.claude/skills/github-triage/`.

## Source Material

- `repos/skills/github-triage/SKILL.md`
- `repos/skills/github-triage/AGENT-BRIEF.md`
- `.tmp/work/agent-forge-harness-8ji.6-alignment.md`
- `.tmp/work/agent-forge-harness-8ji-batch-6-interfaces.md`

## Scope

Allowed files from the batch-6 contract:

- `.claude/skills/github-triage/SKILL.md`
- `.claude/skills/github-triage/references/AGENT-BRIEF.md`
- `plans/drafts/agent-forge-harness-8ji.6.md`

No shared TypeScript interfaces are produced or consumed. This is a markdown-only skill port.

## Port Decisions

- Preserve the upstream GitHub-specific workflow instead of converting it into Beads triage. The skill explicitly says GitHub Issues are the source of truth when this skill is invoked.
- Keep `gh` as the required GitHub interface and document read-only commands separately from label/comment/close mutations.
- Preserve the label state machine, including the one-state-label and one-category-label invariant.
- Preserve issue overview, specific issue triage, bug reproduction, needs-info comments, ready-for-agent briefs, quick overrides, and session resumption.
- Move the durable agent brief guidance into `references/AGENT-BRIEF.md` and link to it from `SKILL.md`.
- Include the required AI disclaimer at the top of all GitHub comments or issues created by the agent.

## Verification Plan

- Inspect the new docs against the upstream `SKILL.md` and `AGENT-BRIEF.md`.
- Confirm no GitHub mutation commands are run during this port.
- Run `bun run typecheck`.
- Run `bun run test`.
