# Prepared Codex Task runtime

Child `agent-forge-harness-cla5.4.2.2` adds a standalone server runtime on top of the [Task launch/decoder contract](codex-task-contract.md). It adds no public endpoint, registry entry, conversation transport, UI or Claude request/hash change. It does not implement Chat, native approval replies, artifact staging or account/model discovery.

## API and trust boundary

`createCodexTaskRuntime(options)` returns:

- `check({smith})`: bounded native version and `exec --help` probes, returning observed CLI capabilities. This is capability observation, not authentication, access, quota or a guarantee that every model selection can launch.
- `prepare({smith,launch})`: checks an enabled configured Codex smith, strictly validates Task options with the existing serializer, checks canonical cwd/context consistency, and returns a cloned, deeply frozen `PreparedCodexTask`.
- `run(snapshot,persistPrivateEvent,signal)`: revalidates the saved Task and current enabled smith/native CLI capabilities, then executes its exact serialized argv/stdin. Current smith model/effort defaults never replace the saved selection. CLI version changes refuse before provider dispatch.

`PreparedCodexTask` contains version 1, provider `codex`, selected smith, cwd, launch and capabilities. `preparedCodexTaskSchema` validates this private shape and its cwd/launch invariant. Optional values are represented by absent keys, preserving the pure serializer's values. Its shape is independent of the existing Claude-specific `SessionTurnSnapshot` and conversation journal codec.

These are trusted embedding APIs. A snapshot is **not execution authorization** or evidence that it came from `prepare`. The caller must validate project/workspace/repository/worktree and optional bead/About membership, current allowance, private-home ownership and original request identity. It must durably journal the exact snapshot under the owned lease before calling `run`. `run` is execution-capable and is not idempotent: lost-response retries and polling must return the original private receipt, never call it again automatically. A later provider-discriminated integration must retain the exact existing Claude parse/hash path.

`command` and `syncCommand` are trusted embedding/fixture prefixes only; neither belongs in HTTP input or public launch options. Both are copied, validated and resolved to an executable. Windows requires a native `.exe`, refusing command shims. Tests supply the pinned Bun executable and model-free fixture files. They never call the installed provider or real repository skill sync.

## Preparation, dispatch and cancellation

Probes use the same filtered child environment as dispatch, with a five-second deadline, 64 KiB line bound and 128 Ki character output bound. Version parsing follows observed `codex-cli 0.163.0-alpha.10.2` output; flag evidence comes specifically from `exec --help`. No model request occurs during `check` or `prepare`. Exact-model effort evidence is separately supplied as private source/version/timestamp records; no evidence is inferred from help and no requested effort is silently dropped. The trusted caller owns catalog provenance/freshness. No live model-list/account query is implemented.

The configured environment pass list goes through `buildChildEnv`. Names matching `AGENT_FORGE_*` or `FORGE_SLUG`, and any value containing the current operator token, are removed before owned adapter/home metadata is added. Dispatch adds only the selected smith and optional trusted bead metadata. Provider authentication homes remain configured CLI behavior; the runtime reads no credential files and does not copy credentials.

Skill sync occurs only at dispatch, after live validation and before the provider process. `codexSyncDirectory` selects the actual harness checkout (including a linked checkout), and skips an unrelated repository. The default command is native Bun `run codex:sync`; the trusted `syncCommand` seam changes the supervised process, not directory selection. Sync has its own bounded output and at most a thirty-second deadline. Stop waits for its process tree. Failed, timed-out or stopped sync prevents provider dispatch; partial mirror effects are not automatically reset or retried. The embedding caller must authorize those dispatch effects through the original owned intent.

Provider execution uses the same pure serializer as Preview, prompt/context/text bodies on stdin, the dedicated snake_case decoder, a one-MiB pipe-line bound and a selected Task timeout (default fifteen minutes, maximum thirty). Stop before dispatch returns a known failure without starting a Task, including Stop during capability probing. Stop during execution and timeout await the supervised Task tree, pipe reader and private write queue. No resume selector or Chat path exists.

## Private events and outcome truth

`CodexTaskRuntimeEvent` contains the decoder's actual UUID/text/usage events plus a private process event with PID, smith, requested model and requested effort. Omitted effort is null, meaning CLI configuration behavior; it is never reported as a measured effort. The observed execution model remains null.

Private events are persisted in order, with at most 256 frames / one MiB queued. The caller's persistence callback must settle, enforce the owned journal lease/revision fences and avoid fire-and-forget writes; the runtime awaits it and cannot confer journal authority. A write rejection, parser failure, pipe/reader overflow or queue overflow latches an unknown result and stops the process tree. This independent failure latch overrides even terminal success plus exit zero. Any actual thread identity already observed remains available in the outcome; provider/private error bodies never become outcome reasons. The runtime does not write ledger rows or fan out tool bodies. Later ledger projection may contain controlled metadata only.

Focused tests use planted harness configuration/Git metadata and actual supervised fake native processes. They prove exact argv/stdin/env, model-free probes, immutable selection across config changes, strict refusals, actual UUID/deduplicated text/usage, failed exit and reader errors, storage failure/backpressure, linked-versus-foreign sync selection and actual descendant cleanup for Stop/timeout/sync/probe cancellation. No real provider, paid model, account query, tracker or credential read is used.
