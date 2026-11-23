# Codex Task foundation

This implements child `agent-forge-harness-cla5.4.2.1`: pure Task serialization and a private exec JSONL decoder. It does not add a transport, registry entry, API route, composer or Chat. Existing Claude launch types, request bodies and original request hashes are unchanged. The parent 4.2 acceptance criteria still require native permission round trips and the actual composer/session producer.

## Interface decision

Three boundaries were considered before implementation:

| Interface | Benefit | Cost / decision |
| --- | --- | --- |
| A. `serializeCodexTask(request, capabilities)` plus `createCodexExecParser({version})` | Small pure boundary; one argv/preview implementation; separately testable provider wire format. | **Selected.** Task only, text stdin only, no filesystem authority. |
| B. `planCodexLaunch(request)` returning inert image/schema artifact requirements, then a server-owned binder | Could later support file-only CLI options without accepting caller paths. | Deferred until the actual private staging owner exists; an unbound plan cannot truthfully launch those options. |
| C. A full app-server lifecycle object owning initialize, capabilities, threads, turns and approval replies | Fits native approval round trips and model catalog discovery. | Deferred: broader lifecycle and identity/permission ownership are absent from this child. Its JSON-RPC protocol must not be confused with exec JSONL. |

The authoritative design brief at `7e41bba140493849d9f9b2dd3b8ada6773e374a2` has a provider table assigning exec to Task and app-server to Chat. Appendix A.3 and handoff section 6 permit exact-ID CLI continuation or a long-lived process where needed. The live 4.2 acceptance criteria require streaming **and permission round trips**. Exec Task alone does not fulfill them, and this module refuses Chat/resume rather than claiming that it does.

## Launch contract

`types/codex-task.ts` defines `CodexTaskLaunch`, `CodexExecCapabilities`, `CodexModelEffortEvidence`, `SerializedCodexTask` and private decoder event/outcome types. `codex-task.ts` exports strict browser-safe Zod schemas and `serializeCodexTask`.

Every request explicitly supplies `mode: "task"`, an absolute `cwd`, exact `model`, `sandbox: "read-only" | "workspace-write"`, `approvalPolicy: "never"` and a nonblank prompt. This is a selected noninteractive policy, not an observed allowance or a native approval UI. Optional effort remains a bounded string rather than a hardcoded model capability list.

The single serializer produces:

```text
exec --json --color never --sandbox <sandbox> --model <exact-model>
  --cd <cwd> --config 'approval_policy="never"'
  [--config 'model_reasoning_effort="<evidenced-effort>"'] -
```

