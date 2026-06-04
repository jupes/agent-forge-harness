# Forge Workflow

The guided, four-phase development pipeline. Each phase is a skill with its own command; the phases
chain through a shared `<slug>` and a state file at `.tmp/work/forge-state.json`.

```
research → plan → implement → ship
   │         │         │          │
 grill    TDD +     demo-able    summary +
 the      Beads     checkpoints  walkthrough
 unknowns  map                   + PR
```

**When to use**: any feature or non-trivial change that benefits from research-first investigation,
a TDD plan, observable incremental delivery, and a written handoff.

**Two sizes — match ceremony to the work** (see `.claude/protocols/model-tier-policy.md`):

- **Full pipeline** (this file) — medium-or-higher complexity: >3 files, a new
  component/system, genuine unknowns or design decisions, or cross-cutting scope. Four gated
  phases, four artifacts.
- **Mini pipeline** (`.claude/workflows/forge-mini.md`) — low complexity: ≤~3 files, clear scope,
  no new architecture, at most one real decision. Collapses to a quick plan → TDD build with one
  demo checkpoint → brief summary, with far fewer turns/artifacts to keep cost down. Beads tracking
  and TDD still apply.

**Orchestration**: `/forgemaster <feature>` first judges complexity and **routes** to the full or
mini path (you can confirm or override), then runs the chosen path gated, asking approval before
advancing. `/forgemaster-mini` forces the mini path; the four `/forge-*` commands run a single full
phase standalone.

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
bun run forge:phase-gate <phase> --slug <slug>           # may this phase start? (checks prereq)
bun run forge:phase-gate <phase> --slug <slug> --write   # record this phase complete (checks own artifact)
```

It exits non-zero (and prints `{ ok, data, error }`) when a prerequisite artifact is missing, so a
phase can never run on a missing or half-finished predecessor.

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
| Run shipped | close the epic/feature; `bd dolt push` |

Comment prefixes follow the harness convention: `worklog:`, `ac:`, `design:`, `deps:`, `review:`.
Do **not** batch all status changes to the end — a stale issue graph misleads the next session.

---

## TDD is the build method

The plan phase sets up red-green-refactor using `.claude/skills/tdd/SKILL.md`, and the implement phase
executes it **vertically** — one test → minimal code → repeat — never all-tests-then-all-code.
Behaviors are tested through public interfaces so tests survive refactors.

---

## Exit hook

A `Stop` hook (`.claude/hooks/forge-phase-gate.ts`) is wired in settings. It is a no-op unless a
forge run is active, and then prints a one-line reminder of the next phase command — once per phase
transition, never blocking. It goes quiet once the ship phase is recorded complete.

---

## Standalone vs orchestrated

- **Standalone**: run a single phase when you already have its prerequisite (e.g. `/forge-plan`
  when a research doc exists). The phase-gate will refuse if the prerequisite is missing.
- **Orchestrated**: `/forgemaster` walks all four phases, pausing for your approval at every
  boundary and surfacing each phase's exit artifact before moving on. See
  `.claude/commands/forgemaster.md`.
- **Mini**: `/forgemaster-mini` (or `/forgemaster` auto-routing a low-complexity request) runs the
  trimmed path in `.claude/workflows/forge-mini.md` — same Beads + TDD discipline, fewer phases,
  turns, and artifacts.
