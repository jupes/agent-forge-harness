# Agent Forge Harness

A composable, agentic coding system for development teams using [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Small primitives — workflows, agent roles, quality gates, issue tracking, knowledge files — that chain into a self-coordinating development process.

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
mkdir -p .claude/skills/my-skill
# Create .claude/skills/my-skill/SKILL.md
# Or use the meta-skill: "Create a new skill for X"
```

### Adjust workflows
- Change quality gate thresholds in each workflow `.md` file
- Adjust conditional skip rules in `.claude/workflows/feature.md`
- Change WIP limit in `.claude/workflows/epic.md` (default: 3)

---

## License

MIT — see [LICENSE](LICENSE)
