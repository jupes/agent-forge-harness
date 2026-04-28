# Plan: agent-forge-harness-8ji.3 - Investigate and port skill: domain-model

## Summary

Port the upstream `domain-model` skill into a harness-native Agent Forge skill. Preserve the source behavior of one-question-at-a-time domain grilling, recommended answers, code exploration before asking answerable questions, glossary challenges, fuzzy-term sharpening, scenario probing, code cross-references, and inline capture of resolved terms and decisions.

## Implementation Steps

1. Read source and contracts - `repos/skills/domain-model/SKILL.md`, `CONTEXT-FORMAT.md`, `ADR-FORMAT.md`, `.tmp/work/agent-forge-harness-8ji.3-alignment.md`, and the batch interface contract - to confirm scope and file exclusivity.
2. Create the harness skill - `.claude/skills/domain-model/SKILL.md` - with Agent Forge frontmatter, knowledge-first exploration, Beads-aware persistence, and optional target-repo `CONTEXT.md`/ADR support.
3. Port the context reference - `.claude/skills/domain-model/references/CONTEXT-FORMAT.md` - keeping the source glossary/context rules while adding the Agent Forge equivalent for `knowledge/` and Beads comments.
4. Port the ADR reference - `.claude/skills/domain-model/references/ADR-FORMAT.md` - keeping the minimal ADR threshold and template while adapting default persistence to Beads `design:` comments and `knowledge/`.
5. Verify no real domain docs were created - only the skill docs and this plan are added.
6. Run repository health checks: `bun run typecheck` and `bun run test`.

## Acceptance Criteria Mapping

- Source intent preserved: source docs are represented in the new skill and references.
- Harness persistence adapted: defaults use `knowledge/` and Beads `design:` / `worklog:` comments, with target-repo `CONTEXT.md` and ADR support when already present or requested.
- One-question grilling preserved: the workflow requires one question at a time, recommended answers, and code/doc exploration before asking.
- No real domain docs created: this port adds only `.claude/skills/domain-model/...` docs and this draft plan.
- Repo health: run `bun run typecheck` and `bun run test`.

## Out Of Scope

- Creating root `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/` files for this harness during the port.
- Adding executable scripts or tests for markdown-only behavior.
- Committing, pushing, or closing Beads for this worker task.
