# Agent Forge Harness — Concepts & Customization

This document explains **what** the harness is, **how** the pieces fit together, **where** it shines, and **how** to adapt it to your team.

For command syntax and setup steps, see the [README](../README.md). For day-to-day agent rules, see [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md).

---

## What this repository is

**Agent Forge Harness** is a **configuration and convention layer** around [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It is not a replacement for your editors, CI, or product codebases. It is a **repeatable operating system** for AI-assisted software work: how tasks are picked up, how scope is classified, how quality is checked, how work is tracked, and how context is stored so agents (and humans) do not start from zero every session.

The harness lives mostly under `.claude/` (agents, slash commands, workflows, hooks, skills, protocols), plus **`knowledge/`** (curated domain YAML), **`plans/`** (durable plan drafts and committed plan snapshots), **`.beads/`** (Beads issue data), **`repos/`** (optional registered sub-repositories), and small **Bun/TypeScript** utilities in `scripts/` and hook code.

---

## What it does

| Concern | Mechanism |
|--------|-----------|
| **How work starts** | Slash commands such as `/go`, `/plan`, `/ship`, `/add-bead` defined in `.claude/commands/` |
| **How much process applies** | Workflows in `.claude/workflows/` (fix vs feature vs epic) chosen by scope |
| **Who does what** | Agent prompts in `.claude/agents/` (lead coordinates; workers implement, often in worktrees) |
| **Quality before merge** | Hooks in `.claude/hooks/` (for example `quality-gate.ts`) tied to Claude Code events in `settings.json` |
| **What “true” is for the product** | `knowledge/` YAML, optionally refreshed from code via `/sync-knowledge` |
| **Where durable plan artifacts live** | `plans/drafts/` (active plans) and `plans/committed/` (baseline snapshots) |
| **What must get done** | Beads (`.beads/`, `bd` CLI) as the issue graph — epics, features, tasks, dependencies, AC |
| **Multi-repo coordination** | `repos/repos.json` + the `syncing-repos` skill (`bun run repo …`) |
| **Portable expertise** | Skills in `.claude/skills/<name>/SKILL.md` (and optional scripts) |
| **Parallel workers** | Git worktrees (`scripts/worktree.ts`) and protocols under `.claude/protocols/` |

Together, these pieces nudge behavior toward **typed, tested, small commits**, **knowledge-first exploration**, and **push-ready** completion without forcing every team into the same ceremony for tiny edits.

---

## How it works (flow)

At a high level:

1. **You (or the lead agent)** describe work via `/go`, `/plan`, `/add-bead`, or an epic batch.
2. The harness **classifies scope** and loads the matching **workflow** markdown (checklists, gates, when to plan vs ship).
3. **Workers** follow `worker.md` (and repo-specific `AGENTS.md` under `repos/…`) to implement changes; larger epics may use **isolated worktrees**.
4. **Hooks** run checks (typecheck, lint if present, tests if test files exist, tree cleanliness, and task-oriented checks) and emit **structured JSON** for automation or logs.
5. **Beads** records tasks, AC, dependencies, and comments; **`bd dolt pull` / `bd dolt push`** (and `bd dolt commit` when required) keep the graph aligned with collaborators — not the removed **`bd sync`** command ([gastownhall/beads#2435](https://github.com/gastownhall/beads/issues/2435)). Use **`bd backup sync`** / **`bd federation sync`** only for those respective setups.
6. **`/ship`** and session rules push toward **commit → push → PR** with evidence.

Supporting scripts (for example `quality-gate.ts`, `worktree.ts`, `repo` via skills) are ordinary TypeScript run with **Bun**, so you can extend them like any internal tooling.

---

## What it is best for

- **Teams already using (or adopting) Claude Code** who want a **shared playbook** instead of ad-hoc prompts every time.
- **Multi-service or multi-repo setups** where a single “harness” repo coordinates clones, branches, and knowledge across several codebases.
- **Work that benefits from explicit AC and traceability** (Beads tasks, review commands, handoff expectations).
- **Organizations that want proportional rigor**: small fixes stay light; larger features get planning and review steps spelled out in workflow files.

---

## Where it is a weaker fit

- **Zero interest in issue tracking or conventions** — much of the value is in Beads + workflows + hooks working together; removing those leaves you with generic prompts.
- **Projects that cannot run Bun** for scripts and hooks — the repo assumes Bun for `bun run` and hook implementations.
- **Fully non-GitHub or non-`gh` flows** — several flows assume GitHub-style PRs; you can still adapt commands manually.

None of these are hard blockers; they just mean **more customization** (see below).

---

## How to customize it

Think in **layers** so upgrades from upstream stay mergeable.

### 1. Team conventions (low churn)

- **`knowledge/_shared.yaml`** — commit format, branch naming, PR expectations, testing language.
- **`knowledge/repos/<repo>.yaml`** — per-service facts after you register repos.

### 2. Behavior without code (medium churn)

- **`.claude/commands/*.md`** — slash command text (what `/go` or `/ship` tells the model to do).
- **`.claude/workflows/*.md`** — steps, gates, and when to skip planning.
- **`.claude/agents/*.md`** — lead vs worker tone, delegation rules, forbidden actions.

### 3. Automation (higher churn, TypeScript)

- **`.claude/hooks/*.ts`** — add checks, change timeouts, or emit different JSON envelopes (keep output machine-parseable where hooks already do).
- **`scripts/*.ts`** — new utilities; wire them from `package.json` if agents should call them by name.

### 4. Reusable playbooks

- **`.claude/skills/<skill-name>/SKILL.md`** — scaffold with:

  ```bash
  bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts <skill-name> "<description>"
  ```

  Then replace the TODO sections. Optional `scripts/` and `references/` live beside the skill.

### 5. Multi-repo registry

- **`repos/repos.json`** — local registry (gitignored); copy `repos/repos.json.example` to `repos/repos.json`, add entries, then `bun run repo init` (see [add-repo skill](../.claude/skills/add-repo/SKILL.md)).

### 6. Claude Code wiring

- **`.claude/settings.json`** — hook events, permissions, environment. Match your org’s security model (for example which hooks run on which events).

### 7. Dashboard

- **`docs/`** — static GitHub Pages dashboard; `bun run build-pages` regenerates `docs/data/beads.json` from Beads JSONL for visualization.

### 8. Plan storage contract

- Use the root `plans/` tree for durable plan files consumed by review UX and tooling.
- Keep ephemeral artifacts (`alignment`, `verdict`, session handoff) in `.tmp/work/`.
- Follow naming conventions documented in [`plans/README.md`](../plans/README.md).

---

## How to improve the harness itself

- **Treat upstream as a template**: fork or vendor `.claude/` and merge selectively; document your overrides in your fork’s README.
- **Add skills** for repeated org-specific flows (deploy, schema migration, security checklist) instead of pasting the same instructions into every task.
- **Tighten or loosen gates** in `quality-gate.ts` and workflows together so agents are not told “ship” while hooks always fail (or the opposite).
- **Keep `knowledge/` honest**: stale YAML hurts `/ask` and planning; regenerate or edit after meaningful architectural changes.
- **Contribute generic improvements back** if you build something reusable (skills, hook checks, workflow wording) without embedding proprietary details.

---

## Related files

| File | Role |
|------|------|
| [README.md](../README.md) | Quick setup, command table, directory map |
| [CLAUDE.md](../CLAUDE.md) | Agent constitution, Beads CLI cheat sheet, architecture |
| [AGENTS.md](../AGENTS.md) | Non-interactive shell, session start/end, JSON conventions |

If you add a long internal runbook, link it from the README **Overview** section so new contributors find it in one hop.
