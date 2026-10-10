# Target architecture — the Agent Forge Command Center

Generated: 2026-10-06
Status: design baseline for the **Agent Forge Command Center** epic. All open choices were settled by the owner on 2026-10-06 in `05-decisions.md`, including the vocabulary (smith, rank, bench, shift, hearth, workbench). This file is the contract executor agents build against.

## 1. One sentence

Agent Forge becomes a local-first **control plane** where every agent session of any provider reports into one ledger keyed by bead + run + session, and the operator can observe and direct all of it from a desktop app, a Claude Code pane, the CLI, or an MCP operator surface, with Beads as the only work graph and forgemaster as the planning brain.

## 2. Invariants (do not trade these away)

1. **Beads is the only work graph.** Queue states, reservations and verdicts are *events about* beads, never a second task table. If the ledger and Beads disagree, Beads wins and the ledger records the disagreement.
2. **Local-first, loopback-only.** The control plane binds to `127.0.0.1`, checks `Origin`/`Host` on every mutation, and holds a per-boot operator token. No accounts, no multi-tenant, no cloud sync.
3. **Every mutation is audited.** A ledger event precedes the side effect; events are append-only with redaction at write.
4. **Executors are driven through their own CLIs** (`claude`, `codex`, …) under an environment allowlist. The harness never holds provider API keys for execution; the council keeps its existing per-provider HTTP transports for review.
5. **Forge methodology stays intact.** TDD, phase gates, evaluator rank at or above builder rank, PR template, `bun run quality-gate`.
6. **Windows is a first-class host.** Everything runs under Bun on Windows without WSL; path quoting is tested with spaces.
7. **Nothing starts without the operator.** Minted work enters as `proposed`; only an operator action (UI, CLI, MCP operator tool) approves it. Unattended shifts only consume already-approved work.

## 3. Component map

```
                 ┌───────────────────────────── control surfaces ─────────────────────────────┐
                 │  Desktop app (Tauri shell)   Claude Code mod (band + pane)   CLI   MCP (operator / agent)  │
                 └──────────────┬──────────────────────┬──────────────────┬────────────┬──────────┘
                                │ HTTP + SSE (loopback, typed routes)     │            │ stdio
                 ┌──────────────▼──────────────────────────────────────────▼────────────▼──────────┐
                 │                      Control-plane server  (node:http, scripts/hearth/)  │
                 │   operator API · event stream · queue + reservations · smiths · council bridge     │
                 └──────┬───────────────┬──────────────────┬──────────────────┬──────────────────────┘
                        │               │                  │                  │
               ┌────────▼───────┐ ┌─────▼──────┐  ┌────────▼────────┐ ┌──────▼─────────┐
               │ Ledger (SQLite │ │ Beads (bd, │  │ Executor        │ │ Council engine  │
               │ bun:sqlite,    │ │ Dolt)      │  │ adapters        │ │ (scripts/council)│
               │ ulpz.3 schema) │ │ work graph │  │ claude · codex  │ │ seats + chair   │
               └────────▲───────┘ └────────────┘  │ · opencode …    │ └─────────────────┘
                        │ events                  └───────┬─────────┘
   ┌────────────────────┴─────────────────────────────────┴──────────────────────────┐
   │ Emitters: Claude Code hooks (SessionStart/End, PostToolUse, Stop), forge phase-gate │
   │ and auto-loop, quality-gate, worktree registry, council runs, spawned CLIs (stream) │
   └──────────────────────────────────────────────────────────────────────────────────┘
```

## 4. Domain model (ubiquitous language)

