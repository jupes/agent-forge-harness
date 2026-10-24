# Reported native Chat turn plans

This producer belongs to `agent-forge-harness-cla5.4.4.10`. It retains only the supplied `turn/plan/updated` notification from the pinned `codex-cli 0.163.0-alpha.10.2` app-server contract. It adds no launch option, experimental opt-in, execution authority, permission decision or lifecycle transition.

## Primary contract

The generated `v2/TurnPlanUpdatedNotification.ts` supplies `threadId`, `turnId`, nullable `explanation`, and a `plan` array of `{step, status}`. `TurnPlanStepStatus.ts` defines `pending`, `inProgress` and `completed`. The notification has no native item ID. The generated source was inspected under the main checkout's `.tmp/work/codex-protocol-0.163/v2/`; its SHA-256 is `9f7505555f199125bc2774878d488a3dcbc4d7304a54967993e68053d9915d01`.

The separate `ThreadItem.plan` and experimental `item/plan/delta` contracts are not captured by this producer. File-change patches and whole-turn diffs also remain separate, unconnected channels. No text from an assistant message or command is interpreted as a plan.

## Mutable snapshots and authority

Every matching notification is a replacement snapshot. Repeated identical reports and changed explanations, steps or statuses remain legitimate supplied facts. A step may return from completed to pending; its status is not native turn completion. Nullable explanation, an explicitly empty explanation, an absent report and an explicit empty step list remain distinct.

The private `coding-chat` variant preserves the literal source, pinned version and exact native thread/turn within the accepted application turn. It invents no item identity or status. Whole history independently requires the original native Chat snapshot, owned process and native binding. Partial pages require the protected binding and the server's whole-history validation. Foreign thread/turn/application turn/version, malformed native statuses and post-terminal updates refuse. A final native item snapshot or saved runtime outcome cannot be followed by a new plan report; the conversation store also refuses appends after generic settlement.

The sealed Keeper codec, original launch hashes, Task activity wire, approval policy, Stop and deadline handling are unchanged. Plan content remains inert transcript data and cannot open a file, run a command, grant a permission or prove provider support.

## Bounds and producer verification

A retained snapshot contains at most 128 steps and 16 KiB combined UTF-8 text across explanation and steps, with explicit clipping facts and no split code point. Each event is at most 64 KiB. Plans, commands and explicit reasoning summaries consume the same 2 MiB rich-report budget for an accepted turn. Repeated snapshots consume that budget; they cannot bypass it through deduplication.

The actual supervised inert runtime tracer first failed because the decoder discarded supplied plans, then passed with repeated original and revised reports, exactly one native turn/start and unchanged nonexperimental initialization. Actual private tests cover whole and partial reads, complete export, recreation, exact original retry, immutable private bytes and the shared three-channel budget. Separate actual Stop and deadline cases retain all completed-step plan facts while the native turn remains running until the real runtime outcome. Strict codec tests cover source, scope, malformed status, absent required fields, terminal boundaries, byte/list limits and legacy histories without plan reports.

After the producer review, the pure projection selects the latest matching replacement snapshot in the protected view. The collapsed **Reported turn plan** disclosure preserves explicit empty steps ("No steps reported"), null versus empty explanation, native status, clipping and source/version/thread/turn provenance. It does not merge other application/native turns or accept reports after matching native final facts. Partial snapshots are self-contained reports and do not invent a missing prefix. The projection and disclosure have no actions, and step completion remains separate from actual turn completion.

The pure display tracer failed before the projection was connected, then passed with scope, mutable replacement, terminal, explicit-empty, inert-content and exact reload coverage. Actual browser/native/full integration gates remain pending. No separately named private turn-plan design board has been verified; no unseen-board verification is claimed.
