# Agent Forge Harness

Composable **Claude Code** harness: workflows, slash commands, hooks, [Beads](https://github.com/gastownhall/beads) issue tracking, and `knowledge/` YAML around your real repos (optional multi-repo under `repos/`). It coordinates how agents and humans work—not your production runtime.

<img width="1800" height="836" alt="agent-forge-demo (5)" src="https://github.com/user-attachments/assets/d90bb957-4c78-4dcf-aa32-d694a06833fb" />

## Summary

**What this repository is.** Agent Forge Harness is a **configuration and convention layer** for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It is not a framework for your product app, a deployable service, or a replacement for your editor or CI. It is a **harness repo** you keep at the root of (or alongside) the work you want agents to help with: it encodes *how* work is picked up, scoped, planned, checked, and recorded so sessions stay consistent when people, models, or machines hand off to each other.

**What it does.** The harness gives you a **shared operating system** for AI-assisted development: slash commands for day-to-day flow (`/go`, `/plan`, `/ship`, and others), **workflows** that scale ceremony to task size (small fixes vs planned features vs batched epics), **hooks** that run quality checks at the right moments, **[Beads](https://github.com/gastownhall/beads) issue tracking** so tasks, acceptance criteria, and dependencies live in a graph instead of chat, **`knowledge/`** YAML for curated facts about your systems, optional **multi-repo** coordination under `repos/`, **plan storage** under `plans/` for durable drafts and committed baselines, Bun **scripts** for automation (worktrees, repo sync, dashboard data), and a **static dashboard** in `docs/` for visibility. Together, that steers work toward typed, test-backed changes and push-ready completion without forcing the same process on every one-line fix.

**How it does it.** **Claude Code** loads `.claude/` (agents, commands, workflows, hooks, skills, protocols) when you open this repo. **Slash commands** map human intent to the right **workflow** markdown; agents and humans follow those playbooks. **Hooks** (TypeScript, run with Bun) enforce or report **quality gates** (typecheck, tests, tree state, and project-specific checks) in structured JSON when relevant events fire. **Beads** (`bd`, with optional Dolt) is the system of record for *what* must be done. **`knowledge/`** and **`plans/`** hold **durable** context and plan artifacts; **`.tmp/work/`** remains for short-lived session files. **Optional worktrees** and epic workflow support parallel workers without clobbering the same branch. None of this runs your production stack—it **orchestrates the work** around the codebases you point the harness at.

**Deeper walkthrough:** [docs/HARNESS-GUIDE.md](docs/HARNESS-GUIDE.md)

---

## Prerequisites

| Need | Notes |
|------|--------|
| [Bun](https://bun.sh) | Runs scripts and hooks |
| TypeScript | `bun add -d typescript` after `bun install` — required for `bun run typecheck` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Commands + hooks |
| Git | — |
| [`gh`](https://cli.github.com) | PR flows in `/ship` |
| [`bd`](https://github.com/gastownhall/beads) + optional [Dolt](https://github.com/dolthub/dolt) | Issues; on Windows, doctor often wants Dolt + `bd init … --shared-server` |

---

## First-time setup

1. **Clone and install**

   ```bash
   git clone https://github.com/jupes/agent-forge-harness.git
   cd agent-forge-harness
   bun install
   bun add -d typescript
   bun run typecheck
   ```

2. **Wizard:** `bun run setup` (use `--non-interactive` for defaults/CI). For multi-repo, copy `repos/repos.json.example` to `repos/repos.json` and add URLs (local-only; do not commit `repos/repos.json`).

3. **GitHub CLI:** `gh auth login` when you use PR automation.

4. **Beads:** install `bd`, run `bd doctor`, apply what it suggests (`bd hooks install`, `git config beads.role maintainer`, etc.). Initialize once, e.g. `bd init --non-interactive --role maintainer` (add `--shared-server` when doctor says so, typical on Windows). **Sync issues** with `bd dolt pull` / `bd dolt push` — not the removed `bd sync` ([#2435](https://github.com/gastownhall/beads/issues/2435)). Optional sample epic: `bun run beads:import-anthropic-plan`.

5. **Claude Code:** open the **repo root** (`claude`) so `.claude/` loads; restart after hook changes from `bd init`.

---

## Optional: repos, dashboard, worktrees

| Goal | Command / note |
|------|----------------|
| Clone registered repos | After URLs in local `repos/repos.json` (from `repos/repos.json.example`): `bun run repo init --human` |
| Knowledge YAML | `/sync-knowledge <repo>` or `--all` — see [.claude/skills/syncing-repos/SKILL.md](.claude/skills/syncing-repos/SKILL.md) |
| GitHub Pages data | `bun run build-pages` (needs `bd` on PATH) |
| Local dashboard | `bun run dashboard` — Vite + live reload; Beads dashboard + **Plan review** (`docs/plan-review.html`: drafts, baseline diff, **git revision history / compare**). Env: `PORT`, `DASHBOARD_HOST`, `DASHBOARD_NO_BUILD` |
| Parallel epics | `bun run worktree create feat/…` — see [`.claude/workflows/epic.md`](.claude/workflows/epic.md) |

---

## Claude Code usage

Scope router and friends:

`/go` · `/plan` · `/ship` · `/status` · `/review` · `/triage` · `/ask` · `/sync-knowledge [repo|--all]` · `/add-bead <text>`

`/go` picks **fix** (small), **feature** (plan + build), or **epic** (batched / worktrees) from task scope.

---

## npm scripts (root)

| Script | Purpose |
|--------|---------|
| `bun run setup` | First-time wizard |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Tests under `scripts/` |
| `bun run quality-gate` | Hook parity / checks |
| `bun run worktree` | Git worktree helpers |
| `bun run repo` | Multi-repo init/status (syncing-repos skill) |
| `bun run build-pages` | Dashboard Beads snapshot |
| `bun run dashboard` | Vite preview for `docs/` |
| `bun run beads:import-anthropic-plan` | Idempotent sample epic/tasks |
| `bun run beads:bundles <EPIC-ID>` | Parallel batches from Beads graph |
| `bun run molecules:check` | Validate `.claude/molecules/*.json` |
| `bun run tmp:cleanup` | Prune stale `.tmp/work/*` ephemeral files (see script; `--apply` to delete) |

---

## Layout

```
agent-forge-harness/
├── .claude/          # agents, commands, workflows, hooks, protocols, skills, settings.json
├── .claude/molecules/  # optional JSON “molecules” (validated by molecules:check)
├── .beads/           # Beads data (see repo .beads README)
├── knowledge/        # _shared.yaml, repos/*.yaml
├── plans/            # durable plan drafts + committed snapshots
├── repos/            # clones + local repos.json (gitignored); repos.json.example template
├── scripts/          # Bun utilities
├── types/            # shared TS (e.g. beads types)
└── docs/             # dashboard / Pages
```

---

## Customize

Change **knowledge** before code, then **workflows** / **quality-gate.ts** / **agents** as needed. **Add a repo:** extend local `repos/repos.json` (never commit it), `bun run repo init --human`, `/sync-knowledge`. **Add a skill:** `bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts <name> "description"`. Details: [HARNESS-GUIDE.md](docs/HARNESS-GUIDE.md).

Plan artifacts should use the root `plans/` contract: write active drafts to `plans/drafts/` and store baseline snapshots in `plans/committed/`.

---

## License

MIT — [LICENSE](LICENSE)
