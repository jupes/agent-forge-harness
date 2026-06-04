# /forge-ship — Forge Phase 4: Ship

Summarize the whole run — what shipped, Beads closed, before/after, and a runnable test walkthrough —
then run quality gates, push, and open the PR with that summary as its body.

## Usage
```
/forge-ship <slug>
```

## What to do

Follow **`.claude/skills/forge-ship/SKILL.md`** in full. In short:

1. Gate the start: `bun run forge:phase-gate ship --slug <slug>` (requires implement complete).
2. Gather facts: `git log`/`git diff --stat` for this run; confirm every planned Beads task is
   closed (or deferred with a reason). `bd` must be reachable — if it errors, run `bd dolt start`.
3. Write `reports/<slug>-ship.md`: what shipped, before→after table, work done, Beads completed
   table, and a **Test It Yourself** walkthrough with exact commands + expected output.
4. `bun run typecheck && bun run lint && bun test`; clean tree; `git pull --rebase`; push.
5. `gh pr create --base <base> --body "$(cat reports/<slug>-ship.md)"`.
6. Close the epic/feature; `bd dolt push`; `bun run forge:phase-gate ship --slug <slug> --write`.

For the underlying push/PR mechanics, this reuses the patterns in `.claude/commands/ship.md`.

## Done
The forge run is complete. Report the PR URL and the single most representative command from the
walkthrough so the user can try it.
