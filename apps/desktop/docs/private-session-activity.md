# Private owned session activity

This producer belongs to `agent-forge-harness-cla5.4.4.1`. Its source is the
desktop brief at `7e41bba140493849d9f9b2dd3b8ada6773e374a2`, section 6.8 and
the session states in section 9. The actual supplied Light Session board is
`95744122`; this producer does not claim verification against an unavailable
separately named dark Session or usage-limit board. Rendering is a later child.

## Boundary

Only an explicitly addressed owned coding journal accepts `coding-activity`,
`coding-outcome` and the separate Claude `coding-usage` variant. The default
Keeper event, store and wire codecs remain sealed. Existing untagged Claude
launch/hash/snapshot bytes and the existing Codex `exec.turn.completed` usage
variant are unchanged. Whole-state reads correlate each new report with the
provider and checked version in its original private launch. Paginated reads
may omit that launch; the protected store validates the complete state first.

Tool arguments/results, output, paths, diffs, plans and structured JSON are
untrusted provider reports. They grant no filesystem, tool, permission, provider
selection or launch authority. A path in a report is never read by this producer.
Reasoning means a supplied visible summary or thinking block. Encrypted and
redacted reasoning payloads are never reconstructed or retained as visible text.

Each report has a literal provider source, checked CLI version and native item
identity. Text is capped at 16 KiB of UTF-8, JSON at 32 KiB, one event at 64 KiB,
one turn at 2 MiB/4096 activity events, and lists at 128 entries. JSON has a
16-level/10,000-node limit. Clipped values carry `truncated`; excessive aggregate
activity invalidates full completion rather than silently claiming a complete
transcript. Conflicting duplicate completed items poison confirmation.

Supervisor timeout/stop evidence takes precedence over provider prose. Typed
authentication or rate-limit outcomes require a documented provider code.
Words such as “quota” or “login” in an ordinary error never establish those
outcomes. Cost estimates, token counts and allowance reports have distinct
provenance; absent values remain absent.

## First-party formats inspected

The Codex item decoder uses the native snake_case exec stream, not the separate
camelCase app-server protocol. Source: the official
[non-interactive documentation](https://developers.openai.com/codex/noninteractive)
and exact first-party source at tag `rust-v0.163.0`:

- [SDK items.ts](https://github.com/openai/codex/blob/rust-v0.163.0/sdk/typescript/src/items.ts),
  Git blob `8fd3b2c7ff5b47da5f64b16828e03c75c5e60961`.
- [SDK events.ts](https://github.com/openai/codex/blob/rust-v0.163.0/sdk/typescript/src/events.ts),
  Git blob `f6ad902779bee05ab0fb9b9cc6a2bca59d52c136`.

`command_execution` supplies `command`, merged `aggregated_output`, status and
optional exit code. `file_change` supplies paths and operations, **not** diff
text or line counts. `reasoning.text` is the visible summary. MCP results and
arguments are inert bounded JSON. Todo completion is the supplied boolean.
Agent prose that happens to parse as JSON is not a structured-output event.
Exec `turn.failed.error` currently supplies only a message, so it cannot prove
an authentication failure or an exhausted allowance.

Claude source: the official
[Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output),
[structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
and [headless CLI](https://code.claude.com/docs/en/headless), inspected 2026-10-23.
The inspected TypeScript reference distinguishes assistant content blocks,
user-role `tool_result` plus typed `tool_use_result`, and final `structured_output`.
Result usage is per main turn; `total_cost_usd` is an estimated cumulative
session amount restored across resume. Neither proves plan allowance or a bill.
The typed `rate_limit_event` and optional `/usage` report are separate evidence;
they must never be manufactured after a failed read.

`scripts/sessions/claude-account.ts` exports `claudeAccountReportSchema`, the
incoming-packet decoder `claudeAccountReports`, and `latestClaudeAccountReports`.
The last function returns only typed metadata for a server readiness projection:
auth source, authentication-flow status, rate-limit status, and reported usage
windows. It never returns transcript text or authentication-flow output. Hearth
receipt time is `observedAt`; callers must apply their own freshness policy.
`apiKeySource: "none"` does not mean signed out. Rate-event `resetsAt` is retained
as the reported number with `resetUnit: "unreported"`: the inspected reference
does not specify its unit. Usage-report `resets_at` is an explicitly typed ISO
timestamp. Null meters, empty meters and missing reports remain distinct.
