# Agent Forge Command Center — research and plan suite

Generated: 2026-10-06 · Epic: `agent-forge-harness-x1gs` · Status: **planned, not started**

Agent Forge is being reworked from a Claude Code convention layer into a local-first **command center**: one ledger of every agent session and tool call across providers, a control-plane server with a typed operator API, crews that route work to provider CLIs, a conflict-aware approval queue with bounded unattended drains, council as a one-click action on any bead, and a desktop app plus a Claude Code pane as control surfaces. Beads stays the only work graph; forgemaster stays the planning brain. The trigger was [Orbit](https://orbit-cli.com/) ([repo](https://github.com/constellation-works/orbit)); the goal is to go beyond it, not to copy it.

## Read in this order

| # | File | What it gives an executor |
|---|---|---|
| 1 | [`01-orbit-teardown.md`](01-orbit-teardown.md) | Orbit's feature inventory and vocabulary; what it does better; where the harness already leads; the bar for "beyond Orbit" |
| 2 | [`02-gap-analysis.md`](02-gap-analysis.md) | Capability matrix with file-cited "today" facts; reuse map; defects found; overlap with open epics `ulpz`, `t1b1`, `3u6` |
| 3 | [`03-target-architecture.md`](03-target-architecture.md) | Invariants, component map, domain model, ledger, control plane, MCP, adapters, scheduler, UI, desktop, config, non-goals |
| 4 | [`04-roadmap-and-beads.md`](04-roadmap-and-beads.md) | Waves, external prerequisites, and per-bead approach notes keyed by the `Spec:` anchor each bead carries |
| 5 | [`bead-map.md`](bead-map.md) | Generated table of every bead with its ID, type, priority and blockers |

## The bead graph

- **Source of truth:** `scripts/beads/command-center-plan.ts` (titles, descriptions, AC, deps). Import or re-sync with `bun run beads:import-command-center-plan` (idempotent; `--dry-run` validates, `--markdown` regenerates `bead-map.md`). Library: `scripts/beads/plan-import.ts`.
- **Shape:** 1 epic → 10 features (F0 decisions … F9 docs) → 41 tasks/decisions, 91 `blocks` edges including links to already-open issues (`ulpz.1`, `ulpz.3`, `0xxt`, `empi`, `csf2`, `5mge`, `2q5s`, `3u6`).
- **Start here:** `bd ready | grep x1gs`. Wave 0 is `f9-fix-refs` and the three decisions `D1`–`D3`.

## Working agreements for this epic

1. Each feature is one `/forgemaster` run in its own worktree; its tasks are the demo checkpoints. Evaluator tier ≥ builder tier.
2. Beads is the only work graph. Queue states, reservations and verdicts are ledger events about beads.
3. Local-first and loopback-only. No accounts, no cloud sync, no provider API keys for execution.
4. Windows is a first-class host; every spawn uses argument arrays and is tested with a path containing spaces.
5. Architecture changes land as a `design:` comment on the bead **and** an edit to `03-target-architecture.md` in the same PR.
6. Token discipline: read these docs instead of re-surveying; the gap analysis already cites the files.
