# agent-forge-harness-8ji.5 - git-guardrails-claude-code

## Scope

Port upstream `git-guardrails-claude-code` into Agent Forge as a guidance-only skill.

Allowed implementation files from the batch-6 contract:

- `.claude/skills/git-guardrails-claude-code/SKILL.md`
- `.claude/skills/git-guardrails-claude-code/references/block-dangerous-git.sh.md`
- `plans/drafts/agent-forge-harness-8ji.5.md`

## Source Material

- Upstream `git-guardrails-claude-code/SKILL.md`
- Upstream `git-guardrails-claude-code/scripts/block-dangerous-git.sh`
- Alignment: `.tmp/work/agent-forge-harness-8ji.5-alignment.md`
- Contract: `.tmp/work/agent-forge-harness-8ji-batch-6-interfaces.md`

## Implementation Plan

1. Create a harness-native `SKILL.md` that preserves upstream intent while stating that this port does not install hooks by default.
2. Preserve the upstream shell hook content in a markdown reference file, not as an executable script.
3. Document project/global scope choice, settings merge behavior, customization, and verification using sample JSON input.
4. Verify repository health with `bun run typecheck` and `bun run test`.

## Acceptance Criteria Mapping

- Source intent preserved: upstream blocked patterns, scope choice, merge guidance, customization, and verification flow are represented.
- No real hook installed: only markdown files are added; no `.claude/hooks/` files or settings files are changed.
- Safety guidance preserved: dangerous command patterns and expected blocked behavior are documented.
- Repo health: run requested Bun checks after edits.

