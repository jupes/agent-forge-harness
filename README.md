# Agent Forge Harness

Composable **Claude Code** harness: workflows, slash commands, hooks, [Beads](https://github.com/gastownhall/beads) issue tracking, and `knowledge/` YAML around your real repos (optional multi-repo under `repos/`). It coordinates how agents and humans work—not your production runtime.

<img width="1800" height="836" alt="agent-forge-demo (5)" src="https://github.com/user-attachments/assets/d90bb957-4c78-4dcf-aa32-d694a06833fb" />


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

2. **Wizard:** `bun run setup` (use `--non-interactive` for defaults/CI).

3. **GitHub CLI:** `gh auth login` when you use PR automation.

4. **Beads:** install `bd`, run `bd doctor`, apply what it suggests (`bd hooks install`, `git config beads.role maintainer`, etc.). Initialize once, e.g. `bd init --non-interactive --role maintainer` (add `--shared-server` when doctor says so, typical on Windows). **Sync issues** with `bd dolt pull` / `bd dolt push` — not the removed `bd sync` ([#2435](https://github.com/gastownhall/beads/issues/2435)). Optional sample epic: `bun run beads:import-anthropic-plan`.

5. **Claude Code:** open the **repo root** (`claude`) so `.claude/` loads; restart after hook changes from `bd init`.

---

## Optional: repos, dashboard, worktrees

| Goal | Command / note |
|------|----------------|
| Clone registered repos | After URLs in `repos/repos.json`: `bun run repo init --human` |
| Knowledge YAML | `/sync-knowledge <repo>` or `--all` — see [.claude/skills/syncing-repos/SKILL.md](.claude/skills/syncing-repos/SKILL.md) |
| GitHub Pages data | `bun run build-pages` (needs `bd` on PATH) |
| Local dashboard | `bun run dashboard` — Vite + live reload; `PORT`, `DASHBOARD_HOST`, `DASHBOARD_NO_BUILD` supported |
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
| `bun run tmp:cleanup` | Prune stale `.tmp/work/*` (see script; `--apply` to delete) |

---

## Layout

```
agent-forge-harness/
├── .claude/          # agents, commands, workflows, hooks, protocols, skills, settings.json
├── .claude/molecules/  # optional JSON “molecules” (validated by molecules:check)
├── .beads/           # Beads data (see repo .beads README)
├── knowledge/        # _shared.yaml, repos/*.yaml
├── repos/            # clones (often gitignored); repos.json registry
├── scripts/          # Bun utilities
├── types/            # shared TS (e.g. beads types)
└── docs/             # dashboard / Pages
```

---

## Customize

Change **knowledge** before code, then **workflows** / **quality-gate.ts** / **agents** as needed. **Add a repo:** extend `repos/repos.json`, `bun run repo init --human`, `/sync-knowledge`. **Add a skill:** `bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts <name> "description"`. Details: [HARNESS-GUIDE.md](docs/HARNESS-GUIDE.md).

---

## License

MIT — [LICENSE](LICENSE)
