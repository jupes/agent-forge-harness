# Agent Forge Harness

A composable, agentic coding system for development teams using [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Small primitives — workflows, agent roles, quality gates, issue tracking, knowledge files — that chain into a self-coordinating development process.

![agent-forge-demo-hq](https://github.com/user-attachments/assets/69e177cc-c45e-4196-8e35-4c35f933f0a2)


## Overview

This repo is the **Agent Forge “harness”**: opinionated **markdown workflows**, **slash commands**, **hook scripts**, **Beads-backed issue tracking**, and **`knowledge/` YAML** that sit *around* your real product repositories (including optional **multi-repo** management under `repos/`). It does not run your app in production; it **coordinates how agents and humans work** — scope routing (fix vs feature vs epic), quality checks, commits, pushes, PRs, and where domain truth is written down before diving into code.

**In practice:** you install dependencies, register repos and Beads, open Claude Code in this workspace, and drive work with `/go`, `/plan`, `/ship`, and the other commands below. TypeScript utilities (mostly **Bun**) implement hooks and repo/worktree helpers.

**Best suited for:** teams using Claude Code who want **shared process**, **AC-driven tasks**, **knowledge-first exploration**, and optional **several git repos** from one control plane.

**Fuller narrative** (architecture, strengths, limits, customization layers): [docs/HARNESS-GUIDE.md](docs/HARNESS-GUIDE.md).

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | Runs setup, hooks, and scripts | [Install Bun](https://bun.sh/docs/installation) (macOS/Linux/WSL: `curl -fsSL https://bun.sh/install \| bash`; Windows: installer from site) |
| [TypeScript](https://www.typescriptlang.org/) | `bun run typecheck` (used by `quality-gate.ts`) | `bun add -d typescript` in this repo after `bun install` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Slash commands, hooks, agents | `npm install -g @anthropic-ai/claude-code` |
| [GitHub CLI `gh`](https://cli.github.com) | PRs, `gh pr`, repo flows in commands | `brew install gh`, [WinGet](https://github.com/cli/cli#windows), etc. |
| [Beads `bd`](https://github.com/steveyegge/beads) | Issue graph (`bd create`, `bd ready`, …) | Follow the Beads install docs for your OS |
| [Dolt](https://github.com/dolthub/dolt) | SQL server for Beads when embedded Dolt is unavailable (typical on **Windows** without CGO) | e.g. `winget install DoltHub.Dolt` — then ensure `dolt` is on `PATH` (open a **new** terminal after install, or refresh `PATH` — see **Beads** below) |
| Git | Version control | Usually preinstalled |

---

## Getting everything running

Do these in order the first time you clone the harness. Skip steps that do not apply (for example sub-repos if you only use this repo).

### 1. Clone and install JavaScript dependencies

```bash
git clone https://github.com/jupes/agent-forge-harness.git
cd agent-forge-harness
bun install
```

Install the TypeScript compiler so hooks and local checks can run `tsc`:

```bash
bun add -d typescript
```

Confirm:

```bash
bun run typecheck
```

### 2. Run the setup wizard

Interactive (recommended once):

```bash
bun run setup
```

It can prompt for project name, GitHub org, and repos to register in `repos/repos.json`. Non-interactive CI-style run:

```bash
bun run setup --non-interactive
```

### 3. GitHub CLI authentication

Several flows use `gh` (for example PR creation in `/ship`):

```bash
gh auth login
```

### 4. Beads (issue tracker)

1. Install the **`bd`** CLI per [Beads installation](https://github.com/steveyegge/beads).
2. From the repo root, check health and fix common gaps:

   ```bash
   bd doctor
   ```

   If the doctor suggests it, set your role (once per machine user):

   ```bash
   git config beads.role maintainer
   ```

   If it recommends **git hooks** for Beads, install them (safe to re-run):

   ```bash
   bd hooks install
   ```

3. **Initialize the database** (first time only, or on a new clone without `.beads` data):

   - **macOS / Linux** (embedded Dolt / CGO available):  

     ```bash
     bd init --non-interactive --role maintainer
     ```

   - **Windows** (typical `bd` builds need an external Dolt server): install **Dolt**, then open a **new** terminal so `PATH` includes `dolt`, and run:

     ```bash
     bd init --non-interactive --role maintainer --shared-server
     ```

     If `bd` still reports `dolt is not installed (not found in PATH)`, reload `PATH` in the current shell and retry:

     ```powershell
     $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
     dolt version
     bd init --non-interactive --role maintainer --shared-server
     ```

   If this repo already has customized `CLAUDE.md` / hooks and you only need the database, add `--skip-hooks` to avoid duplicate hook registration.

4. **Sync / push issue data** uses **Dolt** commands (the legacy **`bd sync` command was removed** upstream; use `bd dolt pull` / `bd dolt push` instead — see [gastownhall/beads#2435](https://github.com/gastownhall/beads/issues/2435)). Follow `bd doctor` and [Beads docs](https://github.com/steveyegge/beads). Typical flows:

   ```bash
   bd dolt pull    # session start / before picking up remote issue changes
   bd dolt commit  # only when your setup needs an explicit Dolt commit
   bd dolt push    # session end with git push — see CLAUDE.md / AGENTS.md
   ```

   **Backups** (separate from day-to-day issue sync): `bd backup sync` after `bd backup init …` per Beads docs. **Federation** setups: `bd federation sync` when you use that mode.

5. Optional: install the sample **Anthropic harness integration** epic + phased tasks (after `bd` works). **Idempotent** — safe to re-run; reuses the same epic/tasks by title and only adds missing deps or children.

   ```bash
   bun run beads:import-anthropic-plan
   ```

### 5. Claude Code in this workspace

Open the **repository root** in Claude Code so it picks up `.claude/settings.json`, commands, and hooks:

```bash
claude
```

If `bd init` just changed hooks or settings, **restart Claude Code** once so it reloads configuration.

### 6. Optional — multi-repo (`repos/`)

If you registered URLs in `repos/repos.json` during setup:

```bash
bun run repo init --human
```

Then generate or refresh knowledge for each service (from Claude Code, `/sync-knowledge <repo>` or `--all`). See [`.claude/skills/syncing-repos/SKILL.md`](.claude/skills/syncing-repos/SKILL.md).

### 7. Optional — GitHub Pages dashboard

The static site under `docs/` can show a Beads overview when `docs/data/beads.json` exists. The `build-pages` script prefers **`.beads/*.jsonl`** when those files contain issues; otherwise it runs **`bd export --no-memories`** so **Dolt-backed Beads** (the default today) still populates the dashboard. `bd` must be on `PATH`. Regenerate data and open via `bun run dashboard` or publish the `docs/` folder:

```bash
bun run build-pages
```

**Local preview (no Python):** [Vite](https://vitejs.dev/) dev server with **live reload** when you edit `docs/` (HTML/JS/CSS). It runs `build-pages` on startup and again whenever `.beads/*.jsonl` changes (via [chokidar](https://github.com/paulmillr/chokidar), so gitignored Beads exports still trigger a refresh).

```bash
bun install   # once, to install vite + chokidar
bun run dashboard
```

Then open the URL Vite prints (default `http://127.0.0.1:8787/`). In the sidebar, **Rebuild data** runs `build-pages` again (same as `bun run build-pages`) without leaving the browser. Options: `PORT=9000 bun run dashboard`, `DASHBOARD_HOST=0.0.0.0 bun run dashboard` to listen on all interfaces, `DASHBOARD_NO_BUILD=1 bun run dashboard` to skip the initial `build-pages` run (serve existing `docs/data/beads.json` only).

### 8. Optional — parallel epics (git worktrees)

Epic workflow uses isolated worktrees:

```bash
bun run worktree create feat/my-worker-branch
bun run worktree list
```

See `scripts/worktree.ts` and `.claude/workflows/epic.md`.

### 9. Smoke checklist

| Check | Command / action |
|--------|------------------|
| TypeScript | `bun run typecheck` |
| Beads | `bd doctor`, then `bd ready` or `bd list` |
| Hooks | In Claude Code, confirm hooks run (or run `bun run quality-gate` manually) |
| Git + GitHub | `git status`, `gh auth status` |

---

## Usage

All work flows through a single entry point:

```bash
# In Claude Code:
/go                        # Pick highest-priority ready task
/go T-42                   # Work on a specific task
/go fix login redirect bug # Describe work in plain text
/go --epic EPIC-5          # Run the full epic workflow
```

Other commands:

```bash
/status                    # See git state + ready work
/plan add user settings    # Explore + create an implementation plan
/ship "add login redirect" # Quality gates → commit → push → PR
/review                    # Risk-tiered code review
/ask how does auth work    # Query knowledge files
/triage                    # Deadline + capacity overview
/sync-knowledge my-api     # Regenerate knowledge YAML
```

---

## Command Reference

| Command | Description |
|---------|-------------|
| `/go [task]` | Adaptive router: auto-selects fix / feature / epic workflow |
| `/plan [idea]` | Codebase exploration + implementation plan |
| `/ship [msg]` | Quality gates → atomic commit → push → PR |
| `/status` | Git state, ready tasks, blocked items, PR health |
| `/review [branch]` | Risk-tiered code review with AC trace matrix |
| `/triage` | Deadline management and capacity planning |
| `/ask [question]` | Query domain knowledge with staleness detection |
| `/sync-knowledge [repo\|--all]` | Auto-generate per-repo knowledge YAML |

---

## Workflows

The system auto-selects one of three workflows based on task scope:

| Workflow | Scope | Process |
|----------|-------|---------|
| **Fix** | ≤3 files | Explore → Build → Check → Ship (no plan) |
| **Feature** | >3 files | Plan → Approve → Build → Review → Ship |
| **Epic** | Multiple tasks | Parallel batch execution with worktrees |

---

## Directory Structure

```
agent-forge-harness/
├── .claude/
│   ├── agents/         # lead.md, worker.md, planner.md, evaluator.md
│   ├── commands/       # /go, /plan, /ship, /status, /review, etc.
│   ├── workflows/      # fix.md, feature.md, epic.md
│   ├── hooks/          # quality-gate.ts, session.ts
│   ├── protocols/      # Interface contracts, session handoff, evaluation rubric
│   ├── skills/         # Reusable expertise packages
│   └── settings.json   # Hooks, permissions, env vars
├── .beads/             # Issue tracking (Beads + Dolt; see Beads docs)
├── knowledge/          # Domain YAML files
│   ├── _shared.yaml    # Cross-repo conventions
│   └── repos/          # Per-repo knowledge files
├── repos/              # Sub-repos (gitignored after clone)
│   └── repos.json      # Repo registry
├── scripts/            # Bun utility scripts
├── types/              # Shared TypeScript types (beads.ts)
└── docs/               # GitHub Pages dashboard
```

---

## Customization

Start with [docs/HARNESS-GUIDE.md](docs/HARNESS-GUIDE.md) for **what to change first** (knowledge vs commands vs hooks) and how to keep upstream merges sane.

### Add a repo
```bash
# In Claude Code:
# "Add repo https://github.com/myorg/my-service.git"
# Or manually:
# 1. Add entry to repos/repos.json
# 2. bun run repo init --human
# 3. /sync-knowledge my-service
```

### Add a skill
```bash
bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts my-skill "One-line description"
# Edit .claude/skills/my-skill/SKILL.md — replace TODO sections
```

### Adjust workflows and gates
- Edit `.claude/workflows/*.md` — steps, when to plan vs ship, epic WIP (default: 3 in `epic.md`)
- Edit `.claude/hooks/quality-gate.ts` — checks must stay aligned with what `/ship` and agents promise
- Edit `.claude/agents/*.md` — lead vs worker responsibilities
- Edit `.claude/settings.json` — which hooks run on which Claude Code events

---

## License

MIT — see [LICENSE](LICENSE)
