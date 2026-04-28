# Plan: agent-forge-harness-8ji.8 - improve-codebase-architecture
## Summary
Port the upstream skill into Agent Forge as markdown-only guidance. Preserve its deepening-opportunity workflow and architecture vocabulary while replacing `CONTEXT.md` and ADR assumptions with `knowledge/`, Beads comments, and existing ADR discovery.
## Implementation Steps
1. Create `.claude/skills/improve-codebase-architecture/SKILL.md` as the harness-native process.
2. Create `references/LANGUAGE.md`, `DEEPENING.md`, and `INTERFACE-DESIGN.md` from the upstream references.
3. Verify the port against the agreed AC and run repo health checks.
## Files
| File | Purpose |
|------|---------|
| `.claude/skills/improve-codebase-architecture/SKILL.md` | Skill entrypoint and Agent Forge process. |
| `.claude/skills/improve-codebase-architecture/references/LANGUAGE.md` | Required architecture vocabulary. |
| `.claude/skills/improve-codebase-architecture/references/DEEPENING.md` | Deepening, deletion test, seams, and test guidance. |
| `.claude/skills/improve-codebase-architecture/references/INTERFACE-DESIGN.md` | Post-selection interface-design handoff. |
| `plans/drafts/agent-forge-harness-8ji.8.md` | Plan and AC trace. |
## Test Strategy
No automated tests are added because this is documentation-only. Verification is manual source comparison plus `bun run typecheck` and `bun run test`.
## Validation Commands
```bash
bun run typecheck
bun run test
```
## Scope And AC Trace
Files: 5. Complexity: Low. Shared interfaces: none; contract is file exclusivity only. Source intent, vocabulary, candidate flow, interface deferral, and harness-native context are verified by manual source comparison and inspection. Repo health is verified by the validation commands.
