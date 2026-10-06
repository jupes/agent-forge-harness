# Agent onboarding protocol

How an agent session **attaches** to the Agent Forge ledger: how it announces itself, which identity it
uses, and how it emits events. Decided 2026-10-06 (`docs/plans/command-center/05-decisions.md` #4);
architecture in `docs/plans/command-center/03-target-architecture.md` §4, §5, §8. The types in
`types/hearth.ts` (bead `x1gs.1.4`) are frozen from this file — change this file first.

Read this before writing an emitter (a hook, a forge script, an executor adapter, a remote worker).

---

## The decision in one paragraph

Every emitter is **thin** and writes the same **Event envelope**. The path depends on who the emitter is:

| Emitter | Path | Why |
|---|---|---|
| Claude Code hooks, forge scripts, quality gate | **In-process sync append** via `appendEvent()` (`scripts/ledger/`) | Hooks must stay fast: one local insert, no network, no dependency on the hearth being up |
| Spawned CLIs (`claude -p`, `codex exec`, …) | **Adapter stream**: the adapter parses the CLI's output and appends events on its behalf | The CLI cannot emit events itself; the adapter owns the child and its lifecycle |
| Remote workers (future, `ulpz.5`) | **HTTP `POST /events`** to the hearth | No access to the local ledger file |

The hearth is the only writer *over HTTP*; the ledger file is the single store behind all three paths.
An emitter never blocks the agent: an append failure is swallowed and reported to stderr, never thrown
into the host (a hook that crashes the session is worse than a missing event).

---

## Envelopes

TypeScript is illustrative; the frozen definitions live in `types/hearth.ts`. Optional means
"omit when unknown" — never send an empty string or a guessed value.

### Session envelope — "who is attaching"

```ts
interface Session {
  sessionId: string;        // opaque; provider-issued when available, else minted ULID (see Identity)
  provider: string;         // "claude" | "codex" | "gemini" | string
  model?: string;
  effort?: string;          // "low" | "medium" | "high" | "xhigh" | "max"
  workspace: string;        // absolute path of the registered workspace root
  worktree?: string;        // absolute path of the checkout the agent works in
  beadId?: string;          // the Beads issue this session works on, when known
  parentSessionId?: string; // set for teammates and subagents
  kind: "interactive" | "teammate" | "headless" | "remote";
  smith?: string;           // set when the harness chose the smith (adapters, shifts)
}
```

`kind` is the executor kind the rest of this file branches on. `sessionId` is stored verbatim; the pair
`(provider, sessionId)` is the identity for lookups.

### Executor envelope — "who is doing the work"

`{ provider, model?, effort?, smith?, sessionId? }` — the Session envelope minus where and why. It is
embedded on runs, gate results and verdicts (`03-target-architecture.md` §4). A session announcement
fills it from the Session; later events copy it, so a reader never has to join back to
`session.started` to know the model.

### Event envelope — "what happened"

Matches the ledger row (`04-roadmap-and-beads.md#f1-core`):

```ts
interface LedgerEvent {
  ulid: string;             // minted by the emitter; the dedupe key (UNIQUE) — POST retries are safe
  ts: string;               // ISO-8601 UTC, emitter clock
  kind: LedgerEventKind;    // one of LEDGER_EVENT_KINDS
  workspace: string;
  beadId?: string;
  runId?: string;           // forge slug
  sessionId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  smith?: string;
  payload: Record<string, unknown>; // redacted at write; metadata only
}
```

Rules every emitter follows:

- **Metadata only.** Hashes, sizes, names, durations. Never prompt text, source text or tool output
  (decision #10). `prompt.submitted` carries `{ hash, length }`; `tool.called` carries
  `{ name, durationMs?, exit?, argsHash }`.
- **Redaction at write**, not at read. The ledger applies the secret patterns; emitters do not rely on it
  for bodies they should not be sending in the first place.
- **Append-only.** There is no update or delete; corrections are new events.
- **`ulid` is minted by the emitter** so a retried POST or a replayed adapter stream is idempotent.

---

## Identity

An event is useful only if it can be tied to a session, a bead and a run. Three identifiers, three
different owners — never conflate them:

| Identifier | Owner | Source |
|---|---|---|
| `sessionId` | The provider, else the harness | See precedence below |
| `beadId` | Beads | Explicit correlation; never inferred from a host id |
| `runId` | Forge | `FORGE_SLUG`, else the run state file for this checkout (`scripts/quality-gate-identity.ts`) |

### `sessionId` precedence

1. **Provider-issued id**, verbatim.
   - Claude Code hooks: `session_id` from the JSON on **stdin**.
   - Headless `claude -p --output-format stream-json`: `session_id` on the stream's init message.
   - `codex exec`: the thread/session id its JSON stream reports (see *Verify at build time*).
2. **Adapter-chosen id**, when the CLI lets the harness pick one at spawn (so the id exists before the
   first byte of output).
3. **Minted ULID** persisted at `<worktree>/.agent-forge-session` — the fallback when the provider gives
   none (see below).

### The identity gap from `0xxt`, closed

Claude Code does **not** set `CLAUDE_TASK_ID` for hooks (there is no such variable; only `task_id` on
the `TaskCreated` / `TaskCompleted` stdin JSON). Therefore:

- **Never read `CLAUDE_TASK_ID`** to identify a session, a bead or a run. Hooks read `session_id` from
  stdin.
- **Never send a host `task_id` to Beads or the evaluator lookup.** It belongs to a task-list-scoped host
  namespace and can collide across lists. Record it, if at all, as optional `payload.hostTaskId`.
- **Bead and run correlation is explicit**, passed by whoever launches the work (see *Correlation*), not
  derived from host ids. This matches `0xxt`'s expected behaviour: the launcher supplies
  `beadsIssueId` + `executionRunId`; the hook parses stdin and treats host identity as optional metadata.

### Minted identity (`<worktree>/.agent-forge-session`)

Used by emitters that run **outside any provider session** (a hand-run `forge:*` script, a gate invoked
from a shell) and by providers whose output carries no id.

- **Content:** one line, a 26-character ULID, plus a trailing newline. Nothing else — no JSON, no pid.
- **Created** atomically on first need (open with exclusive-create). If the create loses a race, read the
  winner's value; never overwrite.
- **Reused** by every emitter in that worktree until the session ends, so the events of one working
  session share one `sessionId`.
- **Removed** by whichever emitter emits `session.ended` for it (SessionEnd hook, adapter on child exit).
- **Stale files:** a crash leaves the file behind. An attach that finds a file older than 24 hours mints a
  new one and appends `session.ended` with `payload.reason = "superseded"` for the old id first.
- **Never committed.** `.agent-forge-session` is in `.gitignore`. It is per-worktree, so a worktree
  created for a bead gets its own identity and the main checkout keeps its own.
- A provider-issued id always wins over the file: when `session_id` is present the file is neither read
  nor written.

### Correlation (`beadId`, `runId`, `smith`, parent)

The launcher puts these in the child's environment (the adapter's env allowlist includes them; a human
launching by hand can `export` them):

| Variable | Meaning |
|---|---|
| `FORGE_SLUG` | Forge run slug → `runId` (already read by the quality gate) |
| `AGENT_FORGE_BEAD_ID` | Beads issue → `beadId` |
| `AGENT_FORGE_SMITH` | Smith name → `smith` |
| `AGENT_FORGE_PARENT_SESSION` | Parent `sessionId` → `parentSessionId` |

Resolution order for `beadId`: the env var → the worktree registry entry for this checkout (once
`f4-worktrees` lands; a file read, never a `bd` call from a hook) → omitted. A session that attaches
without a bead is legal; the first event that learns the bead carries it, and readers group by the
`beadId` on events rather than on the session row.

---

## Attach sequence per executor kind

Every sequence ends the same way: `session.ended` exactly once, with `payload.reason`.

### 1. Interactive Claude Code (hooks, in-process)

1. **SessionStart hook.** Read stdin JSON: `session_id`, `cwd`, `source`, `model`, `effort.level` when
   present. Build the Session (`kind: "interactive"`, `provider: "claude"`, `worktree` from `cwd`'s git
   top level, `workspace` from the registry). `appendEvent({ kind: "session.started" })`.
   A SessionStart with `source` of `resume`, `clear` or `compact` for an id already seen **does not**
   emit a second `session.started`; it emits nothing (or `payload.source` on a `prompt.submitted`), so one
   conversation stays one session.
2. **During the session.** `UserPromptSubmit` → `prompt.submitted`; `PostToolUse` (matcher `*`) →
   `tool.called`; `Stop` → forge phase-gate as today. All append in-process, same `sessionId`.
3. **SessionEnd hook.** `session.ended` with `payload.reason` from stdin. (`session.ts` currently has a
   dead SessionEnd branch; `x1gs.2.2` wires it.)

### 2. Claude teammate or subagent (hooks + `parentSessionId`)

Subagents and teammates run in the lead's process tree and their hooks carry the **parent's**
`session_id` plus an `agent_id` (and `agent_type`) of their own.

1. A hook that sees `agent_id` on stdin attaches a **child** session:
   `sessionId = "<session_id>:<agent_id>"`, `parentSessionId = <session_id>`, `kind: "teammate"`.
   The first hook event for an unseen `agent_id` emits `session.started` for the child, then the event.
2. Tool and prompt events from that actor carry the child `sessionId`; the lead's keep the plain one.
3. `TeammateIdle` / `TaskCompleted` are **gate** events (`gate.ran`), not session ends. The child ends on
   the lead's SessionEnd (the hook emits `session.ended` for every open child first, `reason:
   "parent-ended"`).
4. If a teammate turns out to run as its own session with its own `session_id` and no `agent_id` (see
   *Verify*), it attaches as in (1) with `kind: "teammate"` and `parentSessionId` from
   `AGENT_FORGE_PARENT_SESSION`, else from `team_name` on `TeammateIdle` as a grouping hint
   (`payload.team`), else none.

### 3. Headless `claude -p` and `codex exec` (adapter stream)

The adapter (`x1gs.4.2` and successors) owns the child, so it emits — hooks inside a headless child are
not relied on.

1. `spawn(req)` builds the env (allowlist + the correlation variables above), starts the CLI in the
   worktree, and registers the child for cleanup (panic-safe, success/failure/timeout/parent exit).
2. The adapter appends `session.started` as soon as it has a `sessionId` (adapter-chosen at spawn, else
   from the first stream message), `kind: "headless"`, with `smith`, `beadId`, `runId`, `parentSessionId`
   from the request.
3. It parses the stream and appends `tool.called` (and `prompt.submitted` for the initial prompt) with the
   same metadata-only rules; it exposes the same events on `ExecutorHandle.events` for the hearth's SSE.
4. On exit, timeout or `stop(reason)` it appends `session.ended` (`payload.reason`, `exit`, usage when
   the provider reports it) and removes the minted-id file if it created one.

Hooks that fire inside a headless Claude child (same project settings) **must not double-emit**: they
detect `AGENT_FORGE_ADAPTER=1` in the environment and return without appending.

### 4. Remote worker (future, `ulpz.5`) — HTTP

1. Authenticate with the per-boot operator token over loopback or a tunnel the operator set up; never
   unauthenticated.
2. `POST /events` with a batch of Event envelopes (the first being `session.started` with
   `kind: "remote"`). The hearth validates each against `types/hearth.ts` guards and appends; `ulid` makes
   retries safe. Reply `{ ok, data: { accepted, duplicate }, error }`.
3. Heartbeat: a remote session that sends nothing for 15 minutes is marked ended by the hearth with
   `session.ended` `payload.reason = "lost"` — the one case where the hearth emits on a worker's behalf.

---

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Ledger file locked / unwritable | Retry once (busy timeout ≤ 50 ms), then drop the event and write one line to stderr. Never fail the host |
| No `session_id` on stdin | Fall back to the minted id; if there is no worktree, to the workspace root |
| Hearth down (remote worker) | Buffer locally, retry with backoff; `ulid` dedupes |
| Provider id changes mid-run (`resume` gives a new id) | Treat as a new session with `parentSessionId` = old id and `payload.source = "resume"` |
| Two interactive sessions in one worktree, no provider id | They share the minted id — accepted limit; provider ids make this rare |

---

## Verify at build time

Facts this file leans on that the adapter and hook beads must confirm and, if wrong, correct **here**:

1. Teammate hooks: whether a teammate presents the lead's `session_id` plus `agent_id` (assumed, per the
   hooks reference) or its own `session_id`. Bead `x1gs.2.2`. Attach rule 2.1 vs 2.4 depends on it.
2. `codex exec --json` session/thread id on its stream, and whether `claude --session-id` can pre-assign
   an id. Beads `x1gs.4.2` and the Codex adapter bead.
3. Whether SessionEnd fires for a headless child (assumed not relied on, hence the adapter emits).
