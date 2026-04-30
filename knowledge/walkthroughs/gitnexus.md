# GitNexus — Agent walkthrough (harness)

Goal: orient harness agents to **GitNexus** as cloned under Agent Forge, how it relates to editors via **MCP**, and where to read upstream truth.

## What it is

- **GitNexus** builds a **code knowledge graph** (imports, calls, routes, tools, communities, processes) and exposes it through:
  - **`gitnexus` CLI** (analyze, query, serve, …)
  - **MCP server** (stdio) for Cursor, Claude Code, Codex, etc.
  - **`gitnexus serve`** HTTP bridge for the **Vite/React** web UI (`gitnexus-web/`).
- Persistence: **LadybugDB** locally; indexed metadata under **`.gitnexus/`** in each analyzed repo (see upstream `ARCHITECTURE.md`).

## License (do not skip)

- Open-source package is **PolyForm Noncommercial 1.0.0** (`gitnexus/package.json` → `license`).
- **Commercial** use / redistribution needs separate permission or enterprise path (see upstream README **Enterprise** / akonlabs.com). Do not assume OSS terms cover prod redistribution.

## In this harness

| Item | Location |
|------|----------|
| Local clone | `repos/GitNexus/` |
| Registry (local only, gitignored) | `repos/repos.json` entry `name`: **`GitNexus`**, `defaultBranch`: **`main`** |
| Refresh clone | `bun run repo init --repo GitNexus --human` |
| Curated facts | `knowledge/repos/GitNexus.yaml` |
| This walkthrough | `knowledge/walkthroughs/gitnexus.md` |

Do **not** commit `repos/repos.json`.

## Quick orientation (read-only)

From repo root `repos/GitNexus/`:

1. **`README.md`** — product split (CLI+MCP vs Web UI), `npx gitnexus analyze`, `gitnexus setup`, bridge mode.
2. **`ARCHITECTURE.md`** — monorepo layout, index → graph → tools pipeline, **MCP tool table**, phase DAG.
3. **`CONTRIBUTING.md`** — `cd gitnexus && npm install && npm run build`; PR title conventions.
4. **`TESTING.md`** — Vitest commands for `gitnexus` / `gitnexus-web`.
5. **`RUNBOOK.md`** — operational troubleshooting (stale index, MCP recovery).
6. **`GUARDRAILS.md`** — expectations for safe automation around the tool.

## MCP tools (summary)

Upstream documents the tool surface in **`ARCHITECTURE.md`** (MCP tools section). Representative tools include hybrid search, graph context, impact/blast radius, Cypher, route/tool maps, rename assistance, and group-aware resources (`gitnexus://group/...`). **Do not duplicate** the full table here—link maintenance stays with upstream.

## Typical agent-facing flows

### Index a project (developer machine)

Upsteam Quick Start (from project under analysis):

```bash
npx gitnexus analyze
```

That indexes, may install skills/hooks, and writes agent context files—details in upstream README.

### Wire MCP to an editor

```bash
npx gitnexus setup
```

Upstream README documents editor matrix (Claude Code hooks vs Cursor MCP-only, etc.).

### Bridge local CLI index to the Web UI

Upstream describes **bridge mode**: run **`gitnexus serve`** so the browser UI can attach without re-uploading graphs.

## When editing harness knowledge

- After meaningful upstream pulls, re-run exploration and update **`knowledge/repos/GitNexus.yaml`** (commit hash line + `recent_changes`).
- Prefer linking to **`ARCHITECTURE.md`** for volatile tool lists rather than copying them into YAML.

## References

- Upstream: https://github.com/abhigyanpatwari/GitNexus
- npm package name: `gitnexus` (version pinned in `repos/GitNexus/gitnexus/package.json` at clone time)