| Term | Meaning | Keyed by |
|---|---|---|
| **Workspace** | A registered repo checkout the control plane manages (`repos/repos.json` entry or the harness itself) | path |
| **Bead** | A Beads issue; the unit of work | `agent-forge-harness-xxxx` |
| **Run** | One Forge pipeline execution for a slug (existing `ForgeState`), now with an `executor` | `slug` |
| **Session** | One live agent process attached to the harness (Claude Code interactive, Claude teammate, headless `claude -p`, `codex exec`, …). Its `kind` is one of `interactive`, `teammate`, `subagent`, `headless`, `remote`; a subagent is a child of the session that launched it | `sessionId` (provider-issued where available, else minted) |
| **Executor** | `{ provider, model, effort, smith?, sessionId? }`; who is doing the work | embedded on run/event/gate/verdict |
| **Smith** | Named `{ provider, model, effort, enabled, tags }` in config; who does the work | smith name (`claude-journeyman`, …) |
| **Rank** | Policy level `master` / `journeyman` / `apprentice` that maps work onto smiths; evaluator rank ≥ builder rank | rank |
| **Bench** | Weighted set of smiths for one complexity class (`low`, `medium`, `high`) | bench name |
| **Hearth** | The always-on local control-plane server (`bun run hearth`), one per machine | lock file `~/.agent-forge/hearth.lock` |
| **Workbench** | The board of approved and running work (dashboard route, Claude Code pane) | — |
| **Event** | Append-only ledger row: `{ ts, kind, beadId?, runId?, sessionId?, executor?, workspace, payload(redacted) }` | autoincrement + ULID |
| **Queue state** | Derived state of a bead for scheduling: `proposed → approved → queued → running → review → done` (plus `paused`, `halted`) stored as Beads label/metadata plus ledger transitions | bead |
| **Reservation** | Claim on a set of file globs by a running session in a worktree, derived from the bead's file map | bead + worktree |
| **Shift** | Bounded unattended loop: pick eligible queued beads, assign smiths, spawn executors, respect concurrency and time caps | shift id |
| **Friction** | A Beads chore labelled `friction` linked to the event that caused it; resolved by the bead that fixes it | bead |
| **Verdict** | Evaluator or council outcome bound to run + executor (`empi`) | event |

## 5. Ledger (absorbs `ulpz.3`)

- Storage (decided): one `bun:sqlite` file at `~/.agent-forge/ledger.db` with a `workspace` column; nightly backup to `~/.agent-forge/backups/` keeping 14 days; events older than 90 days compacted to daily summaries. Metadata-only by default: no prompt bodies, no source bodies, no tool output bodies; hashes and sizes instead. Opt-in bodies per event kind with redaction.
- Event kinds (v1): `session.started|ended`, `tool.called` (name, duration, exit, args hash), `prompt.submitted` (hash, length), `run.phase.entered|completed`, `review.recorded`, `gate.ran`, `verdict.bound`, `bead.transitioned` (queue state), `reservation.acquired|released`, `shift.started|stopped`, `council.run.started|finished`, `friction.recorded`, `operator.action` (every mutation).
- Payload notes: `session.started` carries the session `kind`, its `worktree` and, for a child, `parentSessionId`. `review.recorded` carries the `action` the review loop took (`advance`, `revise`, `halt`). `gate.ran` carries the `trigger` (the hook event that ran the gate) when known. `verdict.bound` has an optional `evaluator` until the verdict file names one (verdict v2). The opt-in bodies are exactly `verdict.bound.summary` and `council.run.finished.summary`, stored redacted and capped. A hook-sourced `tool.called` has no exit code.
- Besides events, the ledger keeps a `session_models` cache table (the last model and effort seen per session). It is a lookup for emitters that run outside the session, not an event.
- Query surface: `bun run forge:audit --bead <id> | --run <slug> | --session <id> | --since <iso> [--kind ...] --json`. `--bead` also returns the other events of any session that touched the bead; `--bead-exact` returns only events tagged with it. The default scope is the workspace of the current directory (`--all-workspaces` lifts it); `--after-id` and `--limit` page by event id. `--backup` writes a dated snapshot and prunes old ones; `--compact` folds events past retention into daily summaries.
- Emitters are thin: a single `appendEvent()` in `scripts/ledger/` used by hooks, forge scripts, quality gate, worktree registry, council, and adapters. Hooks must stay fast (one sync insert, no network).

## 6. Control-plane server

- `scripts/hearth/server.ts` (`bun run hearth`), a `node:http` server on `127.0.0.1:<port>`; the Vite dashboard proxies `/__agent-forge/*` to it in dev; the Tauri sidecar supervises it in desktop mode.
- One route table (`scripts/hearth/api.ts`; rows in `scripts/hearth/routes/operator.ts` and `operator-reads.ts`), served under `/__agent-forge`. A row is method, path, validator and effect; the runner applies everything else, so a row added later gets it by being in the table.
- Every row answers JSON `{ ok, data, error }` and requires a **declared same-origin** request: an `Origin` equal to the control plane's own, or `Sec-Fetch-Site: same-origin`. A script declares `Origin: http://127.0.0.1:<port>`. A request that repeats `Origin`, `Sec-Fetch-Site`, `Host` or either header below is refused.
- A mutation also needs the operator token in `X-Agent-Forge-Operator`. The token is per hearth and per start: the one this hearth minted, honoured only while the file its lock names (`tokenFile`, `<home>/tokens/<hash(root)>.token`) still holds it. Missing or wrong is 403 and nothing is written. `GET /token` serves it to a same-origin page and answers 503 whenever no token could be honoured.
- `X-Agent-Forge-Surface` (`ui` | `cli` | `mcp` | `api`; absent means `api`) is stored on the audit row. It is a label the client declares, not a credential.
- Every `POST` writes `operator.action` first, then performs the effect through the same scripts the CLI uses (no second implementation). The effect runs only if the ledger stored the row; otherwise the answer is 503 and nothing was done. A request refused for its origin, its token or its content writes nothing. The row records an authorised, valid attempt: an effect that then refuses leaves the row, and the effect's own events or comment carry the outcome.
- Routes (the contract):
  - `GET /sessions`, `GET /runs`, `GET /runs/:slug`, `GET /events?…`, `GET /queue`, `GET /reservations`, `GET /smiths`, `GET /config` (with provenance), `GET /stream` (SSE: snapshot + deltas)
  - `POST /beads` (create), `POST /beads/:id/claim|close|comment`
  - `POST /queue/:id/approve|queue|pause|resume|reassign` (`{ smith }`)
  - `POST /council/runs` (`{ source: { kind: "bead", id } , profile, budget }`), `POST /council/runs/:id/cancel`
  - `POST /shifts` (`{ for, concurrency, filter }`), `POST /shifts/:id/stop`
  - `POST /runs/:slug/replan` (hands a run back to forgemaster with a reason)
