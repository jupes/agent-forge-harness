# /forgemaster — Run the full Forge pipeline, gated phase by phase

Orchestrate the four Forge phases in order — **research → plan → implement → ship** — pausing at
every boundary to ask your approval before advancing. One feature, start to finish, with you in
control at each step.

See `.claude/workflows/forge.md` for the pipeline overview.

## Usage
```
/forgemaster <feature description>     # start a new run
/forgemaster <slug>                    # resume an in-progress run
/forgemaster                           # resume the active run in .tmp/work/forge-state.json
```

---

## Step 0 — Preflight (mandatory)

Beads is required for this pipeline. Confirm it is reachable before anything else:

```bash
bd ready >/dev/null    # if this errors, the Dolt server is down
```

If `bd` errors: run `bd dolt start`, then retry. **Do not proceed without Beads.** (The SessionStart
hook normally starts the server automatically; this is the manual recovery.)

Then determine the run:
- New feature text → derive a kebab-case `<slug>` from it and confirm with the user.
- A `<slug>` or empty input → read `.tmp/work/forge-state.json` to find the active run and which
  phases are already complete. Resume at the first incomplete phase.

---

## Step 1 — Walk the phases

For each phase in order — `research`, `plan`, `implement`, `ship` — do this loop:

1. **Gate entry.** Run `bun run forge:phase-gate <phase> --slug <slug>`. If it exits non-zero, the
   prerequisite artifact is missing — stop and tell the user which earlier phase to run.
2. **Announce.** Tell the user which phase is starting and where its output will land
   (see the table in `.claude/workflows/forge.md`).
3. **Run the phase** by following its skill end to end:
   - research → `.claude/skills/forge-research/SKILL.md`
   - plan → `.claude/skills/forge-plan/SKILL.md`
   - implement → `.claude/skills/forge-implement/SKILL.md`
   - ship → `.claude/skills/forge-ship/SKILL.md`
   The phase records its own completion (`forge:phase-gate <phase> --slug <slug> --write`).
4. **Show the exit artifact.** Surface what the phase produced (the research/plan/ship doc, the
   demoed checkpoints, the PR) so the user can inspect it.
5. **Gate the transition.** Use `AskUserQuestion` to ask whether to proceed to the next phase:
   - **Proceed** → continue to the next phase.
   - **Revise this phase** → re-run the current phase skill with the user's feedback.
   - **Stop here** → end the run; the state file preserves progress for later resumption.

   Never auto-advance across a phase boundary. The pause is the point.

---

## Step 2 — Finish

After the ship phase records complete:
- Confirm `reports/<slug>-ship.md` and the PR exist.
- The Stop exit hook goes quiet automatically once ship is complete.
- Summarize the whole run: the slug, the four artifacts, the Beads epic/feature closed, and the PR.

---

## Notes

- **Within a phase**, the implement phase still pauses at its own demo/test checkpoints — those are
  finer-grained stops than the phase boundaries this command gates.
- **Resuming**: `/forgemaster <slug>` (or bare `/forgemaster`) picks up at the first incomplete
  phase recorded in `.tmp/work/forge-state.json`.
- **One run at a time**: the state file tracks a single active `<slug>`. Finish or remove it before
  starting an unrelated feature, or the phase-gate will refuse a slug mismatch.
- **Standalone phases**: you can always run a single phase directly (`/forge-plan <slug>`) instead of
  the full orchestration; the same gates apply.
