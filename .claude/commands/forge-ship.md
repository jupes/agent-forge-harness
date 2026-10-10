# /forge-ship — Forge Phase 4: Ship

Summarize the whole run — what shipped, Beads closed, before/after, and a runnable test walkthrough —
then run quality gates, push, and open the PR with that summary as its body.

## Usage
```
/forge-ship <slug>
/forge-ship <slug> --smith <name>   # record the run as built by a configured smith
```

## What to do

Follow **`.claude/skills/forge-ship/SKILL.md`** in full. In short:

1. Gate the start: `bun run forge:phase-gate ship --slug <slug>` (requires implement complete).
2. Gather facts: `git log`/`git diff --stat` for this run; confirm every planned Beads task is
   closed (or deferred with a reason). `bd` must be reachable — if it errors, run `bd dolt start`.
3. Write `reports/<slug>-ship.md`: what shipped, before→after table, work done, Beads completed
   table, and a **Test It Yourself** walkthrough with exact commands + expected output.
4. Gate the run through its correlation, in a clean tree: `bun run quality-gate --correlation <pointer>`
   (the pointer the phase gate printed; one path per run, `.tmp/work/run-correlations/<slug>.json`).
   It must exit 0. Then `git pull --rebase`; push. A run whose work is in another repository runs
   that repository's own checks instead and has no linked gate entry.
5. Build the PR body from the canonical template (`.claude/skills/pr-description/`), mapping the
   ship report into its sections; validate with `check-pr-body.ts`; then
   `gh pr create --base <base> --body "$(cat .tmp/work/pr-body.md)"`.
6. Close the epic/feature (the tracker is local-only — no `bd dolt push`), after its
   `testing-attestation` comment; then
   `bun run forge:phase-gate ship --slug <slug> --write --bead <close-id>`, where `<close-id>` is the
   issue this run closes (a run that closes no feature or epic keeps the id of its implement write).

For the underlying push/PR mechanics, this reuses the patterns in `.claude/commands/ship.md`.

`--smith <name>` records the run as built by that configured smith: add it to both `forge:phase-gate` calls above (steps 1 and 6). It does
not change the model of this session (`.claude/workflows/forge.md`, *`--smith`*).

## Done
The forge run is complete. Report the PR URL and the single most representative command from the
walkthrough so the user can try it.
