---
name: forge-implement
description: Phase 3 of the Forge pipeline. Execute the plan's Beads tasks with red-green-refactor TDD, committing per checkpoint and pausing at each natural stopping point so the user can run a live demo or test and see the work themselves. Use when starting /forge-implement or the implement step of /forgemaster.
---

# forge-implement

Phase 3 of 4 in the Forge pipeline (research → plan → **implement** → ship). Input is the plan and
Beads graph from [[forge-plan]]; output is working, tested, committed code — built in observable
increments.

The defining rule of this phase: **stop at every checkpoint and let the user see it run.** Do not
silently barrel through the whole plan.

## When to Use

- The user runs `/forge-implement <slug>` or `/forgemaster` enters its implement phase.
- A `plans/drafts/<slug>.md` with checkpoints and a Beads issue map exists.

## Prerequisites

```bash
bun run forge:phase-gate implement --slug <slug>    # verifies the plan artifact exists
cat plans/drafts/<slug>.md                          # the build sequence + checkpoints
bd ready                                             # the tasks created in the plan phase
```

Beads must be reachable. If `bd` errors (e.g. Dolt server down), **stop** and fix it
(`bd dolt start`) — do not proceed without issue tracking.

**`--smith <name>`**: when the run was started with it, add `--smith <name>` to every
`forge:phase-gate` call in this skill. The phase gate refuses a name that is not configured and
records the smith on the run as its executor. It does not change the model of the session doing the
work (`.claude/workflows/forge.md`, *`--smith`*).

## Process

### 1. Claim the first task

```bash
bd update <task-id> --claim     # sets assignee + status=in_progress (atomic, idempotent)
bd comments add <task-id> "worklog: starting implement (forge)"
```

Work tasks in dependency order. One task in progress at a time.

**Stay inside the task's file map.** The `## Files` section of the task's description lists the
globs this task may touch (the plan phase wrote it: `.claude/skills/forge-plan/SKILL.md`). Read it
as it is stored:

```bash
bd show <task-id> --json | bun run scripts/scheduler/filemap-cli.ts - --bd-json   # prints the task's globs
```

Do not read the map off plain `bd show <task-id>`: that renders the description as Markdown, and a
glob that holds `*` comes out garbled (`scripts/forge/**/*.ts` is printed as
`**scripts/forge/****/*.ts`).

Edit only files those globs match. The map is what the task said it would touch, and the review of
this phase reads the diff against it. Nothing reserves files from it yet; it is kept honest now so
that file reservations can be taken from it later.

When the work needs a file outside the map, do not edit it silently and do not stop either. Say so,
then go on:

```bash
bd comments add <task-id> "worklog: outside the file map: <path> — <why this task has to touch it>"
```

Add the path to the task's `## Files` section too, and name it when you show the checkpoint. Work on
the description as it was written, never on what plain `bd show` printed. Save the stored one to a
file, add the line, check the file, then store it:

```bash
bd show <task-id> --json | bun -e 'const issue = JSON.parse(await Bun.stdin.text()); await Bun.write(process.argv[1], [issue].flat()[0].description)' .tmp/work/<task-id>-description.md
# edit .tmp/work/<task-id>-description.md: one more line under "## Files"
bun run scripts/scheduler/filemap-cli.ts .tmp/work/<task-id>-description.md      # exit 0: the map is usable
bd update <task-id> --body-file .tmp/work/<task-id>-description.md
```

A task whose description has no `## Files` section has no map to hold to (the first command of this
section says `no Files section`): say that in the first `worklog:` comment.

**Keep Beads current as you work** (do not batch all updates to the end):
- `--claim` moves the task `open → in_progress` — claim it *before* writing code, not after.
- Add a `worklog:` comment at each checkpoint and at any notable decision or pivot, so the issue
  reflects real progress: `bd comments add <task-id> "worklog: checkpoint A green — <demo cmd>"`.
- If a task gets stuck on something external, set `bd update <task-id> --status blocked` and add a
  `deps:` comment naming the blocker; file a new Beads issue for the blocker rather than going quiet.

### 2. Red-green-refactor per the TDD skill

For each behavior in the plan's TDD Strategy, follow `.claude/skills/tdd/SKILL.md` **vertically**:

```
RED:   write ONE test for the next behavior → it fails
GREEN: write the minimal code to pass → it passes
```

- One test at a time. Only enough code to pass the current test. No speculative features.
- Start with the tracer-bullet behavior to prove the path end-to-end.
- After the checkpoint's tests are green, **refactor** (extract duplication, deepen modules) and
  re-run tests. Never refactor while red.

Run `bun run typecheck` after each step and fix immediately.

### 3. Stop at the checkpoint — show the user

When a checkpoint's tests are green and typecheck passes, **pause** and give the user something to
run. This is the heart of the phase:

```
✅ Checkpoint <A> complete: <what now works>

See it yourself:
  <exact command> — e.g. `bun test <path>` or `bun run dev` → http://localhost:5173/<route>
Expected: <what they should observe>

Commit: <sha> — <message>
```

- If the checkpoint has a runnable surface, give the **exact** command/URL and the expected result.
- If the plan marked the checkpoint `(no live demo)`, say so and point to the passing tests as the
  evidence instead.
- Then ask whether to continue to the next checkpoint. Do not start the next checkpoint until the
  user has had the chance to look (under `/forgemaster` this gate is explicit).

### 4. Commit and close per checkpoint

```bash
git add <specific files for this checkpoint>
git commit -m "feat(<scope>): <checkpoint summary>

Refs: <task-id>"

# Close the task only with test evidence
bd comments add <task-id> "worklog: <behaviors> green; demo: <command>; tested: yes"
bd close <task-id>
```

Each closed task should map to something the user saw run. Commit tests alongside code (the quality
gate requires test files in recent commits).

### 5. Loop

Repeat steps 1–4 for each task/checkpoint until `bd ready` shows no remaining plan tasks.

### 6. Phase quality gate + hand off

```bash
bun run typecheck
bun run lint
bun test
git status --porcelain          # should be empty
bun run forge:phase-gate implement --slug <slug> --write --bead <task-id>    # records implement complete
```

`<task-id>` is the issue the run was started from (a task, a bug or a chore), else the last task
this phase closed. The command prints `data.correlation.pointer`: the ship step runs the quality
gate with it, so that gate result is tied to this run and that task (`.claude/workflows/forge.md`,
*Which bead a phase names*).

Report the checkpoints completed and the tasks closed, then point to `/forge-ship <slug>`
(or `/forgemaster` continues).

## Hard Stops

- A checkpoint balloons past its planned scope (>8 files or >~200 lines), or keeps leaving its file
  map: pause and report; consider splitting the Beads task before continuing.
- A behavior cannot be tested through the public interface: revisit the interface design with the
  user (see `.claude/skills/tdd/interface-design.md`) rather than testing implementation details.
- Quality gate fails twice after fixes: stop, file a Beads bug, escalate.

## Exit Criteria

- [ ] Every plan checkpoint reached green and was demoed (or marked `(no live demo)` with tests).
- [ ] Every plan Beads task closed with test evidence.
- [ ] typecheck + lint + tests pass; working tree clean.
- [ ] Forge state advanced to `implement` complete.
