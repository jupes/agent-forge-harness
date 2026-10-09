# AGENTS.md — scripts/executors

Adapters that drive provider CLIs headlessly and turn their output into hearth events.

- `cli-adapter.ts` is the shared machinery; `claude.ts` / `codex.ts` supply flags and a line parser only.
- The prompt goes on **stdin**, never argv. Child env is built by `buildChildEnv` — never pass `process.env` through.
- Events are metadata only (hash of tool input, never the input). Validate with `scripts/hearth/validate.ts`.
- `EventSink` is the seam to the ledger: `sinks.ts` has `ledgerSink`, one `appendEvent` per event. A sink reports a
  failure (`{ ok: false, error }`) and never throws. `forge:exec` counts what was not recorded and lets the provider
  finish: a run is never stopped because its audit trail could not be written, and its exit code is the provider's.
- Events carry the harness's main checkout as `workspace`, so `forge:audit` finds them when the run was launched from
  a linked worktree. `session.started` says `kind: "headless"`, names the checkout the executor runs in, and names
  the launching session when one is mirrored into the directory `forge:exec` was started from.
- An adapter marks its child: `childEnv` (`env.ts`) adds `AGENT_FORGE_ADAPTER=1` plus the bead, smith, run and parent
  session. The harness hooks record nothing inside such a child (`isAdapterChild`), so a session its adapter records
  is not recorded a second time. The values come from the request, never from the parent environment.
- Tests use `fixtures/fake-cli.ts` and their own ledger file (`ExecDeps.ledgerPath`). Every temp root plants a `.git`
  directory: the adapter resolves checkouts, and a bare temp directory resolves to whatever checkout it sits in. Pass
  `cwd` as well — the default launch directory is the real one, which may hold a live session mirror.
- The fake binary proves plumbing. What real CLIs have shown, on Windows, each binary run directly with the adapter's
  flags and an allowlisted environment (2026-10-08):
  - `claude` 2.1.293 accepts every flag `claude.ts` passes, with the prompt on stdin, and frames its stream as
    `system` / `assistant` / `result` lines. That run stopped at authentication, so a `tool_use` block has **not**
    been observed from a real CLI; the tool mapping rests on the fake binary.
  - `codex` 0.159.0 and 0.160.0 accept every flag `codex.ts` passes. On 0.160.0 one shell command arrived as
    `item.started` then `item.completed` (`item.type: "command_execution"`, numeric `exit_code`), which is what the
    parser maps. Items other than a shell command have **not** been observed and are not mapped.
  - One run through `forge:exec` itself (`codex` 0.160.0, 2026-10-09, a one-file task in a scratch repository, an
    isolated ledger home): the ledger held `session.started`, one `tool.called` (`shell`, exit code 0) and
    `session.ended` (`completed`), each with the smith. No `forge:exec` run against a real `claude` has been made.
  - `forge:doctor` checks `--version` only. A binary can answer that and still be unusable: not signed in, or missing
    the helper it runs tools with (one such copy exited 0 without doing the task).
- Adding an adapter: implement the spec, register in `registry.ts`, add it to `contract.test.ts`.
