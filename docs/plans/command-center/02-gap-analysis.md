# Gap analysis — Agent Forge today vs Orbit vs the Command Center target

Generated: 2026-10-06 (survey of this checkout at `12fd46e`)
Status: research input for the **Agent Forge Command Center** epic (see `00-README.md`). Every "today" claim below was checked against real files; paths are relative to the harness root.

## 1. Capability matrix

Legend: ✅ have · 🟡 partial · ❌ missing · ★ target goes beyond Orbit

| Capability | Orbit | Agent Forge today | Target |
|---|---|---|---|
| Work graph with epics, deps, AC, comments, history | 🟡 flat tasks + typed relations | ✅ Beads (`bd`, Dolt) | ✅ keep Beads as the only work graph ★ |
| Research → plan → implement → ship methodology, TDD, phase gates | 🟡 plan/execute/review | ✅ `/forgemaster`, `scripts/forge/*` | ✅ keep; forgemaster becomes the brain that feeds the queue ★ |
| Per-run state | task + run rows in SQLite | 🟡 `.tmp/work/forge-runs/<slug>.json` (`scripts/forge/phases.ts` `ForgeState`) | ✅ run state v2 carries `executor` and is mirrored into the ledger |
| Audit of every agent turn / tool call, tagged with agent + model | ✅ append-only `orbit.db` | ❌ only `~/.claude/logs/agent-forge/<date>/session.jsonl` (git metadata at SessionStart) and `quality-gate.jsonl`; the PreToolUse hook records nothing | ✅ unified SQLite ledger (`ulpz.3` scope) fed by PostToolUse/SessionStart/SessionEnd hooks and by every script that changes state |
| Executor identity (provider, model, effort, session) on a run | ✅ crews | ❌ only `checkout` and free-text `ReviewRound.tier`; `CLAUDE_TASK_ID` env is not set by Claude Code (bug `0xxt`) | ✅ typed `Executor` on run, event, gate, verdict |
| Multi-provider execution (spawn agent CLIs) | ✅ 9 CLIs | ❌ nothing spawns `claude`, `codex` or any CLI; `scripts/sync-codex.ts` only mirrors skills/commands for Codex | ✅ executor adapters: Claude Code, Codex, one more to prove the seam |
| Multi-provider *review* | 🟡 single `review_crew` | ✅ council (anthropic, openai, deepseek, qwen, openrouter; `scripts/council/providers.ts:45-51`) | ✅ council as a first-class action on any bead ★ |
| Routing by complexity / tier | ✅ weighted crew pools, config with provenance | 🟡 `.claude/protocols/model-tier-policy.md` is "convention, not automation" | ✅ crews as data: provider + model + effort + pools; `forge:config show` with provenance |
| Approval gate before work starts ("nothing starts without you") | ✅ proposed → backlog | 🟡 phase gates and human turns in `/forgemaster`; no queue | ✅ queue states layered on Beads: proposed → approved → queued → running → review → done |
| Parallel workers with conflict avoidance | ✅ file reservations, `task_eligible` | ❌ worktrees (`scripts/worktree.ts`, `trees/.state.json`) with no reservations; conflict table is manual (`.claude/workflows/epic.md:266-274`); `.claude/worktrees/*` invisible to the dashboard | ✅ reservations derived from Beads file maps; eligibility API; one worktree registry |
| Unattended bounded drains | ✅ `orbit run auto --for 4h --concurrency 8` | 🟡 `/forgemaster-auto` for a single run; `scripts/forge/auto-loop.ts` is a pure decision function | ✅ `forge:drain --for --concurrency` with panic-safe cleanup and resource throttle |
| Scheduled auto-tasks that mint proposals | ✅ `.orbit/auto_tasks/*.yaml` | ❌ | ✅ templates that mint `proposed` beads (review, QA, security sweep) |
| Friction ledger + search | ✅ `orbit friction add`, FTS5 | ❌ (`bd remember` and knowledge YAML are adjacent) | ✅ frictions are Beads issues (type chore, label `friction`) linked to ledger events ★ |
| Operator API | ✅ dashboard routes, operator-only mutations | 🟡 Vite middleware (`vite.dashboard.config.ts`, `scripts/dashboard/dev-api.ts`); one mutation (review comment) | ✅ standalone Bun control-plane server, typed routes, every mutation audited |
| MCP surface | ✅ 28 tools, operator vs agent authority at call time | 🟡 council only (`scripts/council/mcp.ts`: `council_*`), no `.mcp.json`; `3u6` spike open | ✅ `forge_*` operator MCP with two authority levels |
| Live view of sessions/agents | ✅ dashboard board, audit feed, scoreboard | ❌ forge-run page is one fetch per load; SSE exists only for council (`scripts/council/dashboard.ts:102-123`) | ✅ sessions board, run timeline, queue board, scoreboard, all SSE |
| Write actions from UI | ✅ | 🟡 approve/request-changes comment on a checkpoint (`docs/js/islands/ForgeRunIsland.tsx`); bead builder only copies a `bd create` line | ✅ create/claim/close beads, approve/queue/pause/reassign, send to council |
| Desktop app | ❌ (Claude Code mod band + pane, Codex/Cursor plugins) | ❌ | ✅ Tauri shell + sidecar, tray, notifications ★; plus a Claude Code mod |
| Secret safety for unattended runs | ✅ env allowlist, redaction at write | 🟡 council redacts/refuses secrets; hooks inherit full env | ✅ env allowlist for spawned executors, redaction at ledger write |
| Windows-native | ❌ WSL2 | ✅ Bun + PowerShell | ✅ ★ |
| Knowledge-first exploration | ❌ | ✅ `knowledge/`, `/sync-knowledge`, `AGENTS.md` scaffolds | ✅ keep ★ |

