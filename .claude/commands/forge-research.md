# /forge-research — Forge Phase 1: Research

Investigate a feature against the real codebase, answer everything the code can answer, and grill the
user (one question at a time, with a recommended answer) for only what code cannot. Produces a
research document the plan phase consumes.

## Usage
```
/forge-research <feature description>
/forge-research <slug>            # resume/redo research for an existing slug
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
5. Record completion: `bun run forge:phase-gate research --slug <slug> --write`.

Beads must be reachable for `bd show`; if `bd` errors, run `bd dolt start` and retry — do not skip it.

## Next
`/forge-plan <slug>` — or `/forgemaster` continues the pipeline.
