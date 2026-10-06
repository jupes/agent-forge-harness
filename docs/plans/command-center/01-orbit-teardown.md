# Orbit teardown — what it is, what it does well, what we must go beyond

Generated: 2026-10-06
Sources: https://orbit-cli.com/ · https://github.com/constellation-works/orbit (branch `agent-main`; README, `docs/CONFIG.md`, `docs/DEVELOPMENT.md`, `docs/POSITIONING.md`, `docs/LESSONS.md`, `docs/mcp-tool-evidence.md`), read 2026-10-06.
Status: research input for the **Agent Forge Command Center** epic (see `00-README.md`).

Everything below is what Orbit's own docs claim. Nothing was run. Treat it as a feature inventory and a vocabulary, not as verified behavior.

## 1. One-paragraph summary

Orbit calls itself a "local-first runtime for coding agents" and a "local-first delivery layer for AI coding agents". You hand it a spec; it (or a skill inside your agent CLI) splits the spec into tasks, you approve them, and Orbit runs each task in its own git worktree and OS sandbox using one of nine agent CLIs, records every tool call and state transition in an append-only audit store, and ends every run at a pull request. It is a single Rust binary, MIT, no cloud, no telemetry, no API keys of its own (it drives the provider CLIs you are already signed in to). Pre-1.0, about 6k commits, 12 stars at time of reading. macOS/Linux only; Windows via WSL2.

Positioning lens, verbatim from `POSITIONING.md`: "Would this hold up for an engineer who insists on engineering rigor while driving multiple agents against real code?" Auditability wins over performance or ergonomics.

## 2. Feature inventory (grouped the way we will build)

### 2.1 Task graph and lifecycle
- Task states: `proposed → backlog → in-progress → review → done`. "Nothing starts without you": a new task needs explicit approval to leave `proposed`.
- Task fields: title, description, acceptance criteria, file scope, dependencies ("typed relations"), complexity (`low`/`medium`/`high`), optional pinned `crew`, revision marker (updates refuse stale revisions).
- Dependencies gate admission: "declare the order once and the queue enforces it".
- Task IDs minted per machine with a 2–5 letter `task_prefix` (e.g. `ORB-1042`); durable run IDs for unattended operation.
- Task artifacts: `orbit_task_artifact_put/get` attach text or raster files to a task.
- Backup/restore of tasks to a git repository.

### 2.2 Execution
- One isolated git worktree per run; sandbox via `sandbox-exec` (macOS) or Bubblewrap (Linux); memory-bounded cgroups and `worker_containment` systemd scopes on Linux.
- File-level locking / "file reservations": tasks declare file scope; `orbit_task_eligible` lists candidates "free of in-flight lock conflicts"; up to 8 concurrent runs.
- Subprocess environment is an allowlist (`[execution.env] pass = [...]`): "A benignly named credential such as `DATABASE_URL` never reaches an agent unless you name it."
- Repair budgets and failure recovery; `orbit_workflow_run_resume` restarts failed jobs from checkpoints and shows "retry lineage".
- Resource throttle: admission holds tasks when host CPU/memory/disk exceed 90% (resume at 85%).

### 2.3 Routing across providers ("crews")
- A **crew** pins `provider` + `model` + `effort` (`low|medium|high|xhigh|max`), with `enabled`, `description`, `tags`.
- Providers: `claude`, `codex`, `gemini`, `grok`, `copilot`, `cursor`, `pi`, `antigravity`, `opencode`. Always via the provider's CLI, never direct HTTP.
- **Complexity-tiered weighted pools**: `low_complexity_crews = ["luna:50", "sonnet:50"]` and so on; `final_recovery_crews` for last-attempt repair; `review_crew` for the automatic reviewer.
- Crew resolution precedence: `--crew` flag → task's stored crew → `workflow.default_crew` → env `CONSTELLATION_DEFAULT_PROVIDER` → built-in `opus`.

### 2.4 Gates and delivery
- Gated pipeline plan → execute → review; optional second-agent review before PR (`[review] before_pr = true`, bounded by `review.minutes`).
- Every run ends at a PR; Orbit never merges on its own; `--complete` opts into merge; branch protection respected.
- Delivery modes: single-task ship (`orbit run ship <id>`), local merge, bounded backlog drains (`orbit run auto --for 4h --concurrency 8`), scheduled `ship-sweep`, continuous delivery with readiness checks.
- Workflow commits carry task IDs so a commit traces back to prompt, plan, and review.

### 2.5 Observability and audit
- Append-only, queryable event store (`~/.orbit/orbit.db`): "Every tool call, provider exchange, and state transition is recorded as an append-only, queryable event tagged with the agent and model that produced it." Also effort level and executor details.
- Secrets redacted at write time; credential-file patches omitted.
- `orbit audit`, `orbit task show`, `orbit run show`; dashboard renders audit feed and run logs.
- Scoreboard (per-crew outcomes) on the dashboard.
- **Friction ledger**: `orbit friction add` when "the work was harder than it should have been"; a task that resolves a friction closes it; `orbit search` (SQLite FTS5) spans tasks and frictions.

### 2.6 Unattended operation and automation
- Auto-tasks: scheduled templates in `.orbit/auto_tasks/*.yaml` for code review, QA, security scanning; `orbit_auto_task_mint` proposes tasks without dispatching them.
- Routines / `orbit clock` machine scheduler; `orbit_routine_control` toggles and restarts them.
- Distributed multi-machine drains with durable claims; replica checkouts point at an `ownerHost` over SSH; federated MCP namespace.

