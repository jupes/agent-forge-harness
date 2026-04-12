# Agent Forge Harness

A composable, agentic coding system for development teams using [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Small primitives — workflows, agent roles, quality gates, issue tracking, knowledge files — that chain into a self-coordinating development process.

## Overview

This repo is the **Agent Forge “harness”**: opinionated **markdown workflows**, **slash commands**, **hook scripts**, **Beads-backed issue tracking**, and **`knowledge/` YAML** that sit *around* your real product repositories (including optional **multi-repo** management under `repos/`). It does not run your app in production; it **coordinates how agents and humans work** — scope routing (fix vs feature vs epic), quality checks, commits, pushes, PRs, and where domain truth is written down before diving into code.

**In practice:** you install dependencies, register repos and Beads, open Claude Code in this workspace, and drive work with `/go`, `/plan`, `/ship`, and the other commands below. TypeScript utilities (mostly **Bun**) implement hooks and repo/worktree helpers.

**Best suited for:** teams using Claude Code who want **shared process**, **AC-driven tasks**, **knowledge-first exploration**, and optional **several git repos** from one control plane.

**Fuller narrative** (architecture, strengths, limits, customization layers): [docs/HARNESS-GUIDE.md](docs/HARNESS-GUIDE.md).

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | TypeScript runtime & package manager | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | AI coding CLI | `npm install -g @anthropic-ai/claude-code` |
| [gh](https://cli.github.com) | GitHub CLI | `brew install gh` |
| [bd (Beads)](https://github.com/steveyegge/beads) | AI-native issue tracker | See Beads repo |
| Git | Version control | Pre-installed |

---

## Setup

```bash
# 1. Clone this repo
git clone https://github.com/jupes/agent-forge-harness.git
cd agent-forge-harness

# 2. Install dependencies
bun install

# 3. Run the setup wizard
bun run setup

# 4. Initialize sub-repos
bun run repo init --human

# 5. Initialize Beads
bd init
bd sync

# 6. Open Claude Code
claude
```

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
│   ├── agents/         # lead.md, worker.md — agent role definitions
│   ├── commands/       # /go, /plan, /ship, /status, /review, etc.
│   ├── workflows/      # fix.md, feature.md, epic.md
│   ├── hooks/          # quality-gate.ts, session.ts
│   ├── protocols/      # Interface contracts for parallel workers
│   ├── skills/         # Reusable expertise packages
│   └── settings.json   # Hooks, permissions, env vars
├── .beads/             # Issue tracking (JSONL + Dolt)
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
