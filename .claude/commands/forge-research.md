# /forge-research — Forge Phase 1: Research

Investigate a feature against the real codebase, answer everything the code can answer, and grill the
user (one question at a time, with a recommended answer) for only what code cannot. Produces a
research document the plan phase consumes.

## Usage
```
/forge-research <feature description>
/forge-research <slug>            # resume/redo research for an existing slug
/forge-research <feature> --smith <name>   # record the run as built by a configured smith
```

## What to do

Follow **`.claude/skills/forge-research/SKILL.md`** in full. In short:

1. State the target and pick a kebab-case `<slug>` (reused by every later phase).
2. Explore first: `knowledge/`, `bd show <id>`, then real code (Glob/Grep/Read). Record what the
   code answers — never ask the user something the code already settles.
3. Grill the user one question at a time for the genuine unknowns (product intent, scope, UX,
   external systems), each with a recommended answer and reason. Prefer `AskUserQuestion` for
   closed choices.
4. Write `plans/research/<slug>.md`.
5. Record completion: `bun run forge:phase-gate research --slug <slug> --write --bead <task-id>`.
   `<task-id>` is the issue the run was started from, when that is a task, a bug or a chore. Omit
   `--bead` when the run was started from free text, a feature or an epic: no task exists until the
   plan phase creates one, and a feature or an epic is named only when the run closes it
   (`.claude/workflows/forge.md`, *Which bead a phase names*).

Beads must be reachable for `bd show`; if `bd` errors, run `bd dolt start` and retry — do not skip it.

`--smith <name>` records the run as built by that configured smith: add it to the `forge:phase-gate` call of step 5. It does
not change the model of this session (`.claude/workflows/forge.md`, *`--smith`*).

## Next
`/forge-plan <slug>` — or `/forgemaster` continues the pipeline.
