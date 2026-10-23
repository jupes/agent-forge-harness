# Standalone Codex native Chat runtime

Child `agent-forge-harness-cla5.4.2.4` provides a private native app-server runtime. It does not enable Chat in the composer, add an operator approval route, change existing Task or Claude request hashes, or complete parent `cla5.4.2`. The caller must still reserve the original request, hold the private lease, authorize project/repository/worktree and optional bead scope, audit dispatch, and own operator decisions. The sealed Keeper protocol and its tool profile remain separate.

## Interface choice

Three boundaries were considered:

1. A prepared, one-process-per-turn runtime with a trusted approval callback. This keeps process, deadline and private writer ownership aligned with the existing accepted-turn lifecycle. It resumes only the saved native thread ID. This is the selected boundary.
2. A persistent `openChat().send().answer().close()` object across idle turns. This needs durable daemon/reconnection and orphan ownership beyond the current accepted-turn lease. Defer until a native requirement makes it necessary.
3. A generic RPC connection exposing arbitrary methods and subscriptions. This moves initialization, identity, policy and approval correctness into every caller. Keep the native method surface closed instead.

The authoritative handoff at commit `7e41bba140493849d9f9b2dd3b8ada6773e374a2`, `docs/plans/desktop-app/claude-code-handoff.md` section 6 decision 3, permits provider CLI resume or a long-lived process where needed. Native `exec resume` alone cannot satisfy the parent's permission round-trip acceptance criterion. This runtime therefore uses `app-server --stdio`, not the exec JSONL decoder.

## Sources and capability truth

The wire contract is pinned to native `codex-cli 0.163.0-alpha.10.2`. Its `--version` and `app-server --help` probes are bounded and model-free. Help establishes only the advertised `--stdio` transport; it does not prove authentication, allowance, model entitlement, effort support or permission to execute.

The locally generated model-free protocol under MAIN `.tmp/work/codex-protocol-0.163` supplied `InitializeResponse.ts` and the `v2/ThreadStartParams.ts`, `ThreadResumeParams.ts`, `ThreadStartResponse.ts`, `ThreadResumeResponse.ts`, `TurnStartParams.ts`, `CommandExecutionRequestApprovalParams.ts`, `FileChangeRequestApprovalParams.ts`, `ServerRequestResolvedNotification.ts`, `ThreadTokenUsage.ts` and `ModelReroutedNotification.ts` contracts. These local scratch sources remain uncommitted. The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) confirms initialization, explicit thread start/resume, turn start, server approval requests and native responses. The [first-party app-server protocol guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) describes the same native lifecycle.

Requested effort requires separately supplied `model/list` evidence with the exact model identifier and CLI version. The runtime never queries an account or model catalog itself and never silently omits a requested effort. Catalog support is not entitlement. A missing effort means native default behavior; the thread's acknowledged configuration is recorded separately. Thread configuration and `model/rerouted` notifications do not prove which model executed a response, so `observedModel` remains `null`.

## Public module contract

`types/codex-chat.ts` defines `CodexChatLaunch`, `CodexChatCapabilities`, `PreparedCodexChat`, `CodexChatBinding`, `CodexChatApproval`, `CodexChatEvent`, `CodexChatUsage` and `CodexChatOutcome`.

`codex-app-server-protocol.ts` exports strict pure launch/capability/snapshot schemas, `serializeCodexChat`, `parseCodexAppServerFrame`, `nativeRequestKey` and `createCodexChatStream`. Text, selected context and bounded inline text attachments are placed in private protocol input. Caller paths, images, output-schema staging, arbitrary flags, bypass modes, full access, remote environments and session grants are refused or unavailable. The copyable command starts only the stdio server; its note explicitly requires restoring the private handshake and input separately. Execution uses argv and native JSON frames, never a parsed preview.

`createCodexChatRuntime(options)` exposes:

```ts
check({ smith }): Promise<CodexChatCapabilities>
prepare({ smith, launch }): Promise<PreparedCodexChat>
run({ prepared, resume }, persist, signal, { requestApproval }): Promise<CodexChatOutcome>
```

