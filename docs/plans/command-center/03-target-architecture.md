# Target architecture — the Agent Forge Command Center

Generated: 2026-10-06
Status: design baseline for the **Agent Forge Command Center** epic. Decision beads (`D1`–`D3` in `04-roadmap-and-beads.md`) may amend sections 3 and 6; everything else is the contract executor agents build against.

## 1. One sentence

Agent Forge becomes a local-first **control plane** where every agent session of any provider reports into one ledger keyed by bead + run + session, and the operator can observe and direct all of it from a desktop app, a Claude Code pane, the CLI, or an MCP operator surface, with Beads as the only work graph and forgemaster as the planning brain.

## 2. Invariants (do not trade these away)

1. **Beads is the only work graph.** Queue states, reservations and verdicts are *events about* beads, never a second task table. If the ledger and Beads disagree, Beads wins and the ledger records the disagreement.
2. **Local-first, loopback-only.** The control plane binds to `127.0.0.1`, checks `Origin`/`Host` on every mutation, and holds a per-boot operator token. No accounts, no multi-tenant, no cloud sync.
3. **Every mutation is audited.** A ledger event precedes the side effect; events are append-only with redaction at write.
4. **Executors are driven through their own CLIs** (`claude`, `codex`, …) under an environment allowlist. The harness never holds provider API keys for execution; the council keeps its existing per-provider HTTP transports for review.
5. **Forge methodology stays intact.** TDD, phase gates, evaluator tier at or above builder tier, PR template, `bun run quality-gate`.
6. **Windows is a first-class host.** Everything runs under Bun on Windows without WSL; path quoting is tested with spaces.
7. **Nothing starts without the operator.** Minted work enters as `proposed`; only an operator action (UI, CLI, MCP operator tool) approves it. Unattended drains only consume already-approved work.

## 3. Component map

