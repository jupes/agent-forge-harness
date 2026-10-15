# AGENTS.md — scripts/executors

Adapters that drive provider CLIs headlessly and turn their output into hearth events.

- `cli-adapter.ts` is the shared machinery; `claude.ts` / `codex.ts` supply flags and a line parser only.
- Before each Codex run, `codex:sync` runs at the top level of the checkout the executor runs in, when that checkout
  is the harness's (its main checkout or a linked worktree of it): Codex reads `.agents/skills/` from there, mirrored
  from that checkout's own `.claude/`. For a checkout of another repository (a sub-repo, `forge:doctor --task`'s
  directory) it does not run at all, and the harness checkout the run was launched from is not written either
  (`codexSyncDirectory`). Tested with a planted `codex:sync` script, never the real one.
- The prompt goes on **stdin**, never argv. Child env is built by `buildChildEnv` — never pass `process.env` through.
- Events are metadata only (hash of tool input, never the input). Validate with `scripts/hearth/validate.ts`.
- `EventSink` is the seam to the ledger: `sinks.ts` has `ledgerSink`, one `appendEvent` per event. A sink reports a
  failure (`{ ok: false, error }`) and never throws; one that returns nothing has taken the event. `forge:exec` counts
  what was not recorded and lets the provider finish: a run is never stopped because its audit trail could not be
  written, and its exit code is the provider's.
- Events carry the harness's main checkout as `workspace`, so `forge:audit` finds them when the run was launched from
  a linked worktree. `session.started` says `kind: "headless"`, names the checkout the executor runs in, and names
  the launching session when one is mirrored into the directory `forge:exec` was started from.
- A run's events are `session.started`, `prompt.submitted` (the hash and length of the prompt sent on stdin), a
  `tool.called` per tool and `session.ended`. Their session id is the provider's, from the first stream line that
  reports one (Claude: `session_id`; Codex: `thread_id` on `thread.started`); `session.started` waits for that
  line, and a run that must write an event before any line has reported an id gets a minted ULID for its whole
  run. `ExecutorHandle.sessionId` is a getter that returns the id the events carry: read it after an event.
- While the child runs, its session is mirrored into the checkout it runs in (`.agent-forge-session`,
  `scripts/ledger/identity.ts`), so a script the child launches attaches to it through `resolveAttach`. When the
  child ends the mirror is removed, or the fresh mirror of another session it replaced is put back.
- `session.ended` carries `payload.usage` when the stream reported it (Claude's `result` line, Codex's
  `turn.completed`): each count under the provider's own field name in camelCase (`ProviderUsage` in
  `types/hearth.ts`), compared per provider.
