# Plan: agent-forge-harness-8ji.2 - Investigate and port skill: design-an-interface

## Summary

Port `repos/skills/design-an-interface/SKILL.md` into a harness-native Agent Forge skill at `.claude/skills/design-an-interface/SKILL.md`.

The upstream intent is preserved: gather requirements, generate at least three radically different interface designs, present them sequentially, compare trade-offs, and synthesize a recommendation. The harness adaptation adds explicit Beads, alignment, knowledge, existing-pattern, and contract context before design work begins, while keeping implementation out of scope.

## Source Intent

The upstream skill is based on "Design It Twice" from *A Philosophy of Software Design*. Its core behavior is:

- Understand the module boundary and callers before designing.
- Generate multiple radically different designs, preferably in parallel.
- Present each design with signature, usage, hidden complexity, and trade-offs.
- Compare alternatives on interface simplicity, general-purpose shape, implementation efficiency, depth, and ease of correct use versus misuse.
- Synthesize the best shape without implementing it.

## Harness Adaptation

Agent Forge needs this design workflow to respect existing orchestration context before proposing new public shapes:

- Read task alignment from `.tmp/work/` when present.
- Inspect Beads issue scope and acceptance criteria with `bd show <id>`.
- Load `knowledge/_shared.yaml` and the relevant `knowledge/repos/<repo>.yaml`.
- Check existing local patterns before inventing a new API or command surface.
- Treat interface contract files as authoritative when present.
- Use subagents when helpful, but allow self-generated alternatives when subagents are unavailable.
- Stop at recommendation and verification planning; implementation starts only as separate tracked work.

## Files

| File | Change |
|------|--------|
| `.claude/skills/design-an-interface/SKILL.md` | New harness-native design skill preserving upstream workflow and evaluation criteria |
| `plans/drafts/agent-forge-harness-8ji.2.md` | Durable plan and AC trace for the skill port |

## Acceptance Criteria Trace

| Criterion | Evidence |
|-----------|----------|
| Source intent preserved | Skill keeps requirement gathering, 3+ alternatives, sequential presentation, comparison, synthesis, and anti-implementation boundary |
| Harness-native skill exists | Skill frontmatter uses Agent Forge skill layout under `.claude/skills/design-an-interface/SKILL.md` |
| 3+ design alternatives required | Workflow requires at least three radically different designs and says variants of the same design do not count |
| No implementation during design | Skill states not to edit implementation files, add tests, scaffold code, or proceed past recommendation |
| Repo health | Validate with `bun run typecheck` and `bun run test` |

## Validation Commands

```bash
bun run typecheck
bun run test
```

## Contract

`agent-forge-harness-8ji-batch-6-interfaces.md` defines no shared TypeScript interfaces for this task. File exclusivity allows only:

- `.claude/skills/design-an-interface/SKILL.md`
- `plans/drafts/agent-forge-harness-8ji.2.md`
