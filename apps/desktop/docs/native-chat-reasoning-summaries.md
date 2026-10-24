# Explicit native Chat reasoning summaries

This producer belongs to `agent-forge-harness-cla5.4.4.9`. It consumes only explicit visible summary facts from the pinned `codex-cli 0.163.0-alpha.10.2` app-server contract. It does not request reasoning generation, opt into experimental raw events, or change any saved launch, resume, approval or Stop request.

## Primary source and exposure

The CLI-generated `v2/ThreadItem.ts` reasoning variant has separate `summary: string[]` and `content: string[]` fields. `ReasoningSummaryPartAddedNotification.ts` names an exact native thread, turn, item and summary index. `ReasoningSummaryTextDeltaNotification.ts` supplies text for that summary index. `ReasoningTextDeltaNotification.ts` instead uses `contentIndex`; it is a different channel.

The generated `ThreadStartParams.ts` documents `experimentalRawEvents` as internal-only. `RawResponseItemCompletedNotification.ts` carries the upstream ResponseItem, including encrypted reasoning fields. The existing runtime continues to initialize with `experimentalApi: false`, does not set `experimentalRawEvents`, and does not add a turn-level summary override. Content, textDelta, rawResponse and encrypted payload bodies remain outside retained events. Empty summaries do not establish redaction, unsupported capability, or hidden content that can be recovered.

Generated sources were inspected under the main checkout's `.tmp/work/codex-protocol-0.163/` directory. SHA-256: summary-part notification `beeae50a6a6f7a3438d7cb6e49e4353228f92c554e5331bf6f288ff7a50b1932`; summary-text notification `46edaeb45c009106583d4793419b1a60b621cf93aecba734b7ef103178416261`; separate content-text notification `be86447b21cca238370ec3074d903dbedd6f28f298b482d2938e46f39fd1c2ae`.

## Correlation and truthful partials

The additive private `coding-chat` summary event keeps the native method, thread, turn and item, plus a strict snapshot, part-added or delta update. Native summary indices stay distinct from content indices and application request IDs. Initial and final snapshots remain independent of per-index streamed text; the producer does not assume their prefix equivalence.

A delta requires a known active reasoning item. An unannounced but bounded index is retained with `prefixMissing: true`; a later part announcement cannot repair that gap. Empty ignored deltas create no phantom part history. A final item snapshot or final interrupted-turn snapshot may arrive without a started report. A matching final-turn snapshot after item completion adds the distinct native turn status without reopening that item's stream. Native item/turn closure and actual final turn status are retained without inventing a reasoning-completed status. Exact duplicates are deduplicated before persistence; conflicting or post-closure facts refuse. A saved terminal outcome still fences all later turn frames, and a recorded failed/interrupted native final status cannot become a successful saved outcome.

Whole history independently proves the immutable native Chat snapshot, owned process and exact native thread/turn/version before accepting summary facts. Partial pages require their protected binding and use whole-state verification at the server. Raw fields and mismatched source/update/partial/closure combinations are rejected by the strict private codec. The sealed Keeper codec and generic coding-activity-on-Chat refusal remain unchanged.

## Bounds and verification

Commands and summaries consume one shared 2 MiB rich-report budget per accepted turn, with a 64 KiB event limit. Native items share the existing 256-item bound. Summary indices/parts are limited to 128; a retained snapshot and each item's cumulative summary stream are limited to 16 KiB UTF-8. Clipping and normalization are explicit, do not split a code point, and cannot be followed by a misleading resumed prefix. These are application retention limits, not claims about provider capability.

The first actual supervised inert runtime tracer failed while the decoder discarded summaries, then passed after the minimal producer. It includes a raw-content/encrypted sentinel and verifies that only explicit summaries are retained, assistant text stays separate, exactly one native turn starts, and no raw or summary-generation option is sent. Focused actual private tests cover full/partial reads, export, recreation, exact retry, completed-only/interrupted snapshots and Stop/deadline partials. Strict protocol/history tests cover scope, index/source confusion, malformed data, duplicates/conflicts, truncation, terminal fences and the shared command/summary budget.

Presentation, browser, full-suite and native gates follow the producer review checkpoint. No separately named private reasoning design board has been verified; the renderer will reuse the existing session activity disclosure and tokens.