## 2. What exists and will be reused (do not rebuild)

| Asset | Where | Reuse in the target |
|---|---|---|
| Forge run state, phase gate, auto-loop decision | `scripts/forge/{phases,runs,runs-store,phase-gate,auto-loop}.ts` | Extend `ForgeState` with `executor`, emit ledger events on every `--write` and decision |
| Review ledger + evaluator convention | `ForgeState.reviews`, `.claude/agents/evaluator.md`, `.claude/protocols/evaluation-verdict.md` | Verdicts become ledger events bound to run + executor (`empi`) |
| Quality gate + identity | `.claude/hooks/quality-gate.ts`, `scripts/quality-gate-identity.ts` | Gate results become ledger events; identity fix is `0xxt` |
| Council engine, SSE, MCP, artifacts | `scripts/council/*` | Add `bead` source kind; expose "send to council" through the operator API; council events flow into the ledger |
| Dashboard (Preact + Vite, Nocturne DS, islands) | `docs/js/*`, `docs/js/ds/*`, `scripts/dashboard/*` | The command center *is* this app, re-pointed at the control-plane server and given write actions; Tauri wraps it |
| Beads snapshot builder and normalizers | `scripts/build-pages.ts`, `scripts/beads-dashboard.ts` | Keep for static mode; live mode reads through the control plane |
| Convoy bundles (parallel batches respecting `blocks`) | `scripts/beads/convoy-bundles.ts` | Becomes the eligibility/scheduling core once file reservations are added |
| Molecules (JSON DAG of steps with gates) | `.claude/molecules/*`, `scripts/molecules/parse.ts` | Candidate format for drain plans; stays advisory until a runtime bead proves it |
| Worktree helper | `scripts/worktree.ts`, `trees/.state.json` | Unify with `.claude/worktrees/*`; fix `5mge`; reservations attach to worktree records |
| Codex mirror | `scripts/sync-codex.ts` | Base for the Codex executor adapter (skills/commands already portable) |
| Idempotent bead import pattern | `scripts/beads/import-anthropic-harness-plan.ts` | Generalised into `scripts/beads/plan-import.ts`; this epic is imported by `scripts/beads/import-command-center-plan.ts` |
| Self-host plan: `RunCorrelation`, SQLite metadata-only ledger (Checkpoint B) | `docs/plans/self-hosted-ai-agent-stack.md`, beads `ulpz.3`, `0xxt`, `empi` | **The ledger foundation of this epic is `ulpz.3`.** The command center extends its schema; it does not create a second store |
| Agent Teams runtime flag | `.claude/settings.json` (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, tmux teammates) | Claude Code teammates are one executor kind the ledger must see |

