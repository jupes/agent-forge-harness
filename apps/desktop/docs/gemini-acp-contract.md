# Gemini ACP Chat contract

Parent `agent-forge-harness-cla5.6.2`; private Chat producer `.6.2.2`.
This work does not enable public desktop Chat admission or Antigravity.

## Interface alternatives

Extending the Task JSONL parser would confuse a one-way result stream with ACP's
bidirectional requests, notifications and cancellation. A universal public RPC
or filesystem bridge would expose authority that this client does not need.
A second independent process/ownership engine would duplicate the guarded
bootstrap, private original identity and failure handling already implemented.

The selected interface keeps a small closed ACP wire codec below a Gemini-specific
session state machine, over the existing owned interactive supervisor. The codec
grants no launch, scope, storage, permission or retry authority. The runtime
verifies the exact native version/command/directory and accepted prompt; its
trusted caller owns original UUIDs, current scope, private journal and decisions.
Task and ACP share `gemini-native.ts` for the existing read-only version/help
probes, physical path identity and filtered native environment. Task retains its
separate serializer and one-way result parser; ACP cannot inherit Task completion
or use its output as a bidirectional permission protocol.

## Pinned primary evidence

- Gemini CLI `0.65.0`, commit
  `6006c14a4decfe4b891c6263ad6ad5992e404b5b`:
  [stdio framing](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpStdioTransport.ts),
  [dispatcher](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpRpcDispatcher.ts),
  [session lifecycle](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpSessionManager.ts),
  [native updates and permissions](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpSession.ts).
- Its official ACP SDK `0.16.1`, commit
  `9609d922dc855dc4446dfaef082416d34e0f123a`:
  [wire names and protocol version](https://github.com/agentclientprotocol/typescript-sdk/blob/9609d922dc855dc4446dfaef082416d34e0f123a/src/schema/index.ts),
  [typed protocol](https://github.com/agentclientprotocol/typescript-sdk/blob/9609d922dc855dc4446dfaef082416d34e0f123a/src/schema/types.gen.ts).

The native source wins over stale documentation that still names removed files
or describes MCP configuration as part of `initialize`. New/load session takes
the native cwd and an empty MCP-server list; the client advertises no delegated
filesystem or terminal capability. There is no automatic `authenticate`: that
handler can switch or clear the CLI's existing credentials.

## Facts the state machine must preserve

ACP uses newline-delimited JSON-RPC2.0 with protocol version1, launched with
`--acp`. Task's `--output-format stream-json` is a separate protocol. Only fixed
initialize/new/load/prompt/cancel and supported model/mode controls are allowed.
Unknown server filesystem/terminal/client operations refuse with no side effect.

The pinned `loadSession` starts `session.streamHistory(messages)` without awaiting
it. Historical user, agent, tool and thought updates can arrive before **or after**
the load reply, including while a new prompt is pending. The native stream has no
history-complete marker or accepted-turn ID. Consequently, all text/tool updates
from a resumed process retain `native-session` scope with no accepted-turn ID.
They must never become new-turn output or actionable historical permissions.
Only the request-correlated prompt result and a live permission RPC can bind to
the explicitly pending prompt. A quiet interval, available-commands notification,
or elapsed time is not a replay barrier. Native thought chunks are discarded after
identity/byte validation; the app does not retain or expose chain of thought.

Native `usage_update.used` and `size` describe context occupancy. They do not
report daily allowance. PromptResponse usage is per prompt; cached/thought counts
may be absent even when zero. Gemini's `_meta.quota` names token/model accounting,
not remaining account quota. Model names may fall back to configuration, so they
are not proof of which model served every response.

A permission request has native session/tool/options and RPC identity but no
accepted-turn UUID. The runtime supplies that binding from its actual pending
prompt and owned process. It can return only an offered `allow_once` or
`reject_once`, or `cancelled`; no always-allow/policy mutation. Intent must save
before the one answer. A lost receipt or historical request cannot cause replay.

Cancellation sends `session/cancel` and waits a bounded interval for the pending
prompt's `cancelled` result, then confirms owned tree cleanup. Missing or invalid
acknowledgment triggers hard Stop and an unknown outcome; partial private output
is kept and the prompt is never resent automatically.

## Private process and persistence boundary

`createGeminiChatRuntime` prepares a frozen selection using read-only native
version/help checks. It rechecks those capabilities, the executable prefix and
physical paths before starting an owned interactive process. Each run accepts
one explicit prompt; a later run can load only its caller's exact stored native
identity. The actual provider PID saves before initialize or private prompt
bytes. This producer is not registered as a public desktop admission route.

The caller supplies private persistence and permission authorization. Every
permission offer includes the actual process/session and accepted original;
its decision UUID and exact offered choice must save before one native answer.
The caller must fence late storage completions against its durable original and
lease. A persistence deadline cannot cancel an arbitrary caller promise, so the
runtime prevents dependent native writes and never retries the prompt or answer.

Private output has line, aggregate and pending-queue bounds. Storage faults,
malformed output, missing results and missing cancellation acknowledgements keep
an unknown outcome. Stop invalidates callbacks before native cancellation and
skips queued nonessential output. A terminal response closes stdin and starts a
separate short cleanup deadline: a native result alone does not prove the owned
process or its inherited-pipe helpers exited. Completion requires a confirmed
native result, successful private saves and drained owned process cleanup.

Compiled inert process tests exercise fresh and recreated exact-session turns,
delayed history, permission intent before reply, native settlement and Stop while
callbacks wait, failed/late saves, cancellation and timeout, inherited-pipe
helpers, protocol/output faults, queue saturation and changed native/path facts.
The fixture uses its own temporary home/config and never reads real accounts,
credentials or tracker state.
