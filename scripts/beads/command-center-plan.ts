/**
 * Bead plan for the Agent Forge Command Center epic.
 *
 * Single source of truth for the epic/feature/task graph described in
 * docs/plans/command-center/04-roadmap-and-beads.md. Imported by
 * scripts/beads/import-command-center-plan.ts (idempotent `bd create`) and
 * rendered to Markdown by the same CLI with `--markdown`.
 *
 * Keys are stable local identifiers; `deps` reference other keys in this plan
 * or real Beads IDs (prefixed `agent-forge-harness-`).
 *
 * NEVER rename a key once imported: command-center-plan.ids.json maps keys to
 * Beads ids, and a renamed key would be created again as a duplicate. The
 * importer refuses to run while the ids file holds a key the plan no longer
 * has. Titles, descriptions, acceptance and priority may change freely and
 * are pushed with `--sync`. Owner decisions live in
 * docs/plans/command-center/05-decisions.md.
 */
import type { PlanIssue, PlanSpec } from "./plan-import";

const DOC = "docs/plans/command-center";
const spec = (anchor: string): string =>
  `Spec: ${DOC}/04-roadmap-and-beads.md#${anchor} (architecture: ${DOC}/03-target-architecture.md).`;

const issues: PlanIssue[] = [
  {
    key: "epic",
    type: "epic",
    priority: 2,
    title:
      "[command-center] Agent Forge Command Center — one control plane for every agent, provider and workstream",
    description: [
      "Turn the harness into a local-first command center: a ledger of every agent session and tool call (any provider), a control-plane server with a typed operator API, smiths that route work across provider CLIs, a conflict-aware queue with bounded unattended shifts, council as a first-class action on any bead, and a desktop app plus a Claude Code pane as control surfaces. Beads stays the only work graph; forgemaster stays the planning brain.",
      `Research: ${DOC}/02-gap-analysis.md, ${DOC}/03-target-architecture.md. Roadmap and per-bead specs: ${DOC}/04-roadmap-and-beads.md.`,
      "Execution rule: each feature below is one /forgemaster run (research → plan → implement → ship) in its own worktree; tasks are the demo checkpoints. Re-run `bun run beads:import-command-center-plan` after editing scripts/beads/command-center-plan.ts; it is idempotent.",
    ].join("\n\n"),
    acceptance: [
      "Every feature under this epic is closed with test evidence and a merged PR.",
      "An operator can watch sessions from at least two providers, approve a proposed bead, shift it unattended, and send its result to council from the desktop app.",
      "Beads remains the only work graph: no duplicate task table exists in the ledger.",
      "docs/HARNESS-GUIDE.md and README.md describe the command center and all new commands.",
    ],
    labels: ["command-center"],
  },

  // ───────────────────────── F0 — decisions and contracts ─────────────────────────
  {
    key: "f0",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F0 Decisions and contracts that unblock everything else",
    description: `Resolve the three reversible-only-early decisions and freeze the shared TypeScript contracts (ledger event, executor, queue state, operator API envelope) before any feature assumes them. ${spec("f0-decisions-and-contracts")}`,
    acceptance: [
      "D1–D3 are closed with a `design:` comment recording the decision, alternatives, and rationale.",
      "types/hearth.ts exists, is exported, typechecks, and is referenced by the F1 and F2 plans.",
    ],
  },
  {
    key: "d1",
    parent: "f0",
    type: "decision",
    priority: 2,
    title:
      "D1 Desktop shell — DECIDED: Tauri 2 wrapping the dashboard, hearth as a supervised sidecar",
    description: `DECIDED 2026-10-06 by the owner (docs/plans/command-center/05-decisions.md #1): Tauri 2 wrapping the existing Preact/Vite dashboard with the hearth compiled by bun build --compile as a supervised sidecar. Alternatives rejected: Electron (heavier), PWA (no tray/sidecar), mod-only (no desktop app). The proving spike is the first checkpoint of f8-shell. ${spec("d1-desktop-shell")}`,
    acceptance: [
      "A `design:` comment on this bead records the choice, the alternatives, and why they lost (done 2026-10-06).",
      "05-decisions.md #1 matches the design comment (done).",
    ],
  },
  {
    key: "d2",
    parent: "f0",
    type: "decision",
    priority: 2,
    title:
      "D2 Hearth process model and ledger location — DECIDED: one hearth and one ledger per machine",
    description: `DECIDED 2026-10-06 by the owner (docs/plans/command-center/05-decisions.md #2-3): one hearth process per machine serving every registered workspace, lock file ~/.agent-forge/hearth.lock (pid, port, token), startable by Vite dev, the desktop shell or bun run hearth; one ledger at ~/.agent-forge/ledger.db with a workspace column, absorbing the ulpz.3 schema (RunCorrelation, metadata-only rule). ${spec("d2-process-model")}`,
    acceptance: [
      "A `design:` comment on this bead records the process model, DB location, startup ownership and port/token discovery (done 2026-10-06).",
      "ulpz.3 carries a `design:` comment pointing at f1-core as the owner of the shared schema (done).",
    ],
    deps: ["agent-forge-harness-ulpz.1"],
  },
  {
    key: "d3",
    parent: "f0",
    type: "decision",
    priority: 2,
    title:
      "D3 Write the agent onboarding protocol — DECIDED: hooks append in-process, adapters stream, remote workers POST",
    description: `DECIDED 2026-10-06 by the owner (docs/plans/command-center/05-decisions.md #4); the remaining work on this bead is writing .claude/protocols/agent-onboarding.md. Define the attach protocol: how a Claude Code interactive session, a Claude teammate, a headless claude -p, a codex exec, and a future remote worker (ulpz.5) announce themselves (sessionId, provider, model, workspace, worktree, beadId) and emit events. Options: hooks writing to SQLite directly vs POSTing to the control plane vs a stdio sidecar. Recommended: direct sync append through scripts/ledger for hooks (fast, no server dependency) plus an HTTP path for spawned CLIs streamed by the adapter. Resolve the identity gap from 0xxt (Claude Code does not set CLAUDE_TASK_ID for hooks). ${spec("d3-onboarding-contract")}`,
    acceptance: [
      "A `design:` comment plus a new .claude/protocols/agent-onboarding.md describe the Session, Executor and Event envelopes and the attach sequence for each known executor kind.",
      "The protocol states how identity is derived when the provider gives none (minted ULID persisted in the worktree).",
    ],
    deps: ["agent-forge-harness-0xxt"],
  },
  {
    key: "f0-types",
    parent: "f0",
    type: "task",
    priority: 2,
    title:
      "Freeze shared contracts in types/hearth.ts (LedgerEvent, Executor, QueueState, OperatorEnvelope)",
    description: `Write the TypeScript contracts from 03-target-architecture.md §4–§6 as exported types with a JSON-schema-free runtime validator (hand-written narrow functions, no new deps). These are consumed by the ledger, hooks, server, adapters and UI. ${spec("f0-types")}`,
    acceptance: [
      "types/hearth.ts exports LedgerEvent (all v1 kinds), Executor, Smith, QueueState, Reservation, OperatorEnvelope.",
      "scripts/hearth/validate.test.ts proves accept/reject for each event kind and for a malformed envelope.",
      "bun run typecheck and bun run lint pass.",
    ],
    deps: ["d2", "d3"],
  },

  // ───────────────────────── F1 — ledger and telemetry ─────────────────────────
  {
    key: "f1",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F1 Unified ledger: every session, tool call, phase, gate, verdict and council run in one audit store",
    description: `Absorbs ulpz.3 (the self-host SQLite run ledger; decision #12): one appendEvent() used by every emitter, redaction at write, metadata-only bodies (decision #10), nightly backup with 14-day retention and 90-day compaction (decision #11), and a query CLI. This is the foundation the command center observes. ${spec("f1-ledger")}`,
    acceptance: [
      "bun run forge:audit --bead <id> returns the ordered events for a bead across sessions, runs, gates and council runs.",
      "A Claude Code session that runs one tool call, one phase-gate write and one quality gate produces at least four events tagged with executor identity.",
      "No prompt, source or tool-output body is stored unless the event kind opts in; secrets are redacted before insert (test with planted key patterns).",
    ],
    deps: ["f0-types"],
  },
  {
    key: "f1-core",
    parent: "f1",
    type: "task",
    priority: 2,
    title:
      "scripts/ledger: appendEvent, redaction, migrations, and forge:audit query CLI",
    description: `Implement scripts/ledger/{db,append,redact,query}.ts over bun:sqlite with versioned migrations, WAL mode, and a single appendEvent(event) that validates against types/hearth.ts, redacts, and inserts. Add bun run forge:audit with --bead/--run/--session/--since/--kind filters and JSON envelope output. Reuse the council's secret-pattern scanner (scripts/council/safety.test.ts shows the fixtures). ${spec("f1-core")}`,
    acceptance: [
      "scripts/ledger/*.test.ts cover insert, filter by each key, migration from empty, and redaction of planted secrets.",
      "forge:audit prints { ok, data, error } and exits non-zero on a bad filter.",
      "Inserting 10k events completes in under 2 s on Windows (recorded in the bead as evidence).",
      "The ledger lives at ~/.agent-forge/ledger.db with a workspace column (decision #3); agent-forge-harness-ulpz.3 is closed with a worklog pointing at this task.",
      "bun run forge:audit --backup copies the ledger to ~/.agent-forge/backups/ and prunes copies older than 14 days (decision #11).",
    ],
    deps: ["f0-types"],
  },
  {
    key: "f1-hooks",
    parent: "f1",
    type: "task",
    priority: 2,
    title:
      "Claude Code hooks emit ledger events (SessionStart/End, UserPromptSubmit, PostToolUse, Stop) and SessionEnd is finally wired",
    description: `Add PostToolUse, UserPromptSubmit and SessionEnd entries to .claude/settings.json pointing at thin Bun hooks that call appendEvent; extend .claude/hooks/session.ts (its SessionEnd branch at lines 60-64 currently never runs). Record tool name, duration, exit, args hash; never bodies. Teammate sessions (Agent Teams tmux mode) must be distinguishable. ${spec("f1-hooks")}`,
    acceptance: [
      "A manual session shows session.started, prompt.submitted, tool.called, session.ended events with the same sessionId.",
      "Hook latency added per tool call is under 30 ms (measured, noted on the bead).",
      "SessionEnd runs bd dolt push once and logs it; the existing session.jsonl log keeps working.",
    ],
    deps: ["f1-core", "d3"],
  },
  {
    key: "f1-forge",
    parent: "f1",
    type: "task",
    priority: 2,
    title:
      "Forge run state v2: executor on runs, ledger events from phase-gate and auto-loop, fix halted-run advertising (csf2)",
    description: `Extend ForgeState (scripts/forge/phases.ts) with executor and schemaVersion; migrate v1 files on read (runs-store.ts already migrates legacy state). phase-gate --write and forge:review emit run.phase.* and review.recorded events; haltHandoff emits a halt event and forge:runs stops advertising a next phase for halted runs (closes csf2). ${spec("f1-forge")}`,
    acceptance: [
      "scripts/forge/*.test.ts cover v1→v2 migration, executor persistence, and that a halted run reports next = null.",
      "bun run forge:audit --run <slug> shows the phase and review history of a run.",
      "agent-forge-harness-csf2 is closed with evidence from this task.",
    ],
    deps: ["f1-core", "agent-forge-harness-csf2"],
  },
  {
    key: "f1-gates",
    parent: "f1",
    type: "task",
    priority: 2,
    title:
      "Quality gate, evaluator verdicts and council runs land in the ledger bound to run + executor",
    description: `quality-gate.ts appends gate.ran (keeps quality-gate.jsonl); the strict eval-verdict path appends verdict.bound using the identity work from 0xxt/empi; the council service appends council.run.started/finished with cost and verdict summary. ${spec("f1-gates")}`,
    acceptance: [
      "A quality gate run, a verdict file, and a council dry-run each produce one ledger event carrying beadId, runId (when known) and executor.",
      "agent-forge-harness-empi acceptance is satisfied or its remaining gap is filed as a child of empi.",
    ],
    deps: ["f1-core", "agent-forge-harness-empi"],
  },
  {
    key: "f1-friction",
    parent: "f1",
    type: "task",
    priority: 3,
    title:
      "Friction ledger as Beads: /friction command, friction label, ledger link, resolve-on-close",
    description: `A friction is a Beads chore with label friction, optional link to the ledger event that caused it, and a resolved-by relation to the bead that fixes it. Add .claude/commands/friction.md and a skill, bun run forge:friction add|list|resolve, and make bd search cover them (it already does). No second store: frictions are beads. ${spec("f1-friction")}`,
    acceptance: [
      '/friction "<text>" creates a chore with label friction and a friction.recorded event.',
      "Closing a bead that references a friction (resolves: <id>) closes the friction with a worklog comment.",
      "docs/HARNESS-GUIDE.md documents when agents should record friction instead of working around it.",
    ],
    deps: ["f1-core"],
  },

  // ───────────────────────── F2 — control plane and operator surfaces ─────────────────────────
  {
    key: "f2",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F2 Hearth: control-plane server, typed operator API, SSE stream, and MCP operator surface",
    description: `Extract the dev-API from Vite middleware into a standalone loopback Bun server with a typed operator API where every mutation is audited, a single SSE stream, Beads write actions, and an MCP server with operator vs agent authority. ${spec("f2-hearth")}`,
    acceptance: [
      "bun run hearth serves GET /sessions,/runs,/events,/queue,/smiths,/config,/stream and the POST actions in 03-target-architecture.md §6; the Vite dashboard proxies to it in dev with no behaviour loss on existing pages.",
      "Every POST writes an operator.action event before its effect; a request without the operator token or with a foreign Origin is refused with a 403.",
      "bun run hearth:mcp exposes forge_* tools; an agent session calling forge_queue_approve is refused while an operator session succeeds (tests).",
    ],
    deps: ["f1-core", "d2"],
  },
  {
    key: "f2-server",
    parent: "f2",
    type: "task",
    priority: 2,
    title:
      "Standalone Bun control-plane server; Vite proxies /__agent-forge/* to it; council API moves behind it",
    description: `Create scripts/hearth/server.ts (Bun.serve on 127.0.0.1, port from agent-forge.toml or env), port the forge-run and repos-knowledge dev-api handlers (scripts/dashboard/dev-api.ts) and the council dashboard routes (scripts/council/dashboard.ts) to it, and make vite.dashboard.config.ts proxy. Keep /__agent-forge/rebuild-pages. Same-origin + Origin/Host checks + per-boot operator token file. ${spec("f2-server")}`,
    acceptance: [
      "All existing scripts/dashboard/*.test.ts and scripts/council/dashboard.test.ts pass against the new server (adapted imports only).",
      "Playwright routes.spec and new-pages.spec pass with the proxy in place.",
      "A request with Origin https://evil.example is refused (test).",
    ],
    deps: ["f0-types"],
  },
  {
    key: "f2-api",
    parent: "f2",
    type: "task",
    priority: 2,
    title:
      "Operator API: read routes (sessions, runs, events, queue, reservations, smiths, config) and audited POST actions",
    description: `Implement the typed routes from 03-target-architecture.md §6 over the ledger and bd. POST actions call the same scripts the CLI uses (bd, forge:phase-gate, council service); no second implementation. Add GET /stream SSE that generalises the council snapshot/keepalive pattern to all collections. ${spec("f2-api")}`,
    acceptance: [
      "scripts/hearth/api.test.ts covers each route's envelope, one failing validation per POST, and that each POST produced an operator.action event.",
      "GET /stream delivers a delta within 1 s of a ledger append (test with a fake clock or short poll interval).",
    ],
    deps: ["f2-server", "f1-core"],
  },
  {
    key: "f2-beads-write",
    parent: "f2",
    type: "task",
    priority: 2,
    title:
      "Beads write path from the UI: create, claim, comment, close via the operator API (bead builder stops copying commands)",
    description: `POST /beads and /beads/:id/{claim,comment,close} shell out to bd with argument arrays (never a shell string; see 5mge) and the beads-priority-assignment rubric. BeadBuilderIsland gains a Create button next to the existing copy-command affordance; IssueDetailPanel gains claim/comment/close. ${spec("f2-beads-write")}`,
    acceptance: [
      "Creating a bead from the UI produces a real bd issue with priority and parent, and a bead.transitioned ledger event.",
      "Playwright builders.spec covers create + claim + comment round trip against the dev server.",
    ],
    deps: ["f2-api"],
  },
  {
    key: "f2-mcp",
    parent: "f2",
    type: "task",
    priority: 2,
    title:
      "MCP operator server (forge_* tools) with operator vs agent authority at call time; register .mcp.json; supersede 3u6",
    description: `scripts/hearth/mcp.ts (bun run hearth:mcp) wraps the operator API as MCP tools. Same tools/list for all sessions; calls carry the operator token only when launched with --operator. Re-export council_* tools from scripts/council/mcp.ts. Keep the tool set small (MCP tool surfaces cost tokens). Close agent-forge-harness-3u6 with a pointer here. ${spec("f2-mcp")}`,
    acceptance: [
      "scripts/hearth/mcp.test.ts proves tools/list parity and the operator/agent refusal matrix for every governed tool.",
      ".mcp.json registers the server; CLAUDE.md documents when agents should use forge_* vs bd.",
      "agent-forge-harness-3u6 is closed with a worklog pointing at this task.",
    ],
    deps: ["f2-api", "agent-forge-harness-3u6"],
  },

  // ───────────────────────── F3 — smiths and executor adapters ─────────────────────────
  {
    key: "f3",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F3 Smiths and executor adapters: route work across provider CLIs with an env allowlist",
    description: `Make the model-tier policy data instead of convention: smiths (provider+model+effort) and complexity benches in agent-forge.toml with provenance, an ExecutorAdapter interface, and adapters for Claude Code, Codex and one more CLI, each streaming events into the ledger. ${spec("f3-smiths")}`,
    acceptance: [
      "bun run forge:config show prints merged smiths/benches with the file each value came from.",
      "bun run forge:exec --bead <id> --smith <name> runs a bounded task in a worktree through the chosen adapter on Windows and leaves session + tool events in the ledger for at least two providers.",
      "Spawned processes receive only allowlisted env vars (test plants DATABASE_URL and proves absence).",
    ],
    deps: ["f1-core", "f0-types"],
  },
  {
    key: "f3-config",
    parent: "f3",
    type: "task",
    priority: 2,
    title:
      "agent-forge.toml config with smiths, benches, env allowlist, provenance; forge:config show/get/set; rewrite model-tier-policy to point at it",
    description: `DECIDED names (05-decisions.md vocabulary): built-in smiths claude-master, claude-journeyman, claude-apprentice, codex-journeyman; default smith claude-journeyman; benches low/medium/high keyed by the bead's complexity label; ranks master/journeyman/apprentice replace Top/Default/Cheap. scripts/config/{load,merge,provenance}.ts reading ~/.agent-forge/config.toml then <harness>/agent-forge.toml (workspace overrides; security keys never inherited once a workspace file exists). Built-in smiths mirror the current rank table (master/journeyman/apprentice → named smiths). Rewrite .claude/protocols/model-tier-policy.md so the escalation rules remain but the tier table is the config. ${spec("f3-config")}`,
    acceptance: [
      "scripts/config/*.test.ts cover merge precedence, provenance, refusal of undefined smith references, and the never-inherit rule for execution.env.pass.",
      "forge:config keys lists every settable key; forge:config set writes the right file.",
      "model-tier-policy.md no longer says 'convention, not automation'.",
    ],
    deps: ["f0-types"],
  },
  {
    key: "f3-adapter-claude",
    parent: "f3",
    type: "task",
    priority: 2,
    title:
      "ExecutorAdapter interface + Claude Code adapter (headless claude -p, stream-json → ledger, panic-safe cleanup)",
    description: `scripts/executors/{adapter,claude}.ts per 03-target-architecture.md §8. Spawn with Bun.spawn in the target worktree, env from the allowlist, parse --output-format stream-json into tool.called/session events, register kill-on-exit/timeout for every child. Resolve smith per precedence (flag → bead metadata → bench → default). ${spec("f3-adapter-claude")}`,
    acceptance: [
      "scripts/executors/claude.test.ts uses a fake claude binary (scripts/executors/fixtures) to prove stream parsing, env allowlist, timeout kill, and ledger events.",
      "A real headless run on Windows against a trivial bead is recorded on the bead with its forge:audit output.",
    ],
    deps: ["f3-config", "f1-core", "d3"],
  },
  {
    key: "f3-adapter-codex",
    parent: "f3",
    type: "task",
    priority: 2,
    title:
      "Codex adapter (codex exec) reusing sync-codex output; doctor reports missing CLIs",
    description: `scripts/executors/codex.ts: run bun run codex:sync first, then codex exec in the worktree with .codex/config.toml, map its JSON event stream to ledger events. Add bun run forge:doctor listing each adapter's availability/version. ${spec("f3-adapter-codex")}`,
    acceptance: [
      "codex.test.ts with a fake binary proves event mapping and env allowlist.",
      "forge:doctor prints { ok, data: { adapters: [...] } } and exits 0 even when a CLI is missing (missing is data, not failure).",
    ],
    deps: ["f3-adapter-claude"],
  },
  {
    key: "f3-adapter-third",
    parent: "f3",
    type: "task",
    priority: 3,
    title:
      "Third adapter: Gemini CLI (OpenCode only if Gemini's headless mode fails on Windows)",
    description: `DECIDED (05-decisions.md #13): implement the Gemini CLI adapter. Fall back to OpenCode only if Gemini's headless mode fails on Windows at build time; record the evidence on the bead either way. ulpz.5's remote OpenHands worker will implement the same interface later. ${spec("f3-adapter-third")}`,
    acceptance: [
      "A third scripts/executors/<provider>.ts passes the shared adapter contract test (scripts/executors/contract.test.ts runs every adapter against the same fixtures).",
      "forge:doctor lists three adapters.",
    ],
    deps: ["f3-adapter-codex"],
  },
  {
    key: "f3-scoreboard",
    parent: "f3",
    type: "task",
    priority: 3,
    title:
      "Scoreboard: per-smith outcomes, gate pass rate, review findings and cost from the ledger",
    description: `scripts/ledger/scoreboard.ts aggregates events per smith/provider/model: runs, PASS/FAIL verdicts, gate failures, council findings by severity, usage/cost where reported. Exposed at GET /scoreboard and in forge:audit --scoreboard. Gives 7xw the data it needs. ${spec("f3-scoreboard")}`,
    acceptance: [
      "scoreboard.test.ts proves aggregation over a fixture ledger with two smiths.",
      "GET /scoreboard returns the same numbers as the CLI.",
    ],
    deps: ["f1-gates", "f3-config", "f2-api"],
  },

  // ───────────────────────── F4 — scheduler: queue, reservations, shifts ─────────────────────────
  {
    key: "f4",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F4 Scheduler: approval queue on Beads, file reservations, unified worktree registry, bounded unattended shifts, auto-tasks",
    description: `A human approves the start of every task or task family (decision #5); approved work runs in shifts in parallel without file conflicts. Queue states are layered on Beads (label/metadata + ledger transitions), reservations derive from bead file maps, and forge:shift runs approved beads through the adapters with time and concurrency caps. ${spec("f4-scheduler")}`,
    acceptance: [
      "bun run forge:shift --for 30m --concurrency 2 --epic <id> runs two eligible beads in parallel in separate worktrees, never two beads whose file maps overlap, stops at the time cap, and leaves every child process dead.",
      "A proposed bead cannot be picked up by a shift until an operator approves it (test).",
      "The dashboard worktree list shows both trees/ and .claude/worktrees/ entries.",
    ],
    deps: ["f3-adapter-claude", "f2-api"],
  },
  {
    key: "f4-queue",
    parent: "f4",
    type: "task",
    priority: 2,
    title:
      "Queue state machine on Beads (proposed→approved→queued→running→review→done, paused, halted) with ledger transitions",
    description: `scripts/scheduler/queue.ts: state stored as a Beads label (queue:<state>) plus bead.transitioned events; legal transitions enforced; operator actions from F2 call these functions. Complexity label (complexity:low|medium|high) drives bench selection. ${spec("f4-queue")}`,
    acceptance: [
      "queue.test.ts covers every legal and illegal transition and the event emitted for each.",
      "bd list --label queue:queued shows exactly the beads the shift may pick.",
    ],
    deps: ["f1-core", "f2-api"],
  },
  {
    key: "f4-worktrees",
    parent: "f4",
    type: "task",
    priority: 2,
    title:
      "Unified worktree registry (trees/ + .claude/worktrees/), argument-array spawning (fixes 5mge), stash guidance (aenb)",
    description: `Rewrite scripts/worktree.ts to use execFileSync argument arrays, discover git worktree list output so Claude Code's .claude/worktrees/* appear, persist a registry with owner session and bead, and emit reservation/worktree events. Document the shared-stash hazard (aenb) in the registry output and the protocol. ${spec("f4-worktrees")}`,
    acceptance: [
      "worktree.test.ts proves create/list/cleanup with a path containing spaces on Windows.",
      "GET /reservations and the Repos page list every worktree with its bead and session.",
      "agent-forge-harness-5mge is closed with evidence; aenb gets a worklog pointing at the documented mitigation.",
    ],
    deps: ["f1-core", "agent-forge-harness-5mge"],
  },
  {
    key: "f4-reservations",
    parent: "f4",
    type: "task",
    priority: 2,
    title:
      "File reservations from bead file maps; conflict-aware eligibility built on convoy-bundles",
    description: `Parse the file map from a bead's description/AC (the forge-plan skill already writes one per task; make the format explicit), store reservations in the ledger keyed by bead + worktree, and extend scripts/beads/convoy-bundles.ts into scripts/scheduler/eligibility.ts: ready ∩ queued ∩ no glob overlap with active reservations ∩ host below throttle. ${spec("f4-reservations")}`,
    acceptance: [
      "eligibility.test.ts proves two beads with overlapping globs are never eligible together and are serialized in bundle order.",
      "forge-plan's task template documents the file-map block the parser expects; a malformed map yields a reservation of '**' (conservative).",
    ],
    deps: ["f4-queue", "f4-worktrees"],
  },
  {
    key: "f4-shift",
    parent: "f4",
    type: "task",
    priority: 2,
    title:
      "forge:shift — bounded unattended loop over eligible beads using smiths and adapters, with throttle and panic-safe cleanup",
    description: `Defaults (decision #8): concurrency 2, --for 2h, admission paused above 85% CPU or memory, 3 repair attempts then queue:halted; PRs opened with the template, never merged (decision #7). scripts/scheduler/shift.ts: --for <duration> --concurrency <n> [--epic] [--smith]; picks eligible beads, acquires reservations, creates a worktree, runs the bead through forgemaster-auto semantics via the adapter, posts worklog/review comments, ends at a PR, releases reservations. Host throttle (CPU/memory high-water) pauses admission. Every child is killed on stop/timeout/parent exit. Never merges. ${spec("f4-shift")}`,
    acceptance: [
      "shift.test.ts with fake adapters proves concurrency cap, time cap, reservation release on failure, and kill on abort.",
      "A real 2-bead shift on Windows is recorded on the bead with forge:audit --shift output and two PR links.",
    ],
    deps: ["f4-reservations", "f3-adapter-claude", "f5-executor"],
  },
  {
    key: "f4-autotasks",
    parent: "f4",
    type: "task",
    priority: 3,
    title:
      "Auto-task templates (.claude/auto-tasks/*.yaml) that mint proposed beads on a schedule: review, QA, security sweep",
    description: `Template = title, description, acceptance, labels, complexity, schedule (cron), and a predicate (e.g. open PRs without a review). bun run forge:auto-tasks mint|list|run; a Windows Task Scheduler / cron example in docs. Minted beads start as queue:proposed and wait for approval. ${spec("f4-autotasks")}`,
    acceptance: [
      "auto-tasks.test.ts proves mint is idempotent per schedule window and never creates a non-proposed bead.",
      "Three shipped templates exist and are documented.",
    ],
    deps: ["f4-queue"],
  },

  // ───────────────────────── F5 — forgemaster expansion ─────────────────────────
  {
    key: "f5",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F5 Forgemaster as the planning brain: executor-aware runs, file maps per task, spec→queue orchestration",
    description: `Expand the Forge pipeline so its plans feed the scheduler: every task carries a file map and complexity, runs record their executor and smith, a new /forge-orchestrate takes a spec to approved queue to shift to diagnosis. Molecules are retired (decision #14); a shift's DAG is the Beads dependency graph. ${spec("f5-forgemaster")}`,
    acceptance: [
      "/forgemaster <feature> --smith <name> records the smith on the run and in the ledger.",
      "/forge-plan output tasks all carry a parseable file map and complexity label.",
      "/forge-orchestrate <spec> ends with a proposed bead set awaiting approval and, after approval, a shift summary with per-bead outcomes.",
    ],
    deps: ["f1-forge", "f3-config"],
  },
  {
    key: "f5-executor",
    parent: "f5",
    type: "task",
    priority: 2,
    title:
      "forgemaster/forge-* commands accept --smith, record executor on the run, and the plan phase emits file map + complexity per task",
    description: `Update .claude/commands/forgemaster*.md, forge-*.md and the forge-plan/forge-implement skills: smith flag resolved through F3 config, written via phase-gate --executor; forge-plan's task template gains a '## Files' block and a complexity label the F4 parser reads. ${spec("f5-executor")}`,
    acceptance: [
      "phase-gate.test.ts proves --executor persistence; the forge-plan skill's template and an example plan pass the F4 file-map parser.",
      "docs/HARNESS-GUIDE.md Forge section documents --smith.",
    ],
    deps: ["f1-forge", "f3-config"],
  },
  {
    key: "f5-orchestrate",
    parent: "f5",
    type: "task",
    priority: 2,
    title:
      "/forge-orchestrate: spec → beads (proposed) → operator approval → shift → failure diagnosis and re-plan handoff",
    description: `New command + skill composing forge-research/plan with to-issues, the F4 queue (propose), an explicit approval stop, forge:shift, and a diagnosis step that reads ledger events for failed runs and either files fix beads or calls POST /runs/:slug/replan. ${spec("f5-orchestrate")}`,
    acceptance: [
      "A dry run on a small spec produces proposed beads with file maps and stops; approval + shift is exercised end-to-end once and the transcript summary is attached to the bead.",
      "A deliberately failing bead yields a diagnosis comment citing ledger event ids.",
    ],
    deps: ["f5-executor", "f4-shift"],
  },

  // ───────────────────────── F6 — council as a first-class action ─────────────────────────
  {
    key: "f6",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F6 Council on any work item: bead source kind, send-to-council from UI/CLI/MCP, verdict posted back",
    description: `Council runs on demand only (decision #9): a [review] before_pr toggle exists, default off, with a 1.00 USD per-run ceiling when on. Make council a one-click action on a bead from the dashboard, the forge-run page, the workbench, the CLI and the operator MCP; the council packs the bead's AC, comments, linked plan/research and PR diff, and its verdict returns as a review: comment and ledger event. ${spec("f6-council")}`,
    acceptance: [
      "bun run council -- bead <id> --dry-run shows the packed evidence (title, AC, latest comments, plan excerpt, PR patch if any) within budget.",
      "Send to council from IssueDetailPanel starts a run, streams progress, and on completion the bead shows a review: comment with the chair recommendation and a council.run.finished event.",
      "forge_council_start is operator-only via MCP.",
    ],
    deps: ["f2-api", "f1-gates"],
  },
  {
    key: "f6-source",
    parent: "f6",
    type: "task",
    priority: 2,
    title:
      "Council source kind 'bead': pack AC, comments, linked plan/research/report and PR diff within the evidence budget",
    description: `Extend ContextSourceKind (scripts/council/types.ts:67) and context.ts with a bead source: bd show --json, bd comments --json, plan/research files named by the bead or its forge run, and reuse pr-source.ts when the bead references a PR. Respect existing secret scanning and truncation rules. ${spec("f6-source")}`,
    acceptance: [
      "scripts/council/context.test.ts covers a bead with and without a PR, truncation ordering (AC and latest comments survive first), and secret refusal.",
      "council -- bead <id> works from the CLI and the MCP council_start tool accepts { kind: 'bead', id }.",
    ],
    deps: ["f1-core"],
  },
  {
    key: "f6-action",
    parent: "f6",
    type: "task",
    priority: 2,
    title:
      "Send-to-council action on issue detail, forge-run checkpoints and queue cards; verdict posted back as review: comment + ledger event",
    description: `UI: a Council button (profile picker, budget) on IssueDetailPanel, ForgeRunIsland checkpoints and the Workbench, calling POST /council/runs with a bead source and following progress through /stream. Server: on completion write bd comments add '<id> review: COUNCIL <recommendation> — findings b/h/m/l' and the council.run.finished event. ${spec("f6-action")}`,
    acceptance: [
      "Playwright spec exercises the button with the fake council profile end-to-end and asserts the review comment appears on the bead.",
      "A failed/cancelled council run posts no PASS-looking comment (test).",
    ],
    deps: ["f6-source", "f2-api", "f7-queue"],
  },

  // ───────────────────────── F7 — command center UI ─────────────────────────
  {
    key: "f7",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F7 Command center UI: live sessions, workbench with actions, timeline, smiths & config, scoreboard; Playwright in CI",
    description: `Grow the existing Preact dashboard into the command center over the control-plane API and SSE stream, keeping static GitHub Pages mode read-only. Nocturne design system components only; ui-originality-criteria apply. ${spec("f7-ui")}`,
    acceptance: [
      "Routes sessions, queue, timeline, smiths, scoreboard exist, pass a11y.spec, and render from /stream deltas without reload.",
      "Static build without a dev server shows read-only data from docs/data/beads.json and explains which actions need the control plane.",
      "Playwright runs in .github/workflows/quality.yml (closes 2q5s; advances p5k).",
    ],
    deps: ["f2-api"],
  },
  {
    key: "f7-stream",
    parent: "f7",
    type: "task",
    priority: 2,
    title:
      "App-wide SSE client (use-stream hook) replacing per-page fetches; forge-run page goes live",
    description: `docs/js/use-stream.ts subscribing to GET /stream with snapshot + delta merge into app-state.ts; ForgeRunIsland and the dashboard stat cards update live. Fallback to one-shot fetch when the control plane is absent (static mode). ${spec("f7-stream")}`,
    acceptance: [
      "scripts/dashboard/use-stream.test.ts covers snapshot, delta merge, reconnect, and static fallback.",
      "ForgeRunIsland reflects a phase-gate --write within 1 s without reload (Playwright).",
    ],
    deps: ["f2-api"],
  },
  {
    key: "f7-sessions",
    parent: "f7",
    type: "task",
    priority: 2,
    title:
      "Sessions board: who is running, on which workspace/worktree/bead, with which provider/model/smith, last tool, cost",
    description: `New route /sessions and a dashboard stat strip (running / blocked / review counts). Rows link to the bead and the timeline. Teammate sessions nest under their lead. ${spec("f7-sessions")}`,
    acceptance: [
      "Playwright spec with a seeded ledger shows two providers' sessions and the counts strip.",
      "Mobile viewport renders without horizontal scroll (existing mobile project).",
    ],
    deps: ["f7-stream", "f1-hooks"],
  },
  {
    key: "f7-queue",
    parent: "f7",
    type: "task",
    priority: 2,
    title:
      "Workbench with approve / queue / pause / resume / reassign-smith actions and reservation conflicts shown",
    description: `Kanban-style board over F4 queue states with the operator actions wired to POST /queue/:id/*, smith picker from /smiths, and a conflict badge when a bead's file map overlaps an active reservation. ${spec("f7-queue")}`,
    acceptance: [
      "Playwright spec approves a proposed bead and sees it move columns; a reassign shows the smith on the card.",
      "Each action produces an operator.action event (asserted via /events).",
    ],
    deps: ["f7-stream", "f4-queue"],
  },
  {
    key: "f7-timeline",
    parent: "f7",
    type: "task",
    priority: 2,
    title:
      "Timeline view: ordered ledger events per bead or run (phases, gates, verdicts, council, tool calls) with filters",
    description: `Route /timeline?bead=<id>|run=<slug>; virtualised list over /events with kind filters, linked from issue detail and forge-run checkpoints. ${spec("f7-timeline")}`,
    acceptance: [
      "Playwright spec filters by kind and deep-links from an issue.",
      "10k events render without jank (virtualised; note measurement on the bead).",
    ],
    deps: ["f7-stream"],
  },
  {
    key: "f7-smiths",
    parent: "f7",
    type: "task",
    priority: 3,
    title:
      "Smiths & config page with provenance, adapter doctor status, and scoreboard",
    description: `Read-only view of forge:config show (value + source file), forge:doctor adapter status, and the F3 scoreboard. Editing stays in the config file for now (link to docs). ${spec("f7-smiths")}`,
    acceptance: [
      "Playwright spec renders provenance and doctor rows from fixtures.",
    ],
    deps: ["f3-config", "f3-scoreboard", "f7-stream"],
  },
  {
    key: "f7-ci",
    parent: "f7",
    type: "task",
    priority: 2,
    title:
      "Playwright in CI (quality.yml) with the control plane started by the webServer config; close 2q5s",
    description: `Extend playwright.config.ts webServer to start the control plane and the dashboard; add a CI job with browser caching; upload screenshots on failure. ${spec("f7-ci")}`,
    acceptance: [
      "A PR run shows the Playwright job green; agent-forge-harness-2q5s closed; p5k gets a worklog with remaining gaps.",
    ],
    deps: ["f2-server", "agent-forge-harness-2q5s"],
  },

  // ───────────────────────── F8 — desktop app and in-agent surfaces ─────────────────────────
  {
    key: "f8",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F8 Desktop app (Tauri shell + sidecar, tray, notifications) and Claude Code mod (band + pane)",
    description: `DECIDED: Tauri 2 (decision #1), living in apps/desktop/ in this repository (decision #18), Windows first with macOS only after the Windows installer works (decision #15). Ship the command center as a desktop app that supervises the hearth and as a Claude Code mod that surfaces counts and the queue inside the agent. Codex/Cursor plugin surfaces are a later P3. ${spec("f8-desktop")}`,
    acceptance: [
      "An installer on Windows launches the app, starts the sidecar, shows the sessions board, and raises a notification when a shift halts or a council verdict lands.",
      "In Claude Code the band shows running/blocked/review counts and /forge-board opens the queue pane.",
    ],
    deps: ["d1", "f7-sessions", "f7-queue"],
  },
  {
    key: "f8-shell",
    parent: "f8",
    type: "task",
    priority: 2,
    title:
      "Tauri 2 desktop shell: window over the dashboard, sidecar lifecycle (start/health/restart/stop), tray counts, deep links",
    description: `First checkpoint is the D1 proving spike: window opens over the dashboard, the hearth sidecar starts and stops, the tray shows a count (screenshot on the bead). apps/desktop/ (Tauri 2, decided): bundles the built dashboard, spawns bun run hearth as a sidecar with the operator token, restarts on crash, tray menu with counts from /stream, agent-forge://bead/<id> deep links. ${spec("f8-shell")}`,
    acceptance: [
      "bun run desktop:dev opens the app on Windows; killing the sidecar restarts it within 3 s (recorded).",
      "Tray counts match /sessions and /queue (manual verification steps in the ship report).",
    ],
    deps: ["d1", "f2-server", "f7-sessions"],
  },
  {
    key: "f8-notify",
    parent: "f8",
    type: "task",
    priority: 2,
    title:
      "OS notifications and approval prompts: shift halted, gate failed, council verdict, proposed bead awaiting approval",
    description: `Subscribe to /stream in the shell; map event kinds to notifications with an Approve action for proposed beads (calls POST /queue/:id/approve with the operator token). Quiet hours and per-kind toggles in agent-forge.toml. ${spec("f8-notify")}`,
    acceptance: [
      "Each mapped event kind produces one notification in a manual run (screenshots on the bead).",
      "Approve from the notification creates an operator.action event.",
    ],
    deps: ["f8-shell", "f4-queue"],
  },
  {
    key: "f8-mod",
    parent: "f8",
    type: "task",
    priority: 2,
    title:
      "Claude Code mod: band with counts, queue pane, /forge-board, /forge-queue, /forge-council <bead>",
    description: `Use the plugin-authoring skill to build a hooks-module plugin under .claude/plugins/forge-command-center that polls /sessions and /queue, renders a band and a pane, and exposes the three commands (council one calls POST /council/runs with a bead source). ${spec("f8-mod")}`,
    acceptance: [
      "The mod hot-reloads in a session and shows live counts; /forge-council <bead> starts a council run and reports the run id.",
      "A unit test covers the band/pane rendering from fixture API responses.",
    ],
    deps: ["f2-api", "f6-action"],
  },
  {
    key: "f8-package",
    parent: "f8",
    type: "task",
    priority: 3,
    title:
      "Packaging: Windows installer, signing plan, auto-update check, forge:doctor in the app's Settings",
    description: `Build pipeline for the desktop app (GitHub Actions job on tags), unsigned-build warning path documented, update check against GitHub releases, and a Settings page embedding forge:doctor and config provenance. ${spec("f8-package")}`,
    acceptance: [
      "A tagged build produces an installer artifact in CI; install + launch verified on a clean Windows VM (notes on the bead).",
    ],
    deps: ["f8-shell", "f7-smiths"],
  },
  {
    key: "f8-other-agents",
    parent: "f8",
    type: "task",
    priority: 3,
    title:
      "Codex and Cursor surfaces: skill/plugin exposing forge_* MCP tools and a status command in each",
    description: `Extend sync-codex.ts to install the forge_* MCP server config for Codex and write a Cursor rules/MCP snippet; document setup in docs/HARNESS-GUIDE.md. ${spec("f8-other-agents")}`,
    acceptance: [
      "A Codex session can call forge_queue_list and forge_bead_propose; a Cursor session can list queue state via MCP (manual evidence on the bead).",
    ],
    deps: ["f2-mcp", "f3-adapter-codex"],
  },

  // ───────────────────────── F9 — docs, knowledge, migration ─────────────────────────
  {
    key: "f9",
    parent: "epic",
    type: "feature",
    priority: 2,
    title:
      "[command-center] F9 Docs, knowledge and protocol migration for the command center",
    description: `Bring CLAUDE.md, AGENTS.md scaffolds, HARNESS-GUIDE, README, knowledge/_shared.yaml and the protocols in line with the command center; remove stale references found in the survey. ${spec("f9-docs")}`,
    acceptance: [
      "README and HARNESS-GUIDE have a Command Center section covering control plane, smiths, queue/shift, council action, desktop app and mod, with every new npm script listed.",
      "knowledge/_shared.yaml no longer references the deleted gas-town insights file; bun run agents-md validate reports zero missing files.",
    ],
    deps: ["f2-mcp", "f4-shift", "f8-shell"],
  },
  {
    key: "f9-fix-refs",
    parent: "f9",
    type: "task",
    priority: 3,
    title:
      "Fix stale references now: gas-town insights file in knowledge/_shared.yaml and molecules README; scaffold missing AGENTS.md files",
    description: `Small, independent cleanup that can run first: replace the research_notes entry with a pointer to docs/plans/command-center, fix .claude/molecules/README.md, and run bun run agents-md scaffold --write for the 8 directories the SessionStart hook reports. ${spec("f9-fix-refs")}`,
    acceptance: [
      "bun run agents-md validate --hook reports zero missing; no file references knowledge/gas-town-harness-insights.yaml.",
    ],
  },
  {
    key: "f9-retire-molecules",
    parent: "f9",
    type: "task",
    priority: 3,
    title:
      "Retire molecules: README marked historical, molecules:check removed, workflow references cleaned",
    description: `Molecules are retired by owner decision (05-decisions.md #14); the shift takes its DAG from Beads dependencies. Mark .claude/molecules/README.md historical (keep the JSON as an archived example), remove molecules:check from package.json and scripts/molecules/check.ts, delete references from .claude/workflows and docs/HARNESS-GUIDE.md, and keep scripts/molecules/parse.ts only if something else imports it. ${spec("f9-retire-molecules")}`,
    acceptance: [
      "bun run molecules:check no longer exists; typecheck, lint and tests pass.",
      "grep -ri molecule across .claude/workflows, .claude/commands, docs/HARNESS-GUIDE.md and README.md returns only the historical note.",
    ],
    deps: ["f9-fix-refs"],
  },
  {
    key: "f9-guide",
    parent: "f9",
    type: "task",
    priority: 2,
    title:
      "HARNESS-GUIDE, README, CLAUDE.md and protocols updated for the command center; onboarding protocol linked",
    description: `Write the Command Center chapter, update the slash-command tables (friction, forge-orchestrate, forge:shift, forge:audit, forge:config, forge:doctor, control-plane, hearth:mcp, desktop:dev), link .claude/protocols/agent-onboarding.md, and update the session-completion protocol to mention the ledger. ${spec("f9-guide")}`,
    acceptance: [
      "Every npm script added by this epic appears in README's script table with one line; a new reader can start the control plane and the desktop app from the docs alone (verified by a fresh-clone walkthrough recorded on the bead).",
    ],
    deps: ["f9-fix-refs", "f2-mcp", "f4-shift", "f8-shell"],
  },
];

export const commandCenterPlan: PlanSpec = {
  name: "command-center",
  epicKey: "epic",
  issues,
};