Options contain trusted harness/home/config paths, optional trusted executable and sync prefixes, filtered environment input, a current operator-token callback, exact-model effort evidence and bounded turn/RPC/approval/persistence deadlines. They are embedding seams, never HTTP launch fields. The prepared snapshot fixes the smith, original model/effort/policy and canonical native directory. Current defaults cannot rewrite it. The canonical directory is checked before probes, after probes, before dispatch and immediately before the paid turn. Existing `codexSyncDirectory` chooses the sync cwd; callers cannot supply another sync path.

The provider environment passes through the existing child-env allowlist and strips `AGENT_FORGE_*`, forged `FORGE_SLUG`, and any value containing the current operator token before injecting owned adapter/home/smith/bead correlation. The [interactive supervision contract](../executors/interactive-supervision-contract.md) defines the gated startup, separate wrapper/provider PIDs, process ownership and private stdin bounds.

## Identity, approvals and completion

Each accepted turn creates a fresh app-server process. Initialization occurs once, followed by `thread/start` or an exact owned `thread/resume` with `excludeTurns: true`. No `--last`, history, thread path, fork or mutable account default can select another identity. The first slice accepts root threads only: actual native UUIDs must agree, parent/fork IDs must be null, and the thread must acknowledge idle state and the selected policy/sandbox/canonical scope. Thread identity and acknowledged configuration settle in the private writer before one `turn/start` can be sent.

Command and file-change approval requests must name the live native process, actual thread/turn, pending item and typed native RPC ID. Numeric `1` and string `"1"` are different RPC identities. A private opaque approval ID is generated once. An identical duplicate cannot call the operator twice; changed, foreign, stale or unsupported requests latch an unknown result and stop the owned tree. Requests for write-stdin approval, network/additional permissions, remote environments, session-wide file roots, generic client operations and broad decisions are refused. Only the native offered subset of `accept`, `decline` and `cancel` is available.

The request is durably persisted before the trusted callback runs. The selected decision intent is persisted before the one native response is written; this intent is not evidence of native execution. `serverRequest/resolved` or the terminal turn invalidates the callback, so a late answer cannot write another response. The future operator route must supply its own authorization, origin audit, identity and lease fences around this callback. No callback is installed by the composer in this slice.

Main text includes only native agent-message deltas/full messages, with prefix/full deduplication. Tool output is never main text. Conflicting prefixes, type/identity changes, malformed frames, unmatched RPC responses and post-terminal item content refuse. Native usage retains `lastResponse` and `threadTotal` scopes from the generated protocol; neither is represented as an inferred aggregate for the entire accepted turn. Rich reasoning/tool/activity projection is a separate producer integration.

A completed result requires both an explicit native completed turn without error and successful process exit after bounded EOF/shutdown. Exit zero cannot erase a protocol, writer, approval, Stop or timeout latch. A failed or interrupted native turn is unsuccessful. Fixed refusal text excludes provider error bodies, private content and environment values. This slice does not implement a native provider-error details renderer.

Stop uses owned process-tree cleanup; it does not yet send `turn/interrupt`. A later resume must still acknowledge an idle thread. Uncertain active state refuses rather than silently dispatching another turn. Public lifecycle reconciliation and approved restart behavior remain integration work.

## Bounds and checks

Launch/snapshot/private input is bounded to two MiB using the existing strict Task text/context attachment limits. Native frames are at most one MiB; the decoder permits 4096 notification/request frames, eight MiB of decoded stream, one MiB of main text and 256 items. Approval identities are bounded to 128. The private writer holds at most 256 queued events or one MiB, with a deadline per write. RPC, callback, private writer, total turn and shutdown waits are bounded; Stop closes pending waiters. Late external writer completion cannot restore success, and its caller must still fence its underlying storage lease.

Focused tests use planted config and actual inert native Bun processes. They prove two explicit turns with exact resume, ordered private identity and approval persistence, narrow decisions, duplicate/stale/conflicting requests, partial/full text deduplication, foreign/malformed identity refusal, policy mismatch, requested-versus-configured model/effort truth, usage scopes, queue/writer/approval/RPC/turn/shutdown deadlines, retargeted directory refusal, filtered argv/stdin/environment, and actual descendant cleanup after Stop or timeout. Bootstrap tests additionally compile the production hearth entry and prove no provider dispatch before the owned startup grant. No real provider, model, account, credential file, tracker or remote repository is used.
