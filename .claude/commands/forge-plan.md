# /forge-plan — Forge Phase 2: Plan

Turn a research document into a TDD- and Beads-shaped implementation plan with demo-able checkpoints.

## Usage
```
/forge-plan <slug>
/forge-plan <slug> --smith <name>   # record the run as built by a configured smith
```

## What to do

Follow **`.claude/skills/forge-plan/SKILL.md`** in full. In short:

1. Gate the start: `bun run forge:phase-gate plan --slug <slug>` (requires `plans/research/<slug>.md`).
2. Read the research doc; keep the plan consistent with its decisions and non-goals.
3. Set up TDD using `.claude/skills/tdd/SKILL.md`: list behaviors to test (as specs), design testable
   interfaces, plan vertical slices, mark the tracer bullet.
4. Break work into **checkpoints** — each names a command/URL the user can run to *see* progress (or
   is explicitly `(no live demo)`).
5. Write `plans/drafts/<slug>.md`.
6. Materialize Beads: epic/feature + one task per checkpoint, with dependencies and a `--priority`
   on every issue (`.claude/skills/beads-priority-assignment/SKILL.md`). `bd` must be reachable —
   if it errors, run `bd dolt start` and retry.
7. Present the plan, get approval, then
   `bun run forge:phase-gate plan --slug <slug> --write --bead <task-id>`: the issue the run was
   started from when that is a task, a bug or a chore, else the first task the plan created. Add `--epic <id>` for the feature or epic that
   groups the tasks; never pass that one as `--bead` here (`.claude/workflows/forge.md`, *Which bead
   a phase names*).

`--smith <name>` records the run as built by that configured smith: add it to both `forge:phase-gate` calls above (steps 1 and 7). It does
not change the model of this session (`.claude/workflows/forge.md`, *`--smith`*).

## Next
`/forge-implement <slug>` — or `/forgemaster` continues.
