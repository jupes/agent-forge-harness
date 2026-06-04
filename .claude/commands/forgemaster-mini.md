# /forgemaster-mini — Trimmed Forge pipeline for small tasks

Run the **low-ceremony** Forge path for small, clear-scope work (bugs, chores, config, single-file
changes). Same Beads + TDD discipline as the full pipeline, but collapsed into three lightweight
steps — scope → build → wrap — with far fewer turns, gates, and artifacts to keep cost down.

Use this directly when you already know the task is small. For anything medium-or-higher, use
`/forgemaster` (which can also auto-route here).

## Usage
```
/forgemaster-mini <task description>
/forgemaster-mini <beads-id>            # run mini against an existing issue
```

## What to do

Follow **`.claude/workflows/forge-mini.md`** in full. In short:

1. **Preflight** — `bd ready >/dev/null`; if it errors, `bd dolt start` and retry. Beads is required.
2. **Scope** — read only the touched files; ask **at most one** decision question (lead with the
   plain-language *why*, then options); state the approach inline; create/reuse + `--claim` one
   Beads task (priority via `.claude/skills/beads-priority-assignment/SKILL.md`). Confirm the
   approach once.
3. **Build** — TDD via `.claude/skills/tdd/SKILL.md` (vertical slices) for code; one runnable demo;
   `worklog:` comment; commit with tests.
4. **Wrap** — quality gates, close the task with evidence, push (+ PR if warranted), `bd dolt push`,
   and report inline: what changed, how to verify, Beads id + PR link.

No `plans/` or `reports/` doc files and no `forge:phase-gate`/`forge-state.json` — tracking lives in
Beads. **Escalate** to the full pipeline (`/forge-research <slug>`) if the work outgrows "mini".
