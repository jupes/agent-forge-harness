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
a TDD plan, observable incremental delivery, and a written handoff. For tiny one-file fixes use
`/go` or the `fix` workflow instead.

**Orchestration**: `/forgemaster <feature>` runs all four phases in order, gating between each
(it asks you to approve before advancing). You can also run any phase standalone with its command.

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
