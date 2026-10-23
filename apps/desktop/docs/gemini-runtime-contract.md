# Gemini CLI runtime contract

Parent: `agent-forge-harness-cla5.6.2`; Task producer: `.6.2.1`.

The owner settled Gemini CLI first and Antigravity later. See handoff section 6
and decision 25 at `7e41bba`. Antigravity is not offered by this implementation.
Its stream format, usage and permission behavior must not be substituted for
Gemini CLI's. No credential file or real account/model call is a test fixture.

## Interface alternatives

One option extends the existing `ExecutorAdapter.spawn` with Chat, transcript and
approval operations. A scheduler could call one adapter for everything, but its
metadata-only sink and Task lifecycle would then carry private bodies and native
permission state. This would alter unrelated Claude/Codex behavior.

A second option is a universal provider engine accepting arbitrary JSON-RPC,
commands and schemas. Gemini and Grok could share it, but every caller would need
to understand ordering, cancellation and authentication. It exposes too much
authority and makes native capability differences easy to erase.

The selected option follows the standalone Codex Task runtime pattern:
`createGeminiTaskRuntime(options).prepare({smith, launch})` returns an immutable
private snapshot; `run(snapshot, persist, signal)` rechecks executable, version,
capabilities and canonical directory before one explicit launch. A pure
`serializeGeminiTask` supplies both actual argv/stdin and the equivalent command.
The JSONL parser grants no execution, scope or approval authority. Later ACP Chat
will use its own typed client over owned duplex supervision, not this Task parser.

This keeps existing hashes and adapters unchanged while hiding process, private
storage ordering and bounded decoding. Scope admission and durable original UUIDs
belong to the trusted caller; invoking `run` is never an automatic retry.

## Pinned evidence

Official stable Gemini CLI `v0.65.0`, commit
`6006c14a4decfe4b891c6263ad6ad5992e404b5b`, inspected 2026-10-23:

- [CLI flags](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/config/config.ts)
- [stdin and headless entry](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/gemini.tsx)
- [native stream types](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/output/types.ts)
- [native usage conversion](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/output/stream-json-formatter.ts)
- [native noninteractive loop](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/nonInteractiveCli.ts)
- [official npm entry](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/package.json)
- [native @path expansion](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/ui/hooks/atCommandProcessor.ts)

No Gemini CLI is installed in the development environment. Source and inert
compiled fixtures establish this contract; they do not establish account access.

## Native distinctions

The launch route is `gemini-cli`, mode `task`. Private prompts are stdin text;
`--output-format stream-json` selects the actual headless stream. `model`,
`approval-mode`, sandbox, policy files and included directories are separate
documented options. Untouched options retain CLI defaults. YOLO, skip-trust and
permission bypass are not accepted. Thinking budget, checkpointing and output
schemas are not invented flags. Additional directories still need caller scope
authorization. A headless denial is reported evidence, not an inline permission
request that this mode can answer.

Inline context and attachment JSON encodes `@` as `\u0040`. It decodes to the
original data while avoiding the CLI's native file-expansion pass over literal
attachment content. The user's own prompt remains byte-preserved and retains
the CLI's normal prompt behavior.

Windows npm shims are not executed by a shell. A supported npm layout must resolve
the official package's `dist/index.js` and a native Node executable; otherwise
preparation gives an explicit unsupported-installation reason. The package's
own settings and sign-in are handled by its CLI. App/operator secrets and runtime
preload variables are excluded from the child environment.

`init.model` is configuration, not proven execution identity. Native result
`stats.models` retain each model's own token counts. `input_tokens` is prompt
tokens, `cached` is cached prompt tokens and `input` is the native uncached input
count. They are not summed into a second input total. No reported token count
becomes remaining allowance, price or balance. Missing is unavailable; zero is
retained. A terminal result, exact session identity and supervised exit must agree
before completion. A denied tool is displayed without claiming that it executed.

## Verification boundary

Behavior tests cover serialization defaults/refusals and exact private stdin;
ordered typed JSONL identity/text/tools/usage/result; duplicate/conflicting or
malformed output; line/aggregate/text/frame limits; process exit, timeout, Stop,
partial text and storage failure. A compiled inert provider exercises actual
supervised stdin/stdout and persistence. No desktop Start is enabled until the
owned admission and ACP Chat follow-up slices meet the parent's acceptance criteria.

## Runtime boundaries and controls

The standalone runtime is not registered in the scheduler's metadata-only
`ADAPTERS` map. That would expose unattended Gemini execution before the owned
admission and capability work is complete. Its explicit factory is the private
Task seam; the existing public composer continues to refuse unsupported Gemini
Start. Existing Claude/Codex hashes and adapter behavior are unchanged.

| Route or control | Current evidence and behavior |
| --- | --- |
| Gemini CLI Task | Verified `0.65.0` stream-json contract; exact help flags required |
| Gemini CLI Chat | ACP owned admission/duplex integration remains a separate slice |
| Antigravity | Settled deferred route; never substituted or offered here |
| Task tool denial | Native `policy_violation`/error report retained; no live approval answer invented |
| Stop and timeout | Only the actual owned provider/bootstrap tree is stopped; partial output remains private |
| Resume, fork, terminal handoff | This one-turn Task runtime grants no such authority |
| Effort, thinking budget, output schema | No verified launch field or invented flag |
| Account access, allowance, cost | Not established by version/help, usage tokens or exit0 |

Preparation captures physical directory identities before any capability probe,
then rechecks them after the probes and immediately before dispatch. It retains
the canonical native command, selected policy/include paths and exact private
launch. A changed directory link, command, version or required flag refuses;
preparation never silently adopts a new directory during a probe.

Read-only probes and the actual Task use the gated interactive bootstrap. The
runtime distinguishes the provider PID from the separately owned bootstrap PID.
The provider process record must finish saving before the first prompt byte is
sent. Input uses ordered bounded writes followed by EOF, with no prompt in argv.

Private writes have a five-second default deadline (trusted range1ms–30s), a
256-frame/1MiB pending queue and no replay. Stop or protocol failure suppresses
remaining queued writes; at most the currently accepted bounded write is awaited.
Any suppressed/failed frames make the outcome unknown. A trusted journal writer
must additionally fence late callbacks with its own accepted-turn lease; a
JavaScript timeout cannot cancel an external storage operation already issued.
Terminal success, exact native identity, resolved tools and clean supervised
exit must agree, and failure to save the final receipt cannot confirm completion.

The compiled inert fixture verifies real stdin/stdout, native denial/error,
partial output, malformed/oversized/missing results, nonzero exit, Stop/timeout,
normal-exit helper cleanup, missing/stalled persistence and queued-write liveness.
The Windows installation test also runs a planted official-layout package through
the actual native Node executable. It proves the `.cmd` shim is never executed,
private stdin is exact and preload variables are absent; the planted package
does not read credentials or make a model/account request.