- What is mounted (`x1gs.3.2`). A route is mounted only once its effect exists; nothing accepts a mutation and does nothing.

  | Route | State | Notes |
  |---|---|---|
  | `GET /sessions` | mounted | `?open=1`, `?limit=` (1–500, default 100). Folded from the newest 50,000 ledger events of the workspace. Reports `lastEventAt` and `endedAt`; asserts nothing about a session being alive. |
  | `GET /runs`, `GET /runs/:slug` | mounted | The run registry of the checkout. `/runs/:slug` adds the stored state and the run's newest 200 ledger events. |
  | `GET /events` | mounted | `bead`, `beadExact`, `run`, `session`, `since`, `kind`, `after`, `limit` (1–1000, default 200), by the rules of `forge:audit`. Always this workspace. Answers `{ events, cursor, more }`. An unknown or repeated parameter is 400. |
  | `GET /queue` | mounted | `?state=` (comma list). Reads `queue:<state>` labels from Beads with a read-only `bd list`. One entry per (bead, queue label). Empty until `x1gs.5.1` writes those labels. |
  | `GET /reservations` | mounted | Claims acquired and not released, from the ledger. Empty until `x1gs.5.x` emits them. |
  | `GET /smiths`, `GET /config` | mounted | The config files of the hearth's checkout, with provenance. The hearth's own environment is not read. |
  | `GET /stream` | mounted | See below. |
  | `POST /council/runs`, `POST /council/runs/:id/cancel` | mounted | Body today is the council service's input (`sourceType`, `source`, `profile?`, `maxUsd?`, `maxBytes?`, `runId?`, `redactSecrets?`, `beadId?`). The `{ source: { kind: "bead", id } }` form arrives with `x1gs.7.1`. Also served at `/council-api/runs…`, the paths the dashboard has always used. |
  | `POST /dev-api/forge-run/review` | mounted | The checkpoint review that predates this table: a `review:` comment in Beads. Same path and answers; now an audited action. |
  | `POST /beads`, `POST /beads/:id/claim\|close\|comment` | not mounted | `x1gs.3.3` |
  | `POST /queue/:id/approve\|queue\|pause\|resume\|reassign` | not mounted | `x1gs.5.1` |
  | `POST /shifts`, `POST /shifts/:id/stop` | not mounted | `x1gs.5.3` |
  | `POST /runs/:slug/replan` | not mounted | the forgemaster expansion (F5) |

- Stream (`scripts/hearth/stream.ts`). A new connection gets one `snapshot` event: `{ cursor, sessions, runs, queue, reservations, smiths, config }`, where `cursor` is the ledger's newest id and each collection is the envelope its own `GET` route answers, so one that could not be read carries its own error. Then one `delta` event per ledger event, in `id` order, each with its `id` as the SSE id. A reconnect that sends `Last-Event-ID` gets the deltas after it and no snapshot, unless that id is ahead of the ledger: then the client is out of step and gets a snapshot. A keepalive comment every 15 s; at most 32 streams.
  - The ledger is the only change feed, and other processes write it, so each connection polls for ids above its cursor (250 ms). The cursor is read before the collections: an event appended meanwhile follows the snapshot as a delta, so a delta may repeat what the snapshot shows and never miss it.
  - A client that falls behind on reading is not buffered for: a connection with more than 1 MB waiting is given nothing new until it drains (its cursor does not move, so it misses nothing), and is closed if it stays that way for 30 s.
  - `queue` changes reach a client as `bead.transitioned` deltas (it reads `/queue` again). `smiths` and `config` have no ledger event; they change with a new snapshot.
