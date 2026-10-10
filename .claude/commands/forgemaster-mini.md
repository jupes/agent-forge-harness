# /forgemaster-mini — Trimmed Forge pipeline for small tasks

Run the **low-ceremony** Forge path for small, clear-scope work (bugs, chores, config, single-file
changes). Same Beads + TDD discipline as the full pipeline, but collapsed into three lightweight
steps — scope → build → wrap — with far fewer turns, gates, and artifacts to keep cost down.

Use this directly when you already know the task is small. For anything medium-or-higher, use
`/forgemaster` (which can also auto-route here).

## Usage

Accepts the same inputs as `/forgemaster` — a **JIRA ticket**, a **Beads issue id**, or a
**free-text description**.

```
/forgemaster-mini <task description>    # free text
/forgemaster-mini <BEADS-ID>            # e.g. agent-forge-harness-f25 → run mini against that issue
/forgemaster-mini <JIRA-KEY>            # e.g. PROJ-1234 → mirror into Beads, then run mini
/forgemaster-mini <task> --smith <name> # also record the run, as built by a configured smith
```

## What to do

Follow **`.claude/workflows/forge-mini.md`** in full. In short:

1. **Preflight** — `bd ready >/dev/null`; if it errors, `bd dolt start` and retry. Beads is required.
2. **Scope** — read only the touched files; ask **at most one** decision question (lead with the
   plain-language *why*, then options); state the approach inline. **Resolve the input to one Beads
   task**: `bd show` an existing id, *mirror* a JIRA key into Beads (`--external-ref jira-<KEY>`,
   pasting the ticket if no JIRA integration is configured), or create a new task for free text —
   then `--claim` it (priority via `.claude/skills/beads-priority-assignment/SKILL.md`). Confirm the
   approach once.
3. **Build** — TDD via `.claude/skills/tdd/SKILL.md` (vertical slices) for code; one runnable demo;
   `worklog:` comment; commit with tests.
4. **Wrap** — quality gates, close the task with evidence, push (+ PR if warranted; the tracker is local-only, so no `bd dolt push`),
   and report inline: what changed, how to verify, Beads id + PR link.

No `plans/` or `reports/` doc files and no `forge:phase-gate` / run state file, unless it was given
`--smith` — tracking lives in Beads. **Escalate** to the full pipeline (`/forge-research <slug>`) if
the work outgrows "mini".

## `--smith <name>`

The mini path keeps no run state, so a `--smith` is recorded by one write at the very end. Pick a
kebab-case `<slug>` for the run, and after the wrap step's push:

1. Save the handoff you report as `reports/<slug>-ship.md`.
2. `bun run forge:phase-gate ship --slug <slug> --write --bead <task-id> --smith <name>`

That call checks the name (a smith that is not configured is refused, with the list of the ones that
are: correct it and run the call again; nothing is lost, because this session builds either way),
stores the smith on the run as its executor, and leaves a run that is already shipped, so it never
shows as in flight. `--smith` does not change the model of the session reading this command. A mini
run has no linked gate entry, with or without `--smith`: its checks are the bare
`bun run typecheck && bun run lint && bun test` of the wrap step.