### 2.7 Control surfaces
- **CLI**: `orbit init`, `orbit workspace init --mcp`, `orbit task add|show|update`, `orbit run ship|show|auto`, `orbit audit`, `orbit search`, `orbit friction add`, `orbit doctor`, `orbit config show|get|set|keys`, `orbit plugin`, `orbit clock`, `orbit web serve`, `orbit mcp serve --operator`, `orbit update --check`.
- **Web dashboard** (`orbit web serve`, localhost or over SSH): task backlog, audit feed, scoreboard, run logs. Mutating routes default to operator-only; Origin/Host protection on every mutation; vendored assets digest-verified.
- **MCP server with two authority levels**: the *operator* session is "the only one that can dispatch workflows, resume runs, or run commands"; agents launched by Orbit get an "agent-only surface". Authority is enforced at call time, not by hiding tools: "every session sees the same `tools/list`". 28 tools advertised, for example `orbit_task_add/list/show/update/eligible`, `orbit_workflow_ship/auto/run_list/run_show/run_resume`, `orbit_auto_task_*`, `orbit_friction_*`, `orbit_search`, `orbit_command_exec` (audited, args redacted), `orbit_agent_invoke` (operator only), `orbit_ui_inspect/open`, `orbit_workspace_list`.
- **In-agent skills**: `orbit`, `orbit-orchestrate` (split spec → queue after approval → run in parallel → diagnose failures), `orbit-setup`.
- **Claude Code mod / plugin**: a band above the prompt showing the workspace's running/blocked/review counts, plus an Orbit pane with a task board; commands `/orbit-board`, `/orbit-ship`, `/orbit-map`. Also a Codex desktop plugin via marketplace and Cursor local plugins. **There is no standalone desktop app**; the "desktop" story is plugins inside the agent CLIs' own UIs.
- **Plugins**: sandboxed, run under explicit permission grants; `plugin_secrets` isolation is tested.

### 2.8 Config model
- `~/.orbit/config.toml` (machine: `[machine]` id/name/task_prefix, containment, memory caps) and `<repo>/.orbit/config.toml` (workspace, gitignored). Workspace overrides global; security keys (`execution.codex.sandbox`, `approval_policy`, `execution.env.pass`) are never inherited once a workspace file exists.
- `orbit config show` prints the merged view **with provenance** (which file each value came from).

### 2.9 Lessons they published (`LESSONS.md`)
1. MCP token cost is real; specialized tools only win when they get a dedicated discovery surface instead of competing with familiar primitives.
2. "Backup and recovery are not optional for long-lived artifacts" (May 2026 artifact-loss incident).
3. Spawned children need panic-safe cleanup on success, failure, panic and timeout, plus an independent sandbox-kill layer (Sept 2026 test-fixture fork storm).

## 3. What Orbit does better than Agent Forge today

| Orbit capability | Why it matters | Agent Forge today (details in `02-gap-analysis.md`) |
|---|---|---|
| One append-only audit of every agent turn/tool call, tagged with agent + model | The command center is only as good as its ledger | No per-tool-call ledger; forge run state is a per-slug JSON file; `ulpz.3` plans a SQLite run ledger |
| Nine agent CLIs behind one crew abstraction | True multi-provider orchestration | Claude Code only as executor; council reaches other providers for *review* only |
| File reservations + conflict-aware admission | Safe parallel workers | Worktrees exist; no reservation or conflict detection |
| Proposed → approval gate → queue → drain | "Nothing starts without you" plus unattended ops | Forge gates are per phase and per human turn; no queue, no drain |
| Operator vs agent MCP authority | Agents can see state but not dispatch | Council MCP exposes review tools only; no operator surface |
| Friction ledger + FTS search | Compounding operational knowledge | `bd remember`, knowledge YAML; no friction concept |
| Config with provenance; env allowlist | Trustworthy unattended runs | Hooks inherit the full environment |

## 4. Where Agent Forge already leads, and must keep leading

- **Beads is a richer graph than Orbit's task table**: epics/features/tasks, typed deps, AC, comments with prefixes, Dolt history, molecules, convoy bundles, `bd remember`. Orbit's task model is flat with typed relations. We keep Beads as the single work graph and make the ledger reference bead IDs rather than inventing a second task store.
- **The Forge pipeline is a methodology, not just a queue**: research → plan → implement → ship with TDD, demo checkpoints, phase gates and evaluator loops. Orbit's "plan → execute → review" is thinner. Forgemaster becomes the *brain* that decides what to queue; the command center becomes the *body* that runs it.
- **Council is a deliberative, multi-provider, anonymised peer review with quorum and a chair**. Orbit's review is a single `review_crew` pass. Council becomes a first-class action on any work item.
- **Knowledge-first exploration** (`knowledge/`, `/sync-knowledge`, `AGENTS.md` scaffolding) has no Orbit counterpart.
- **Windows-native** (Bun + PowerShell). Orbit needs WSL2.

## 5. What "beyond Orbit" means for this epic (the bar)

1. Every agent session attached to the harness, of any provider, reports into one ledger keyed by **bead ID + run ID + session ID**, and the operator can see, in one place, who is doing what, on which worktree, with which model, at what cost, and how far the Forge phase has progressed.
2. The operator can act from that view: approve, queue, pause, reassign to a different crew/tier, **send to council**, or hand back to forgemaster for re-planning.
3. The same control plane is reachable from a desktop app, from a Claude Code mod band/pane, from the CLI, and from an MCP operator surface, all speaking one typed operator API.
4. Parallel workers are conflict-aware (file reservations derived from Beads file maps) and bounded (drains with time and concurrency caps).
5. Everything stays local-first, secret-safe, and reviewable in git, with the Forge methodology (TDD, phase gates, evaluators at or above builder tier) intact.