- An adapter marks its child: `childEnv` (`env.ts`) adds `AGENT_FORGE_ADAPTER=1` plus the bead, smith, run and parent
  session. The harness's session and tool hooks (`session.ts`, `ledger-hook.ts`) record nothing inside such a child
  (`isAdapterChild`), so a session its adapter records is not recorded a second time. The quality-gate hook does not
  consult the marker: a gate run inside the child would still record its own `gate.ran`. Its bead and run come only
  from a run correlation — for a hook-triggered gate inside the child, the one that `forge:exec --run` writes in the
  worktree and hands the child (`AGENT_FORGE_RUN_CORRELATION`, `scripts/run-correlation.ts`) — not from these
  variables, of which the gate reads only the smith, and only when it can otherwise resolve an executor. Without a
  correlation the gate names no bead and no run; but when one is refused (for example the run is held by another
  bead, or the worktree is not a checkout's top level) the child still runs, and the run's ledger events and these
  variables still carry `--bead` and `--run`. That is deliberate: a run moves from one bead to the next, so they
  record the bead the session was launched for, while the correlation records the bead a gate in the run is checked
  against. `exec-cli.test.ts` pins it for a run held by another bead, on the fake binary. A `--run` that is not a
  Forge run id is refused before the child starts, and nothing is written.
  `scripts/run-correlation-launchers.test.ts` shows the pointer reaching a fake child, and the gate's own function —
  called in the test process with that pointer, not run as a hook inside the child — resolving it to the bead and
  run. No gate has been run inside any `forge:exec` child, fake or real. The values come from the request, never from
  the parent environment.
- Tests use `fixtures/fake-cli.ts` and their own ledger file (`ExecDeps.ledgerPath`). The one test of the default
  ledger path cannot pass a file, so it points `AGENT_FORGE_HOME` at its own temp home for its duration instead of
  relying on the test preload. Every temp root plants a `.git` directory: the adapter resolves checkouts, and a bare
  temp directory resolves to whatever checkout it sits in — and the adapter writes its session mirror into that
  checkout. Pass `cwd` as well — the default launch directory is the real one, which may hold a live session
  mirror. The fake prints a new session id per run; `--fake-session-id`, `--fake-no-id` and `--fake-attach` (run
  `resolveAttach` inside the child once its id is mirrored) are in its header.
- The fake binary proves plumbing. What real CLIs have shown, on Windows, each binary run directly with the adapter's
  flags and an allowlisted environment (2026-10-08):
  - The smith's effort is passed in each provider's documented flag — `claude --effort <level>`, `codex exec -c
    model_reasoning_effort=<level>` — and neither has been run against a real CLI: both were added after the runs
    below. The fake binary only shows the arguments arrive. Claude's reference does not say what a model without
    effort support (`claude-apprentice`'s Haiku 4.5) does with `--effort`.
  - `claude` 2.1.293 accepts every other flag `claude.ts` passes, with the prompt on stdin, and frames its stream as
    `system` / `assistant` / `result` lines. That run stopped at authentication, so a `tool_use` block has **not**
    been observed from a real CLI; the tool mapping rests on the fake binary.
  - `codex` 0.159.0 and 0.160.0 accept every other flag `codex.ts` passes. On 0.160.0 one shell command arrived as
    `item.started` then `item.completed` (`item.type: "command_execution"`, numeric `exit_code`), which is what the
    parser maps. Items other than a shell command have **not** been observed and are not mapped.
  - The session ids and the usage the adapters read are fields those runs printed: `claude` put one `session_id` on
    every line and a `usage` object and `total_cost_usd` on its `result` line (all zero, the run having failed);
    `codex` opened with `thread.started` and its `thread_id`, and a finished turn ended with `turn.completed` and a
    `usage` of five counts. A successful Claude `result` and a run of more than one turn have not been recorded.
  - One run through `forge:exec` itself (`codex` 0.160.0, 2026-10-09, a one-file task in a scratch repository, an
    isolated ledger home): the ledger held `session.started`, one `tool.called` (`shell`, exit code 0) and
    `session.ended` (`completed`), each with the smith. That was before the adapters took the provider's session
    id, wrote the mirror, recorded usage or appended `prompt.submitted`; none of those has been run against a real
    CLI. No `forge:exec` run against a real `claude` has been made.
  - A binary can answer `--version` and still be unusable: `claude` 2.1.293 with an expired sign-in exited 1 with its
    reason only in an error `result` line (stderr empty), and a `codex` 0.159.0 copy missing the helper it runs tools
    with printed an `error` item and an agent message saying it could not do the task, then `turn.completed`, and
    exited 0.
- What the provider said goes in the command's output, never the ledger. An adapter's `parseError` picks the error a
  stdout line reports (Claude: a `result` with `is_error`; Codex: an `error` item, `error`, `turn.failed`); the
  supervisor keeps the end of stderr. `forge:exec`'s `error` puts the first reported error, else the last stderr line,
  after the exit code, and a run that exits 0 after reporting an error is not a success (exit 2). `session.ended`
  records only fixed reasons (`failed: exit <n>`, `failed: exit 0, provider reported an error`). `outcome.ts` decides.
- `forge:doctor` answers two questions: does the binary answer `--version` (`ok`), and, with `--task`, can it run a
  task (`task`): one `git status` through the adapter in a new git repository under the OS temp directory, passing
  only on exit 0, no reported error and at least one tool call. The repository is removed once the task passed (a few
  attempts, `scripts/remove-directory.ts`); a task that failed, a directory `git init` failed in and one that could
  not be removed are kept, and `--json` names them as `task.directory`. Against a real provider `--task` spends a
  request.
  Both are tested on the fake binary only; no `--task` run against a real CLI has been made. Before either, `found`:
  the binary is on PATH, or a command override's program is where `Bun.which` finds it. An override whose program is
  not there is `found: false`; one that is there but fails `--version` is `found: true, ok: false` with the reason.
- `supervisor.ts` kills each supervised child's process tree when the harness process exits: on `exit` (which an
  uncaught error also fires), SIGINT and SIGTERM. `supervisor.test.ts` checks it in a process of its own: a stand-in
  harness (`fixtures/supervising-parent.ts`) supervises the fake in `hang-tree` mode, and after it calls
  `process.exit` or dies of an uncaught error, neither the provider nor the child the provider started is running.
  SIGTERM is checked on Linux and macOS only — on Windows a signal from another process ends it outright — so it has
  not been run on the Windows machine this was written on. Observed there (Bun 1.3.10): the provider itself did not
  outlive the harness even with the hook removed, but a child it started detached did, unless the hook ran.
- A harness killed outright (SIGKILL, TerminateProcess) runs no hook, so `supervise` guards each child's tree as it
  starts (`tree-guard.ts`). On Windows the child is assigned at once to a job object of its own with kill-on-close and
  no breakaway (kernel32 through `bun:ffi`); what it starts afterwards is in the job, and the system ends the job when
  the harness's handle closes, however the harness ended. Elsewhere the child leads its own process group and a
  detached `sh` watcher blocks reading a pipe only the harness writes to; at end of file it kills that group. When the
  child exits on its own or is stopped, the guard is stood down without ending anything (the job's kill-on-close is
  cleared before its handle closes; the watcher is killed before its pipe closes), so what a provider left running is
  left as before. `supervisor.test.ts` kills the stand-in harness with `Subprocess.kill("SIGKILL")` (TerminateProcess
  on Windows) and checks that neither the provider nor its child is left running, and that a provider that exits on
  its own (`--fake-mode orphan`) leaves its child running. `tree-guard.test.ts` kills a stand-in that holds only the
  guard of a provider it did not start (`fixtures/guard-holder.ts`), so nothing but the guard can end it: the provider
  ends, and its child (started before the guard) ends with it on Linux and is left running on Windows. Run on
  Windows 11 (Bun 1.3.10) and on Linux in CI; not run on macOS. Not covered: on Windows, a process the child starts before the assignment (it follows `Bun.spawn` at
  once) or with breakaway; elsewhere, one that leaves the child's process group (for example by `setsid`). No real
  provider has been run under the guard; a `.cmd` shim's `cmd.exe` and the program it starts would both be in the
  job, which has not been observed.
- `runExec` (forge:exec's function, which `forge:shift` calls for each run) takes an `AbortSignal` in `ExecDeps`:
  aborted before the provider starts, nothing is spawned or written (not even the run correlation); aborted while it
  runs, the handle's `stop` kills the child's tree and the run ends `stopped: <the abort's reason>`, in `session.ended`
  and in `error`. Its result carries `stopped` and the `usage` that `session.ended` reported (null when none), which is
  how a caller counts what a run spent.
- Adding an adapter: implement the spec, register in `registry.ts`, add it to `contract.test.ts`.
