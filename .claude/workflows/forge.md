# Forge Workflow

The guided, four-phase development pipeline. Each phase is a skill with its own command; the phases
chain through a shared `<slug>` and that run's state file at `.tmp/work/forge-runs/<slug>.json`.

```
research → plan → implement → ship
   │         │         │          │
 grill    TDD +     demo-able    summary +
 the      Beads     checkpoints  walkthrough
 unknowns  map                   + PR
```

**When to use**: any feature or non-trivial change that benefits from research-first investigation,
a TDD plan, observable incremental delivery, and a written handoff.

**Runs are concurrent.** Each run keeps its own state file, so several features can be in flight at
once — `bun run forge:runs` lists them. Give each code-touching run its own worktree
(`bun run worktree create <branch>`) and record it with `--checkout <path>` on the phase-gate write,
so two runs do not build on top of each other. A quality-gate result belongs to a run only through
that run's correlation (see *Which bead a phase names*), never through the checkout it was logged
from; `--checkout` is where the phase gate writes that correlation. The checkout a run builds in
must ignore `.tmp/`, because the correlation (and an unattended run's review verdicts) is written
under `.tmp/work/` there. This repository does; in one that does not, add `.tmp/` to the file
`git rev-parse --git-path info/exclude` prints in that checkout, before the first write.

**Two sizes — match ceremony to the work** (see `.claude/protocols/model-tier-policy.md`):

- **Full pipeline** (this file) — medium-or-higher complexity: >3 files, a new
  component/system, genuine unknowns or design decisions, or cross-cutting scope. Four gated
  phases, four artifacts.
- **Mini pipeline** (`.claude/workflows/forge-mini.md`) — low complexity: ≤~3 files, clear scope,
  no new architecture, at most one real decision. Collapses to a quick plan → TDD build with one
  demo checkpoint → brief summary, with far fewer turns/artifacts to keep cost down. Beads tracking
  and TDD still apply.

**Two ways to advance**: *gated* (a human approves each boundary) or *auto* (a fresh evaluator
subagent reviews each phase, the findings feed back, and the run advances itself). A run records
which it is, and you can switch at any time.

**Orchestration**: `/forgemaster <feature>` first judges complexity and **routes** to the full or
mini path (you can confirm or override), then runs the chosen path gated, asking approval before
advancing. `/forgemaster-auto` runs the same phases **unattended** — see
`.claude/workflows/forge-auto.md`. `/forgemaster-mini` forces the mini path; the four `/forge-*`
commands run a single full phase standalone.

---

## Phases

| # | Phase | Command | Skill | Exit artifact |
|---|-------|---------|-------|---------------|
| 1 | Research | `/forge-research <feature>` | `forge-research` | `plans/research/<slug>.md` |
| 2 | Plan | `/forge-plan <slug>` | `forge-plan` | `plans/drafts/<slug>.md` + Beads graph |
| 3 | Implement | `/forge-implement <slug>` | `forge-implement` | code, tests, closed Beads tasks |
| 4 | Ship | `/forge-ship <slug>` | `forge-ship` | `reports/<slug>-ship.md` + PR |

Each phase reads the prior phase's artifact. The `forge:phase-gate` script enforces this:

```bash
bun run forge:phase-gate <phase> --slug <slug>                       # may this phase start? (checks prereq)
bun run forge:phase-gate <phase> --slug <slug> --write --bead <id>   # record this phase complete (checks own artifact)
```

It exits non-zero (and prints `{ ok, data, error }`) when a prerequisite artifact is missing, so a
phase can never run on a missing or half-finished predecessor.

---

## Which bead a phase names

Every `--write` says which Beads issue the run is working, with `--bead <id>`. The phase gate keeps
the id on the run, stamps it on the run's ledger events, and writes the run's **correlation**: the
small file that ties a quality-gate result, and an evaluator's verdict, to this issue and this run.
The write prints where that file is as `data.correlation.pointer`. It is one path for the whole run:
`.tmp/work/run-correlations/<slug>.json`, relative to the checkout the run builds in. A write that
names no bead, on a run that never named one, prints `correlation: null`.

| Write | `--bead` | Why |
|-------|----------|-----|
| research | The issue the run was started from, when that is a task, a bug or a chore. Omit `--bead` when the run was started from free text, a feature or an epic. | Until the plan phase creates the tasks, no task exists to name. A feature or an epic goes in `--epic`, which only groups the run. |
| plan | The issue the run was started from, else the first task the plan created. | From here on, a gate that runs belongs to the task being built. |
| implement | The issue the run was started from, else the last task this phase closed. | The same. The ship step gates with the run's pointer while it still names a task. |
| ship | The issue this run closes: the feature or the epic. A run that closes neither keeps the id of its implement write. | The close. |

**A feature or an epic is named only by the ship write.** A quality gate that runs linked to a
feature or an epic demands that issue's close-testing attestation (a `testing-attestation` comment),
so a run that named one earlier would fail every gate before its close.

Three things follow from a run being able to move from one issue to the next:

- **Between writes the run keeps the last id a write gave it.** That matters only when a gate runs
  in between, which means a task handed to a spawned CLI. Move the run to that task first:
  `bun run forge:correlate --bead <task-id> --run <slug>` (add `--checkout <path>` when the run
  builds in another checkout). `forge:exec` leaves a run that names another issue alone, and its
  child's gate then runs unlinked.
- **A run has one strict verdict, and it names the issue the run was bound to when it was filed.**
  Strict verdict mode (`AGENT_FORGE_EVAL_VERDICT=strict`) is opt-in and nothing here turns it on.
  When it is on, file it in the ship step, after the implement write and before the gate
  (`.claude/commands/ship.md`): a verdict filed before a later `--bead` moved the run does not
  satisfy a gate run after it.
- **After the ship write the run names the issue it closed.** For a feature or an epic, a ship gate
  repeated after that write is a gate on that issue: it needs the attestation comment, and in strict
  mode a new run (`.claude/protocols/evaluation-verdict.md`, *Limits*).

The ship step is where the gate runs through the correlation,
`bun run quality-gate --correlation <pointer>` (`.claude/skills/forge-ship/SKILL.md`). That is for a
run whose work is in a checkout of this harness. A run whose work is in another repository
(`repos/<repo>`, or a worktree of one) still names its bead on every write, but the harness gate is
not run for it: the gate runs this package's checks on the directory it is started in, so it would
judge the harness and not the run's work. Such a run runs that repository's own checks and ends with
no linked gate entry (`agent-forge-harness-g043`).

---

## `--smith`

`/forgemaster`, `/forgemaster-auto`, `/forgemaster-mini` and the four `/forge-*` commands take
`--smith <name>`: the configured smith (a provider, a model and an effort;
`bun run forge:config show` lists them) that the run is recorded as built by.

- **It is given on every `forge:phase-gate` call of the run**, the entry checks and the writes:
  `bun run forge:phase-gate <phase> --slug <slug> --write --bead <id> --smith <name>`. A name that
  is not configured is refused, with the list of the ones that are; a write stores the smith on the
  run as its executor and stamps it on the run's ledger events.
- **It is per call.** A write without it records the live session instead (whenever the ledger
  knows that session's model), in place of a smith an earlier write stored. A resumed run, or a
  single `/forge-*` command run on its own, passes it again; `bun run forge:runs show <slug>` prints
  what the run holds.
- **It does not change the model of the session that reads the command.** That session builds with
  the model it is running. Record the smith that really builds: the executor on the run is the
  builder the evaluator's rank is compared against when the opt-in strict verdict is on.
- **Hand it on when work goes to a spawned CLI.** Point the run at the task, then spawn with the
  same smith: `bun run forge:correlate --bead <task-id> --run <slug>`, then
  `bun run forge:exec --bead <task-id> --run <slug> --smith <name> --worktree <checkout> --prompt <text>`.

With no `--smith`, nothing changes: the phase gate records the live session, and `forge:exec` picks
a smith in the config's order: its own `--smith`, the bead's `smith` metadata, the bench for the
bead's `complexity:*` label, then the default smith (`.claude/protocols/model-tier-policy.md`).

The mini path keeps no run state, so there a `--smith` is recorded by one write at the end of the
wrap step (`.claude/workflows/forge-mini.md`).

---

## Beads is mandatory

This workflow tracks all work in Beads. If `bd` is unreachable (Dolt server down), **stop and fix
it** — `bd dolt start` — then retry. Do not proceed without issue tracking. The Dolt server is
started automatically at session start (see `.claude/settings.json` SessionStart hook); this is the
manual fallback.

The plan phase materializes the Beads epic/feature/tasks (priorities via
`.claude/skills/beads-priority-assignment/SKILL.md`); the implement phase claims and closes them
with test evidence; the ship phase closes the epic/feature.

### Track progress in Beads as you go

Keep the issue graph reflecting reality **throughout** a run — not just at the end. Every phase
updates Beads:

| Moment | Beads action |
|--------|--------------|
| Plan materializes work | `bd create … --priority <p>` (+ `bd dep add` for ordering) |
| Starting a task | `bd update <id> --claim` (sets assignee + `status=in_progress`) |
| Each checkpoint / decision / pivot | `bd comments add <id> "worklog: <what changed>"` |
| Blocked on something external | `bd update <id> --status blocked` + a `deps:` comment naming the blocker (and file the blocker as its own issue) |
| Review verdict | `bd comments add <id> "review: PASS\|FAIL — <counts>"` |
| Task done (with evidence) | `bd close <id>` + closing `worklog:` comment |
| Before the push | `bun run quality-gate --correlation <pointer>`: the gate, logged against the run and the issue it names |
| Run shipped | close the epic/feature (the tracker is local-only — no `bd dolt push`) |

Comment prefixes follow the harness convention: `worklog:`, `ac:`, `design:`, `deps:`, `review:`.
Do **not** batch all status changes to the end — a stale issue graph misleads the next session.

---

## TDD is the build method

The plan phase sets up red-green-refactor using `.claude/skills/tdd/SKILL.md`, and the implement phase
executes it **vertically** — one test → minimal code → repeat — never all-tests-then-all-code.
Behaviors are tested through public interfaces so tests survive refactors.

---

## Exit hook

A `Stop` hook (`.claude/hooks/forge-phase-gate.ts`) is wired in settings. It is a no-op unless at
least one forge run is in flight, and then prints a one-line reminder per run of the next phase
command — once per run per phase transition, never blocking. A run goes quiet once its ship phase is
recorded complete.

---

## Standalone vs orchestrated

- **Standalone**: run a single phase when you already have its prerequisite (e.g. `/forge-plan`
  when a research doc exists). The phase-gate will refuse if the prerequisite is missing.
- **Orchestrated**: `/forgemaster` walks all four phases, pausing for your approval at every
  boundary and surfacing each phase's exit artifact before moving on. See
  `.claude/commands/forgemaster.md`.
- **Unattended**: `/forgemaster-auto` walks the same four phases with a fresh evaluator subagent at
  every boundary instead of a human — bounded revision rounds, and a halt with a written handoff
  when it cannot converge. See `.claude/workflows/forge-auto.md`.
- **Mini**: `/forgemaster-mini` (or `/forgemaster` auto-routing a low-complexity request) runs the
  trimmed path in `.claude/workflows/forge-mini.md` — same Beads + TDD discipline, fewer phases,
  turns, and artifacts.
