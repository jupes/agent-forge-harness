# Roadmap and bead specs — Agent Forge Command Center

Generated: 2026-10-06
Epic: `agent-forge-harness-x1gs` (52 issues, imported by `bun run beads:import-command-center-plan`). The live bead map with IDs and blockers is in [`bead-map.md`](bead-map.md); the canonical definitions (titles, AC, deps) are in `scripts/beads/command-center-plan.ts`.

This file carries what does **not** fit in a bead: wave ordering, reuse pointers, approach notes and pitfalls per bead. Each `<a id>` below is the anchor the bead's `Spec:` line points at.

## How an executor agent picks up a bead

1. `bd ready | grep x1gs` → pick a leaf whose feature you are assigned; `bd show <id>` and read the AC.
2. Read `00-README.md`, `05-decisions.md` (settled; do not reopen), `03-target-architecture.md`, and this file's section for the bead. Then the files named in the section. Do not re-survey what `02-gap-analysis.md` already cites.
3. Run the owning **feature** as a Forge run in its own worktree: `/forgemaster <feature title> --slug cc-<feature>`; the feature's tasks are the plan's demo checkpoints. Single tasks that are already crisp (F9 `fix-refs`, D-beads) may use `/forgemaster-mini`.
4. evaluator rank ≥ builder rank (`.claude/protocols/model-tier-policy.md`). Record `worklog:` and `review:` comments as you go; close with test evidence; ship with the PR template.
5. If the architecture must change, add a `design:` comment on the bead **and** edit `03-target-architecture.md` in the same PR.

## Waves (what can run in parallel)

| Wave | Beads | Why this order |
|---|---|---|
| 0 | `f9-fix-refs`, `d3` (protocol file) | No code dependencies. `d1` and `d2` are decided and closed; every other decision is in `05-decisions.md` |
| 1 | `f0-types`, then `f1-core`, `f2-server`, `f3-config` in parallel | Contracts first; three independent foundations |
| 2 | `f1-hooks`, `f1-forge`, `f1-gates`, `f2-api`, `f3-adapter-claude`, `f4-worktrees` | Each needs one wave-1 piece |
| 3 | `f2-beads-write`, `f2-mcp`, `f3-adapter-codex`, `f4-queue`, `f5-executor`, `f6-source`, `f7-stream`, `f7-ci`, `f1-friction` | Operator surfaces and scheduler pieces |
| 4 | `f4-reservations`, `f7-sessions`, `f7-queue`, `f7-timeline`, `f3-scoreboard`, `f3-adapter-third` | UI and scheduling over the API |
| 5 | `f4-shift`, `f6-action`, `f8-shell`, `f8-mod`, `f7-smiths` | Needs queue + adapters + UI |
| 6 | `f5-orchestrate`, `f9-retire-molecules`, `f4-autotasks`, `f8-notify`, `f8-package`, `f8-other-agents` | End-to-end flows and polish |
| 7 | `f9-guide` | Documents the finished shape |

External prerequisites already open elsewhere: `0xxt` (hook identity), `empi` (verdict binding), `csf2`, `5mge`, `2q5s`, `3u6`. They are wired as `blocks` edges; if one stalls, note it with a `deps:` comment rather than working around it silently.

---

## F0 — Decisions and contracts
<a id="f0-decisions-and-contracts"></a>

Three decisions, one contract file. Decisions are `bd` type `decision`; close each with a `design:` comment that would let a stranger reconstruct the choice.

