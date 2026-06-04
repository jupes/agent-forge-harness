# /forgemaster — Route by complexity, then run the Forge pipeline gated phase by phase

Judge the complexity of the request, **route** to the right-sized Forge path, then run it gated —
pausing at each boundary for your approval. Medium-or-higher work runs the full four-phase pipeline
(**research → plan → implement → ship**); low-complexity work is handed to the trimmed
`forge-mini` path to save turns and cost. You stay in control at every step.

See `.claude/workflows/forge.md` (full) and `.claude/workflows/forge-mini.md` (mini) for details.

## Usage
```
/forgemaster <feature description>     # judge complexity, route, run
/forgemaster <slug>                    # resume an in-progress full run
/forgemaster                           # resume the active run in .tmp/work/forge-state.json
/forgemaster --full <description>      # force the full pipeline (skip the complexity check)
/forgemaster --mini <description>      # force the mini path (skip the complexity check)
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
  phases are already complete. Resume at the first incomplete phase (this is always a **full** run;
  skip the triage below and go to Step 1).

---

## Step 0.5 — Complexity triage & route

Pick the right-sized path **before** doing real work — running the full pipeline on a one-file
change wastes turns and money (cost is the whole point of this step).

- `--full` / `--mini` flag present → honor it, skip the judgment.
- Resuming an existing full run → stay full.
- Otherwise judge complexity from cheap signals (a quick look, not a research project): aligns with
  the tiers in `.claude/commands/go.md` and the model-tier rubric in
  `.claude/protocols/model-tier-policy.md`.

| Signal | → Mini | → Full |
|--------|--------|--------|
| Files touched | ≤ ~3 | > 3 |
| New architecture / component / system | no | yes |
| Genuine unknowns or design decisions | ≤ 1 | several |
| Scope clarity | clear from the ask + code | ambiguous, needs investigation |
| Cross-cutting / shared interfaces | no | yes |

**Default when uncertain: ask, don't assume.** Use `AskUserQuestion` to state your read and the
recommended route, letting the user confirm or override:

- **Mini** → follow `.claude/workflows/forge-mini.md` (scope → build → wrap). Do **not** use the
  `forge:phase-gate` / `forge-state.json` or write `plans/`/`reports/` docs; track in Beads only.
  Then go straight to that workflow — the phase-walk below is for the full path.
- **Full** → derive/confirm the `<slug>` and continue to Step 1.

If a mini run outgrows its size mid-flight, escalate to full (`/forge-research <slug>`) as described
in `forge-mini.md`.

---

## Step 1 — Walk the phases *(full path)*

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