Those six long flags must be present in the supplied observed exec-help capability snapshot. An effort request additionally needs an exact model match in separate `model/list` evidence with `source`, matching `cliVersion`, timestamp `asOf` and an exact advertised effort value. Missing or mismatched evidence refuses the request. Help text is not effort evidence. Omitting effort leaves CLI configuration behavior in control; no default or observed effort is claimed. Model catalog evidence describes capabilities, not account health, quota, current access or execution telemetry. The server must own its provenance and freshness. Official [model/list documentation](https://learn.chatgpt.com/docs/app-server#list-models-modellist) describes dynamic capabilities; the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) defines advertised effort strings and noninteractive approval policy.

The prompt is preserved exactly. Optional bounded text attachments and project/repository/worktree/bead/About data become a deterministic JSON data block on stdin. The block is prompt data, not a permission or scope boundary. Prompt and attachment bodies never appear in argv or the preview. The PowerShell command preview derives from the actual argv with a call operator and literal quoting; it omits private stdin and explicitly requires restoration of that input. Execute the argv array directly, never parse the preview. A preview is not proof of executable resolution or environment equivalence.

Images and output schemas require CLI file paths. This slice rejects images, schema bodies, staged paths, arbitrary flags/config, extra directories, profiles, automatic review, bypass, full-auto, CLI worktree creation and resume selectors. No caller-supplied artifact path is opened or staged. Future support needs server-owned private files with lifetime, size and symlink/hardlink rules, plus exact model input-modality evidence. The [CLI reference](https://learn.chatgpt.com/docs/cli/reference) documents file-valued image/schema options; app-server `UserInput` types are not an exec JSON stdin format.

Bounds: cwd/context labels 1,024 characters; exact model 200; effort 64; prompt 16,384; at most 8 text attachments of 524,288 characters each; at most 20 About references; actual serialized stdin at most 2 MiB UTF-8. Invalid Unicode and NUL are refused. Capability snapshots admit at most 128 flags and 100 unique exact-model evidence entries with at most 32 distinct effort strings each. These validation limits do not establish project/repository/worktree membership.

## Exec decoder contract

`createCodexExecParser({version})` returns `line(jsonl)` and `finish({exitCode,timedOut,stopped})`. It uses the documented snake_case exec event format, independently of the old lenient ledger adapter and independently of app-server JSON-RPC. The [noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable) gives thread, turn, item and terminal event examples.

Only an actual `thread.started.thread_id` UUID establishes identity. Conflicting top-level thread identity, malformed JSON, invalid state, conflicting item identity/content or exceeded bounds permanently prevents successful completion. A completed Task requires a valid thread, one started turn, `turn.completed`, no provider/protocol failure, and exit code zero without timeout or Stop. A reported failure yields a controlled reason without copying provider error bodies. Missing terminal/identity, timeout or a failed process after terminal success remains unknown.

Only completed `agent_message` text is projected, in Unicode-safe chunks of at most 16,000 UTF-16 units. Equivalent completed item text is emitted once regardless of JSON key order; changed completed text or item type refuses. Started/updated agent items are not emitted as deltas because this slice has no established delta-versus-cumulative contract. Tool, reasoning, collaboration/subordinate and future passive item bodies stay out of projected text. Incidental tool completion packets are not prerequisites for an authoritative successful terminal result. Known optional usage fields map only reported nonnegative safe integer counts; absent fields remain absent. `observedModel` is always null: configured/requested/model-list model values do not establish actual per-turn execution identity.

Resource limits are exported as `CODEX_EXEC_STREAM_LIMITS`: 4,096 lines, 1 MiB per line, 8 MiB total JSONL, 2,048 item identities and 512 KiB emitted UTF-8 text. Duplicate packets still consume stream bounds. The caller must impose the same line bound before buffering an unterminated pipe and stop the supervised tree on parser failure.

## Evidence and later execution boundary

Implementation was checked against saved model-free `codex-cli 0.163.0-alpha.10.2` root/exec/resume help and generated app-server types under the main checkout's `.tmp/work/codex-protocol-0.163`. `ReasoningEffort` is a string; `Model` supplies supported efforts, modalities and service tiers. `Thread.model` and `Thread.reasoningEffort` describe configuration, not per-turn execution telemetry. These generated app-server types are research evidence only and are not imported into the exec protocol. Raw artifacts remain uncommitted. No account/model-list query, thread/turn request, paid model request or credential-file read was made for this child.

Before actual execution, a server producer must validate current smith/provider enablement, trusted native executable, project/repository/worktree and optional bead/About membership, immutable request/retry identity, capability provenance/freshness, and managed sandbox/approval constraints. It must retain the established `codex:sync` dispatch boundary where applicable. It must build a filtered child environment, remove operator-token-bearing values and forged `AGENT_FORGE_*` / `FORGE_SLUG` capabilities, inject only owned correlation and supervise the full tree with timeout/Stop and bounded stdout. This foundation performs none of those authority checks and makes no auth-isolation claim from CLI user-config behavior. Private transcript bodies and any artifact contents belong in the private store; a future ledger projection may contain controlled metadata only.

Focused tests cover serialization/refusals/evidence, native-CSP import without Buffer, wire identity/lifecycle/dedup/privacy/bounds, terminal plus process success, and an actual supervised fake Bun process receiving exact argv/stdin through pipes with a filtered synthetic environment. The fake performs no provider operations. No shared session/UI migration, real CLI dispatch, Chat continuation or approval completion is included.