<a id="d1-desktop-shell"></a>
### D1 Desktop shell — DECIDED: Tauri 2 (`05-decisions.md` #1); closed
- Kept for context. **Evaluated in this order:** Tauri 2 (Rust shell, webview, sidecar support, small installers; needs Rust toolchain and WebView2 on Windows), Electron (Node-native, heavier, easiest Bun sidecar story), PWA (no tray/notification control, no sidecar), mod-only (no standalone app; fails the user's requirement).
- **Spike budget:** one afternoon. Prove: window opens over `http://127.0.0.1:8787` from `bun run dashboard`, a Bun child process is started/stopped by the shell, a tray icon shows a number. Attach a screenshot.
- **Pitfall:** Tauri sidecars must be a single executable; `bun build --compile` produces one. Verify it on Windows with a path containing spaces.

<a id="d2-process-model"></a>
### D2 Process model and ledger location — DECIDED (`05-decisions.md` #2–3); closed
- Reconcile with `docs/plans/self-hosted-ai-agent-stack.md` Checkpoint B (`ulpz.3`): its `RunCorrelation` and metadata-only rule are the schema seed. Recommend one machine-wide `~/.agent-forge/ledger.db` with a `workspace` column; `.tmp/work/ledger.db` only if `ulpz.1` insists on per-workspace isolation.
- Decide who owns the process: `bun run hearth` (manual), Vite dev (spawns it), Tauri sidecar (supervises it). Recommend: all three can start it; a lock file with pid + port + token under `~/.agent-forge/` prevents duplicates.

<a id="d3-onboarding-contract"></a>
### D3 Agent onboarding contract — DECIDED (`05-decisions.md` #4); remaining work is the protocol file
- Write `.claude/protocols/agent-onboarding.md`: Session envelope `{ sessionId, provider, model?, effort?, workspace, worktree?, beadId?, parentSessionId? }`, attach sequence per executor kind (interactive Claude Code via hooks; teammate via hooks + `parentSessionId`; headless via adapter stream; remote via HTTP POST).
- Identity when the provider gives none: mint a ULID, persist at `<worktree>/.agent-forge-session`, reuse until SessionEnd. This is the bridge over `0xxt`.

<a id="f0-types"></a>
### Contracts file
- `types/hearth.ts` next to `types/beads.ts`; validators in `scripts/hearth/validate.ts` (hand-written type guards; no zod). Export `LEDGER_EVENT_KINDS` as a const tuple so emitters and UI share one list.

---

## F1 — Unified ledger
<a id="f1-ledger"></a>

Builds on `ulpz.3`; if `ulpz.3` has not landed when this starts, land its schema here and close `ulpz.3` with a pointer (coordinate via `design:` comments on both).

<a id="f1-core"></a>
### Ledger core and `forge:audit`
- Reuse: `scripts/council/safety.test.ts` fixtures for secret patterns; `scripts/forge/runs-store.ts` for the file-layout/migration style; `{ ok, data, error }` envelope everywhere.
- Schema v1: `events(id INTEGER PK, ulid TEXT UNIQUE, ts TEXT, kind TEXT, workspace TEXT, bead_id TEXT, run_id TEXT, session_id TEXT, provider TEXT, model TEXT, effort TEXT, smith TEXT, payload TEXT)` with indexes on `(bead_id, id)`, `(run_id, id)`, `(session_id, id)`, `(kind, id)`.
- Keep `appendEvent` synchronous and under 1 ms; hooks call it in-process.

<a id="f1-hooks"></a>
### Claude Code hooks
- Edit `.claude/settings.json` hooks: add `UserPromptSubmit`, `PostToolUse` (matcher `*`), `SessionEnd`. Keep existing entries. Hooks receive JSON on stdin (see `0xxt` for the parsing work); read `session_id`, `tool_name`, `tool_input` hash only.
- Fix the dead branch in `.claude/hooks/session.ts:60-64` by wiring SessionEnd.
- Teammates: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is on; detect teammate sessions by the env/cwd they get and set `parentSessionId`.

<a id="f1-forge"></a>
### Forge run state v2
- `ForgeState.schemaVersion = 2`, `executor?: Executor`. Migration in `runs-store.ts` beside the legacy one. `phase-gate --write` and `auto-loop-cli` call `appendEvent`.
- `csf2`: in `runs.ts` `RunSummary`, `next` must be `null` when the last review round halted (`decideNext === "halt"`); add the failing test first.

<a id="f1-gates"></a>
### Gates, verdicts, council
- `quality-gate.ts` already builds an identity object (`scripts/quality-gate-identity.ts`); add `appendEvent({ kind: "gate.ran", ... })` after the JSONL write. Verdict events come from the strict eval path (`AGENT_FORGE_EVAL_VERDICT=strict`). Council: `scripts/council/service.ts` run lifecycle → two events with cost summary.

<a id="f1-friction"></a>
### Friction ledger as Beads
- Command `.claude/commands/friction.md` + skill `friction`; script `scripts/ledger/friction.ts`. Resolution: a closing `worklog:` that contains `resolves: <friction-id>` closes the friction (hook in the F2 close route and in the `/ship` step).

---

## F2 — Control plane and operator surfaces
<a id="f2-hearth"></a>

<a id="f2-server"></a>
### Standalone server
- Move handlers out of `scripts/dashboard/dev-api.ts` and `scripts/council/dashboard.ts` into `scripts/hearth/routes/*.ts`; keep their tests by exporting the same handler functions. `vite.dashboard.config.ts` gets a `server.proxy` for `/__agent-forge` and keeps only `rebuild-pages` locally.
- Token: `~/.agent-forge/operator.token` created at boot (0600 where supported); the dashboard fetches it via a loopback-only `GET /token` that requires `Origin` to be the dev origin.

<a id="f2-api"></a>
### Operator API and SSE
- Route table in `03-target-architecture.md` §6 is the contract; add a route-table test that asserts every POST writes `operator.action` (iterate the table, not hand-written cases).
- SSE: generalise `scripts/council/dashboard.ts:102-123` into `scripts/hearth/stream.ts` (snapshot on connect, deltas by ledger `id` cursor, 15 s keepalive).

<a id="f2-beads-write"></a>
### Beads write path
- Use `execFileSync("bd", [...])` only. Priority via the `beads-priority-assignment` rubric (expose its table to the UI as options). Remember `bd-create-repo-flag-silently-orphans-issue`: never pass `--repo`.

<a id="f2-mcp"></a>
### MCP operator server
- Model it on `scripts/council/mcp.ts` (stdio JSON-RPC, tool registry). Tools: read `forge_sessions_list`, `forge_queue_list`, `forge_events_query`, `forge_crews_list`; agent-writable `forge_bead_propose`, `forge_friction_add`, `forge_event_note`; operator `forge_queue_approve|pause|resume|reassign`, `forge_drain_start|stop`, `forge_council_start`, `forge_run_replan`. Authority = presence of the operator token at launch (`--operator`), checked per call.
- `.mcp.json` at the root registers `agent-forge` (this) and keeps council reachable.

---

## F3 — Smiths and executor adapters
<a id="f3-smiths"></a>

<a id="f3-config"></a>
### Config with provenance
- TOML parsing: Bun has `Bun.TOML`? If not stable, use a tiny vendored parser or `smol-toml` (justify the dep in the PR). Provenance = map key → `{ value, source: "builtin" | "~/.agent-forge/config.toml" | "<harness>/agent-forge.toml" | "env" }`.
- Built-in smiths (decided): `claude-master` (highest Claude rank, effort high), `claude-journeyman` (default Claude), `claude-apprentice` (cheapest Claude), `codex-journeyman`. Default smith `claude-journeyman`. Benches: `[benches] low = ["claude-apprentice:70", "codex-journeyman:30"]`, `medium`, `high`. Keep names provider-prefixed.

<a id="f3-adapter-claude"></a>
### Claude Code adapter
- `claude -p "<prompt>" --output-format stream-json --permission-mode <per config>` inside the worktree. Parse NDJSON; map `tool_use` → `tool.called`. Record model from the first `system` message when present.
- Cleanup: register `process.on("exit"|"SIGINT"|"SIGTERM")` kill handlers and a timeout; on Windows use `taskkill /T /F` for the tree.

<a id="f3-adapter-codex"></a>
### Codex adapter and doctor
- `codex exec --json` (verify flag names against the installed version; record them in the bead). Run `bun run codex:sync` before spawning so skills exist. `forge:doctor` reports `{ provider, found, version, path }` per adapter.

<a id="f3-adapter-third"></a>
### Third adapter
- Try `opencode run` and `gemini -p` headless on Windows; pick the one with stable JSON output. Add `scripts/executors/contract.test.ts` that runs every adapter against the same fake-binary fixtures.

<a id="f3-scoreboard"></a>
### Scoreboard
- Pure aggregation over the ledger; expose as CLI and route. Gives `7xw` its evidence base.

---

## F4 — Scheduler
<a id="f4-scheduler"></a>

<a id="f4-queue"></a>
### Queue state machine
- Labels `queue:proposed|approved|queued|running|review|done|paused|halted` and `complexity:low|medium|high`. Transition table in one place; `bd update <id> --labels` via arrays. Beads `status` stays what it is (open/in_progress/closed); queue labels are orthogonal.

<a id="f4-worktrees"></a>
### Unified worktree registry
- `git worktree list --porcelain` is the source of truth; `trees/.state.json` becomes a cache with `ownerSessionId`, `beadId`. Fix `5mge` by switching to argument arrays; test with `C:\\path with spaces\\`.
- `aenb`: print a warning in `worktree create` output and in the protocol; the real fix (per-worktree stash) is out of scope.

<a id="f4-reservations"></a>
### File reservations and eligibility
- File-map block format in task descriptions: a `## Files` section with one glob per line. Parser in `scripts/scheduler/filemap.ts`; eligibility extends `scripts/beads/convoy-bundles.ts` (keep its bundle ordering tests green).

<a id="f4-shift"></a>
### `forge:shift`
- Defaults (decided): concurrency 2, `--for 2h`, admission paused above 85% CPU or memory, 3 repair attempts then `queue:halted`; PRs opened, never merged.
- Loop: pick → reserve → worktree → adapter run with `/forgemaster-auto` prompt → gate → PR → release. Concurrency with a semaphore; `--for` enforced by a deadline passed to adapters. Throttle: sample `os.loadavg`/`freemem` (Windows: `wmic`/PowerShell counters behind a small helper). Never merges.

<a id="f4-autotasks"></a>
### Auto-tasks
- YAML templates with `schedule`, `predicate` (a named TS function in `scripts/scheduler/predicates.ts`), and bead fields. `mint` records the window in the ledger so re-runs are idempotent.

---

## F5 — Forgemaster expansion
<a id="f5-forgemaster"></a>

<a id="f5-executor"></a>
### `--smith` and file maps in plans
- Commands/skills to edit: `.claude/commands/forgemaster*.md`, `forge-*.md`, `.claude/skills/forge-plan/SKILL.md` (task template gains `## Files` and a complexity label), `.claude/skills/forge-implement/SKILL.md` (reads them). `phase-gate --executor '<json>'`.

<a id="f5-orchestrate"></a>
### `/forge-orchestrate`
- Composition, not new engines: research/plan skills → `to-issues` → queue propose → **stop for approval** → `forge:shift` → diagnosis (query ledger per failed run; file fix beads or `POST /runs/:slug/replan`). Write the skill so it degrades to a dry run when no adapter is available.

### Molecules — RETIRED (`05-decisions.md` #14)
- No spike. The shift's DAG is the Beads dependency graph. Cleanup is `f9-retire-molecules`.

---

## F6 — Council as a first-class action
<a id="f6-council"></a>

<a id="f6-source"></a>
### Bead source kind
- Extend `ContextSourceKind` (`scripts/council/types.ts:67`) with `"bead"`; builder in `scripts/council/context.ts` using `bd show --json`, `bd comments <id> --json`, plan/research by slug (`.tmp/work/forge-runs/*.json` maps slug → artifacts), and `pr-source.ts` when a PR URL appears in comments. Truncation order: AC → latest comments → plan excerpt → diff.

<a id="f6-action"></a>
### Send to council
- On demand only (decided). `[review] before_pr` is a config toggle, default off, 1.00 USD ceiling when on.
- UI entry points: `IssueDetailPanel`, `ForgeRunIsland` checkpoints, Queue cards. Server posts `review: COUNCIL <recommendation> — findings b/h/m/l` plus a link to `reports/council-runs/<id>/report.md`. Cancelled/failed runs post `review: COUNCIL incomplete` so nothing reads as a pass.

---

## F7 — Command center UI
<a id="f7-ui"></a>

<a id="f7-stream"></a>
### `use-stream`
- One `EventSource` per app; merge into `docs/js/app-state.ts`. Static mode (GitHub Pages) detects no control plane and falls back to `docs/data/beads.json` with actions disabled and a banner.

<a id="f7-sessions"></a>
### Sessions board
- Nocturne `Table` + `StatCard`. Nest teammates under their lead via `parentSessionId`. Cost column reads usage from `session.ended` payloads where providers report it.

<a id="f7-queue"></a>
### Workbench
- Columns = queue states; actions call F2 routes; conflict badge from `GET /reservations` overlap check done client-side with the same glob matcher used server-side (share `scripts/scheduler/filemap.ts` through the Vite alias used for `issues-selection`).

<a id="f7-timeline"></a>
### Timeline
- Virtualised list (hand-rolled windowing; no new dependency unless justified). Deep links `#/timeline?bead=<id>`.

<a id="f7-smiths"></a>
### Smiths & config
- Read-only; shows provenance and doctor rows. Editing remains in files.

<a id="f7-ci"></a>
### Playwright in CI
- `playwright.config.ts` `webServer` → start control plane then dashboard; GitHub Actions job with `actions/cache` for browsers; artifacts on failure. Closes `2q5s`.

---

## F8 — Desktop app and in-agent surfaces
<a id="f8-desktop"></a>

<a id="f8-shell"></a>
### Shell
- `apps/desktop/` (Tauri 2 unless D1 says otherwise). Sidecar = `bun build --compile scripts/hearth/server.ts`. Health check `GET /health`; restart with backoff; tray menu reads `/stream`. Deep link scheme `agent-forge://bead/<id>`.

<a id="f8-notify"></a>
### Notifications
- Map: `shift.stopped(reason=halt)`, `gate.ran(ok=false)`, `council.run.finished`, `bead.transitioned(to=proposed)`. Approve action posts with the operator token the shell already holds. Quiet hours in `[desktop]` config.

<a id="f8-mod"></a>
### Claude Code mod
- Load the `plugin-authoring` skill first. Plugin dir `.claude/plugins/forge-command-center/`; poll `/sessions` and `/queue` every few seconds; band shows `▶ n · ⏸ n · 👁 n`; pane renders the workbench in text; `/forge-council <bead>` → `POST /council/runs`.

<a id="f8-package"></a>
### Packaging
- Tag-triggered CI job; unsigned builds documented with the SmartScreen caveat; update check hits GitHub releases API; Settings page embeds `forge:doctor` and config provenance.

<a id="f8-other-agents"></a>
### Codex and Cursor surfaces
- `sync-codex.ts` writes the MCP server block into `.codex/config.toml`; a Cursor `.cursor/mcp.json` snippet is generated alongside. Manual evidence is acceptable here.

---

## F9 — Docs, knowledge, migration
<a id="f9-docs"></a>

<a id="f9-fix-refs"></a>
### Stale references (do first)
- `knowledge/_shared.yaml:73-76` → point `research_notes` at `docs/plans/command-center/`. `.claude/molecules/README.md` same. `bun run agents-md scaffold --write` for the eight directories the SessionStart hook lists, then `bun run agents-md validate --hook`.

<a id="f9-retire-molecules"></a>
### Retire molecules
- Mark `.claude/molecules/README.md` historical and keep the JSON as an archived example; remove `molecules:check` and `scripts/molecules/check.ts`; keep `parse.ts` only if something still imports it; scrub references in `.claude/workflows`, `docs/HARNESS-GUIDE.md`, `README.md`.

<a id="f9-guide"></a>
### Guide and README
- New chapter in `docs/HARNESS-GUIDE.md` (concepts: ledger, smiths, queue, shift, council action, desktop, mod); README script table; CLAUDE.md slash-command table (`/friction`, `/forge-orchestrate`, `/forge-board`, `/forge-council`); session-completion protocol mentions the ledger; link `.claude/protocols/agent-onboarding.md`.