```
                 ┌───────────────────────────── control surfaces ─────────────────────────────┐
                 │  Desktop app (Tauri shell)   Claude Code mod (band + pane)   CLI   MCP (operator / agent)  │
                 └──────────────┬──────────────────────┬──────────────────┬────────────┬──────────┘
                                │ HTTP + SSE (loopback, typed routes)     │            │ stdio
                 ┌──────────────▼──────────────────────────────────────────▼────────────▼──────────┐
                 │                      Control-plane server  (Bun.serve, scripts/control-plane/)   │
                 │   operator API · event stream · queue + reservations · crews · council bridge     │
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
| **Session** | One live agent process attached to the harness (Claude Code interactive, Claude teammate, headless `claude -p`, `codex exec`, …) | `sessionId` (provider-issued where available, else minted) |
| **Executor** | `{ provider, model, effort, crew?, sessionId? }`; who is doing the work | embedded on run/event/gate/verdict |
| **Crew** | Named `{ provider, model, effort, enabled, tags }` in config; pools map complexity → weighted crews | crew name |
| **Event** | Append-only ledger row: `{ ts, kind, beadId?, runId?, sessionId?, executor?, workspace, payload(redacted) }` | autoincrement + ULID |
| **Queue state** | Derived state of a bead for scheduling: `proposed → approved → queued → running → review → done` (plus `paused`, `halted`) stored as Beads label/metadata plus ledger transitions | bead |
| **Reservation** | Claim on a set of file globs by a running session in a worktree, derived from the bead's file map | bead + worktree |
| **Drain** | Bounded unattended loop: pick eligible queued beads, assign crews, spawn executors, respect concurrency and time caps | drain id |
| **Friction** | A Beads chore labelled `friction` linked to the event that caused it; resolved by the bead that fixes it | bead |
| **Verdict** | Evaluator or council outcome bound to run + executor (`empi`) | event |

## 5. Ledger (builds on `ulpz.3`)

- Storage: `bun:sqlite` file under `.tmp/work/ledger.db` for the workspace, plus `~/.agent-forge/ledger.db` machine-wide index (decision `D2` may collapse these). Metadata-only by default: no prompt bodies, no source bodies, no tool output bodies; hashes and sizes instead. Opt-in bodies per event kind with redaction.
- Event kinds (v1): `session.started|ended`, `tool.called` (name, duration, exit, args hash), `prompt.submitted` (hash, length), `run.phase.entered|completed`, `review.recorded`, `gate.ran`, `verdict.bound`, `bead.transitioned` (queue state), `reservation.acquired|released`, `drain.started|stopped`, `council.run.started|finished`, `friction.recorded`, `operator.action` (every mutation).
- Query surface: `bun run forge:audit --bead <id> | --run <slug> | --session <id> | --since <iso> [--kind ...] --json`.
- Emitters are thin: a single `appendEvent()` in `scripts/ledger/` used by hooks, forge scripts, quality gate, worktree registry, council, and adapters. Hooks must stay fast (one sync insert, no network).

## 6. Control-plane server

- `scripts/control-plane/server.ts` (`bun run control-plane`), `Bun.serve` on `127.0.0.1:<port>`; the Vite dashboard proxies `/__agent-forge/*` to it in dev; the Tauri sidecar supervises it in desktop mode.
- Routes (all JSON `{ ok, data, error }`; mutations need `X-Agent-Forge-Operator` token and same-origin):
  - `GET /sessions`, `GET /runs`, `GET /runs/:slug`, `GET /events?…`, `GET /queue`, `GET /reservations`, `GET /crews`, `GET /config` (with provenance), `GET /stream` (SSE: snapshot + deltas)
  - `POST /beads` (create), `POST /beads/:id/claim|close|comment`
  - `POST /queue/:id/approve|queue|pause|resume|reassign` (`{ crew }`)
  - `POST /council/runs` (`{ source: { kind: "bead", id } , profile, budget }`), `POST /council/runs/:id/cancel`
  - `POST /drains` (`{ for, concurrency, filter }`), `POST /drains/:id/stop`
  - `POST /runs/:slug/replan` (hands a run back to forgemaster with a reason)
- Every `POST` writes `operator.action` first, then performs the effect through the same scripts the CLI uses (no second implementation).

## 7. MCP operator surface

- `bun run control:mcp` (stdio), registered in `.mcp.json`. Tool names `forge_*`. Same `tools/list` for every session; authority enforced per call via the operator token passed at launch (`--operator`). Agent sessions get read tools plus `forge_bead_propose`, `forge_friction_add`, `forge_event_note`; operator sessions additionally get `forge_queue_*`, `forge_drain_*`, `forge_council_start`, `forge_run_replan`.
- Supersedes the `3u6` spike. Council's existing `council_*` tools remain and are re-exported.

## 8. Executor adapters

```ts
interface ExecutorAdapter {
  provider: "claude" | "codex" | "opencode" | "gemini" | string;
  doctor(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  spawn(req: { beadId; worktree; crew; prompt; env: Record<string,string> }): Promise<ExecutorHandle>;
}
interface ExecutorHandle { sessionId; pid; events: AsyncIterable<LedgerEvent>; stop(reason): Promise<void>; }
```
- Claude adapter: `claude -p --output-format stream-json` in the worktree, env allowlist, stream parsed into `tool.called` events. Codex adapter: `codex exec` with `.codex/config.toml` from `sync-codex`. Third adapter proves the seam (OpenCode or Gemini CLI, whichever has a stable headless mode on Windows at build time).
- Child cleanup is panic-safe (Orbit lesson 3): every spawn registers a kill on success/failure/timeout/parent exit.
- `ulpz.5` (OpenHands worker on a Linux host) is a remote adapter implementing the same interface later.

## 9. Scheduler

- Eligibility = `bd ready` ∩ queue state `queued` ∩ no reservation overlap ∩ host below throttle. Reuses `scripts/beads/convoy-bundles.ts` ordering.
- Crew resolution precedence: explicit `--crew` → bead metadata `crew` → pool by bead complexity label → `workflow.default_crew` → `claude:default`.
- Drain: `bun run forge:drain --for 4h --concurrency 3 [--epic <id>]`; each picked bead runs through `/forgemaster-auto` semantics using the adapter, posts `worklog:`/`review:` comments, and ends at a PR. The drain never merges.
- Auto-tasks: `.claude/auto-tasks/*.yaml` templates (`review`, `qa`, `security`) mint `proposed` beads on a schedule; a human approves.

## 10. Command center UI and desktop

- The existing Preact/Vite dashboard (`docs/`) gains: **Sessions** (live), **Queue** (board with actions), **Timeline** (events per bead/run), **Crews & Config** (with provenance), **Scoreboard** (per crew outcomes/cost), and a **Send to council** action on issue detail, forge-run checkpoints and queue cards. Static GitHub Pages mode keeps working read-only from `docs/data/beads.json`.
- Desktop: Tauri 2 shell (decision `D1`; alternatives Electron, PWA, mod-only) that starts and supervises the control-plane sidecar, shows a tray with running/blocked/review counts, raises OS notifications on halts, gate failures and council verdicts, and deep-links into beads. Windows first, macOS second.
- Claude Code mod (`plugin-authoring` skill): band above the prompt with counts, pane with the queue board, commands `/forge-board`, `/forge-queue`, `/forge-council <bead>`.

## 11. Config

- `agent-forge.toml` at the harness root (workspace) and `~/.agent-forge/config.toml` (machine), merged with provenance, printed by `bun run forge:config show`. Sections: `[workflow]` (base_branch, default_crew, pools), `[crews.<name>]`, `[execution.env] pass`, `[control_plane]` (port, token file), `[review]` (council profile for auto review), `[drain]` (defaults, throttle).
- `.claude/protocols/model-tier-policy.md` is rewritten to point at the config; the tier table becomes crews.

## 12. Non-goals for this epic

- Hosted/multi-user service, auth, RBAC. · Replacing Beads, git worktrees, or the PR workflow. · OS sandboxing beyond env allowlist and worktree isolation on Windows (document the gap; `ulpz` owns Linux containment). · Auto-merge. · Direct provider HTTP execution. · Subscription arbitrage.
