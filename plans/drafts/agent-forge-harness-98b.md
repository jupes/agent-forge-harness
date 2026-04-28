# Plan: agent-forge-harness-98b — Hook and workflow to add AGENTS.md at repo root and up to 2 folders deep

## Summary
Add a reusable script that scans directories up to depth 2, validates `AGENTS.md` presence, and optionally scaffolds missing files. Wire this into a Cursor SessionStart hook and document an Agent Forge workflow so teams can run the same validation/scaffold process consistently.

## Implementation Steps
1. Add `AGENTS.md` scan + scaffold script — `scripts/agents-md.ts` — support validate/scaffold modes and hook-friendly output.
2. Add focused unit tests — `scripts/agents-md.test.ts` — cover directory selection depth, missing detection, and scaffold rendering.
3. Register script alias — `package.json` — add `agents-md` command for workflow/hook ergonomics.
4. Wire SessionStart hook — `.claude/settings.json` — run AGENTS validation at session start.
5. Add workflow doc — `.claude/workflows/agents-md.md` — codify validate/scaffold process for root + depth 2 directories.

## Files to Modify
| File | Change |
|------|--------|
| `package.json` | Add `agents-md` script command. |
| `.claude/settings.json` | Add SessionStart hook command for AGENTS validation. |

## Files to Create
| File | Purpose |
|------|---------|
| `scripts/agents-md.ts` | Validate/scaffold `AGENTS.md` files for depth-limited directories. |
| `scripts/agents-md.test.ts` | Unit tests for depth filters and scaffold behavior. |
| `.claude/workflows/agents-md.md` | Agent Forge workflow for AGENTS.md scaffolding and validation. |

## Test Strategy
- Unit tests for depth inclusion and exclusion rules.
- Unit tests for validation result on missing files.
- Unit tests for scaffold output format and determinism.
- Run full repo gates after changes: typecheck, lint, tests.

## Validation Commands
```bash
bun test scripts/agents-md.test.ts
bun run typecheck
bun run lint
bun test
```

## Estimated Scope
- Files: 5
- Complexity: Medium
- Estimated time: 60 minutes