## 3. Defects and drift the survey found (fold into the epic)

1. **SessionEnd never fires.** `.claude/hooks/session.ts:60-64` handles `SessionEnd` (would `bd dolt push`) but `settings.json` wires no SessionEnd hook. Fix as part of the hook telemetry task.
2. **Hook identity env vars are not set by Claude Code** (`CLAUDE_TASK_ID` / `CLAUDE_HOOK_EVENT`, `.claude/hooks/quality-gate.ts:138-139`). Tracked as `0xxt` (P1). The ledger task depends on it.
3. **`knowledge/_shared.yaml:73-76` and `.claude/molecules/README.md` cite a deleted file** (`knowledge/gas-town-harness-insights.yaml`, removed in `78dba0e`). Fix in the docs task.
4. **`forge:runs` advertises the next phase for a halted run** (`csf2`, P1). Fix inside the run-state v2 task.
5. **Worktree helper breaks on Windows paths with spaces** (`5mge`) and **shared stash can swap sessions' WIP** (`aenb`). Both sit under the worktree registry task.
6. **Playwright is not in CI** (`2q5s`, `p5k`). The command center UI tasks require it.
7. **README says "GitHub Pages data" but no Pages workflow exists**; `.github/workflows/quality.yml` runs typecheck, lint, `bun test` only.

## 4. Overlap with open epics (reuse, supersede, or leave alone)

| Issue | Relationship | Decision |
|---|---|---|
| `ulpz` self-host epic (`.1` topology in progress; `.3` SQLite run ledger; `.5` OpenHands worker) | `.3` is the ledger this epic needs; `.5` is a fourth executor adapter | Command-center ledger tasks **depend on `ulpz.3`**; `.5` stays in `ulpz` and plugs into the adapter interface defined here. `.2/.4/.6/.7/.8` untouched |
| `t1b1` council epic (`.6` calibration, `.9` webpage source open) | council is reused as-is | Bead-source and send-to-council live here; `.6`/`.9` stay in `t1b1` |
| `3u6` custom MCP server spike | superseded in scope | Close `3u6` when the operator MCP task lands (note it in the task) |
| `7xw` adversarial review of lead output | partly covered by evaluator + auto-loop | Leave open; the scoreboard task gives it the data it needs |
| `0xxt`, `empi` (P1 bugs) | prerequisites for executor identity and verdict binding | Ledger feature depends on both |
| `csf2`, `5mge`, `aenb`, `2q5s`, `p5k` | defects in surfaces this epic rewrites | Absorbed as dependencies of the owning tasks (listed in `04-roadmap-and-beads.md`) |

## 5. Risks specific to this rework

- **Second task store by accident.** Any "queue" or "session" table that duplicates Beads status will drift. Rule: Beads status is truth for work; the ledger stores *events* about work and references bead IDs.
- **Token cost of MCP surfaces** (Orbit lesson 1). Keep the operator MCP small and give it a dedicated discovery surface; agents get read-mostly tools.
- **Spawned CLIs on Windows.** Headless `claude -p` and `codex exec` must be exercised on Windows early; quoting and env allowlists are where `5mge` already bit us.
- **Scope creep into a hosted product.** Local-first and loopback-only remain invariants; no auth system, no multi-tenant.
- **Desktop shell choice is reversible only early.** Decide shell (`D1`) before any UI task assumes window APIs.