- Council runs started through the hearth are recorded in the ledger (`council.run.started`, `council.run.finished`) with the workspace and the bead the request named. They carry no session and no executor: the operator started them, not an agent session.

## 7. MCP operator surface

- `bun run hearth:mcp` (stdio), registered in `.mcp.json`. Tool names `forge_*`. Same `tools/list` for every session; authority enforced per call via the operator token passed at launch (`--operator`). Agent sessions get read tools plus `forge_bead_propose`, `forge_friction_add`, `forge_event_note`; operator sessions additionally get `forge_queue_*`, `forge_drain_*`, `forge_council_start`, `forge_run_replan`.
- Supersedes the `3u6` spike. Council's existing `council_*` tools remain and are re-exported.

## 8. Executor adapters

```ts
interface ExecutorAdapter {
  provider: "claude" | "codex" | "opencode" | "gemini" | string;
  doctor(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  spawn(req: { beadId; worktree; smith; prompt; env: Record<string,string> }): Promise<ExecutorHandle>;
}
interface ExecutorHandle { sessionId; pid; events: AsyncIterable<LedgerEvent>; stop(reason): Promise<void>; }
```
- Claude adapter: `claude -p --output-format stream-json` in the worktree, env allowlist, stream parsed into `tool.called` events. Codex adapter: `codex exec` with `.codex/config.toml` from `sync-codex`. Third adapter is Gemini CLI (decided; OpenCode only if Gemini's headless mode fails on Windows at build time). Headless `claude -p` runs use `acceptEdits` with Bash allowlisted to known project scripts, never `dangerously-skip-permissions`.
- Child cleanup is panic-safe (prior-art lesson from a test-fixture fork storm): every spawn registers a kill on success/failure/timeout/parent exit.
- `ulpz.5` (OpenHands worker on a Linux host) is a remote adapter implementing the same interface later.

## 9. Scheduler

- Eligibility = `bd ready` ∩ queue state `queued` ∩ no reservation overlap ∩ host below throttle. Reuses `scripts/beads/convoy-bundles.ts` ordering.
- Smith resolution precedence: explicit `--smith` → bead metadata `smith` → bench by bead complexity label → `workflow.default_crew` → `claude-journeyman`.
- Shift: `bun run forge:shift --for 2h --concurrency 2 [--epic <id>]` (defaults decided: 2h, 2, throttle at 85%, 3 repairs then `queue:halted`); each picked bead runs through `/forgemaster-auto` semantics using the adapter, posts `worklog:`/`review:` comments, and ends at a PR. The shift never merges.
- Auto-tasks: `.claude/auto-tasks/*.yaml` templates (`review`, `qa`, `security`) mint `proposed` beads on a schedule; a human approves.

## 10. Command center UI and desktop

- The existing Preact/Vite dashboard (`docs/`) gains: **Sessions** (live), **Workbench** (board with actions), **Timeline** (events per bead/run), **Smiths & Config** (with provenance), **Scoreboard** (per smith outcomes/cost), and a **Send to council** action on issue detail, forge-run checkpoints and queue cards. Static GitHub Pages mode keeps working read-only from `docs/data/beads.json`.
- Desktop: Tauri 2 shell (decided) in `apps/desktop/` that starts and supervises the control-plane sidecar, shows a tray with running/blocked/review counts, raises OS notifications on halts, gate failures and council verdicts, and deep-links into beads. Windows first, macOS second.
- Claude Code mod (`plugin-authoring` skill): band above the prompt with counts, pane with the workbench, commands `/forge-board`, `/forge-queue`, `/forge-council <bead>`.

## 11. Config

- `agent-forge.toml` at the harness root (workspace) and `~/.agent-forge/config.toml` (machine), merged with provenance, printed by `bun run forge:config show`. Sections: `[workflow]` (base_branch, default_crew, benches), `[smiths.<name>]`, `[execution.env] pass`, `[control_plane]` (port, token file), `[review]` (council profile for auto review), `[shift]` (defaults, throttle).
- `.claude/protocols/model-tier-policy.md` is rewritten to point at the config; the rank table becomes smiths.

## 12. Non-goals for this epic

- Hosted/multi-user service, auth, RBAC. · Replacing Beads, git worktrees, or the PR workflow. · OS sandboxing beyond env allowlist and worktree isolation on Windows (document the gap; `ulpz` owns Linux containment). · Auto-merge. · Direct provider HTTP execution. · Subscription arbitrage.
