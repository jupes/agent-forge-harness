# Native Chat command reports

This slice implements `agent-forge-harness-cla5.4.4.8`. It reads command reports from the reviewed `codex-cli 0.163.0-alpha.10.2` app-server protocol. It does not use the separate snake_case Codex Task decoder or change the sealed Keeper journal.

## Source contract

The primary contract is the locally generated experimental protocol for that exact CLI version: `v2/ThreadItem.ts`, `ItemStartedNotification.ts`, `ItemCompletedNotification.ts`, `CommandExecutionOutputDeltaNotification.ts`, `CommandExecutionStatus.ts`, and `ServerNotification.ts`. The generated `commandExecution` item supplies command, cwd, status, nullable aggregate output, nullable exit code, and nullable duration. Native thread, turn, and item identifiers remain distinct from the accepted application request.

The reviewed `ThreadItem.ts` SHA-256 is `9eec6b2ee0ce090fa0c8976e0afa5eca07cc3b529bbbe75ead5520291ec9f7f0`; the output-delta notification SHA-256 is `20e015b65e534534a846bbe6ec74bdbfff7cde1401728d3f0f81127dd20a9f89`. Generated source was inspected under the main checkout's `.tmp/work/codex-protocol-0.163/` directory. The implementation does not claim an unprovided private design board was reviewed; it reuses the existing session activity disclosure and Nocturne tokens.

## Private boundary and bounds

Commands are additive `coding-chat` events with literal native method provenance. The strict private codec checks provider/version, native identities, status, null versus zero, output source, and partial flags. Whole history additionally requires the immutable Chat snapshot, owned process, exact bound native thread and turn, item identity, lifecycle order, and terminal fence. Generic `coding-activity` events are still refused on Chat. Public metadata and saved command text grant no process, file, or approval authority.

Each retained text field is at most 16 KiB of UTF-8. A command's cumulative retained output prefix is also at most 16 KiB; clipping or normalization is explicit and later deltas cannot fill a gap. Private command reports are limited to 64 KiB each and 2 MiB per accepted turn, within the existing native frame and complete-journal limits. Exhausting a protocol/report budget refuses truthfully rather than presenting a complete transcript. Full command completions can arrive without an earlier started notification; unknown output deltas cannot create an item. Exact native duplicates are deduplicated, while conflicting or late facts are refused.

Initial aggregate output, retained delta output, and final aggregate output are separate native facts. A final aggregate is not assumed to equal or extend streamed output. Missing final output does not erase a saved stream or become an empty successful result. A final interrupted turn can contain a command still reported `inProgress`: its command remains partial even though the turn ended. That snapshot cannot revive output, permissions, Stop, or continuation.

## Display and validation

Command disclosures start collapsed. Command, output and reported cwd render as inert text; output regions can be reached and scrolled with the keyboard. Native statuses, including `declined`, are preserved. Missing exit/duration remain unreported; zero remains zero. A selected partial page labels a missing stream prefix. Task command presentation shares only the inert body renderer and retains its original wire contract.

Focused tests exercise actual inert app-server execution, interrupted final snapshots, malformed/foreign/conflicting/duplicate/late frames, UTF-8 and aggregate limits, private partial reads, export, recreation and exact original retry without another prompt. Pure presentation tests cover scope, separate output facts, missing prefixes, inert content and absence of controls. The authored browser journeys cover completed command output/reload/foreign scope and actual Stop retaining a partial stream; browser execution remains a separately coordinated gate.

Reasoning, file diffs, MCP results, and emitted native plans remain later rich-activity slices. Live permissions continue to use only the existing protected current-request protocol.
