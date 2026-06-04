# /forge-implement — Forge Phase 3: Implement

Execute the plan's Beads tasks with red-green-refactor TDD, pausing at each checkpoint so you can run
a live demo or test and see the work yourself.

## Usage
```
/forge-implement <slug>
```

## What to do

Follow **`.claude/skills/forge-implement/SKILL.md`** in full. In short:

1. Gate the start: `bun run forge:phase-gate implement --slug <slug>` (requires `plans/drafts/<slug>.md`).
2. Claim the next Beads task (`bd update <id> --claim`); work in dependency order, one at a time.
   `bd` must be reachable — if it errors, run `bd dolt start` and retry.
3. Per behavior, follow `.claude/skills/tdd/SKILL.md` **vertically**: one failing test → minimal code →
   repeat. Refactor only when green.
4. At each checkpoint, **stop and show the user** the exact command/URL to run and the expected
   result (or note `(no live demo)` and point to the passing tests). Wait before the next checkpoint.
5. Commit per checkpoint with tests; close the Beads task with test evidence.
6. When done: `bun run typecheck && bun run lint && bun test`, clean tree, then
   `bun run forge:phase-gate implement --slug <slug> --write`.

## Next
`/forge-ship <slug>` — or `/forgemaster` continues.
