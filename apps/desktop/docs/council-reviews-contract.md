# Project Council review contract

This document describes the protected Hearth producer API implemented by
`scripts/hearth/routes/project-council.ts`. It covers durable review preparation,
explicit dispatch, and protected readback. A desktop review UI and its source
prefill behavior are separate work; this API contract does not claim native
desktop acceptance.

## Routes

These routes are operator-only and use the currently served Hearth workspace.
Project authority is resolved from the current project catalog and workspace;
the client does not supply a filesystem root or scope hash. Reads and actions
accept no query parameters.

| Method and path | Purpose | Success |
| --- | --- | --- |
| `GET /projects/:id/council/reviews` | Read bounded history for the served project/workspace | `200`, strict history data |
| `GET /projects/:id/council/reviews/:requestId` | Read the exact retained original and its metadata | `200`, strict original data |
| `GET /projects/:id/council/reviews/:requestId/run` | Read the exact receipt and public run result | `200`, strict run-read data |
| `POST /projects/:id/council/reviews` | Prepare and durably reserve a review | `202`, metadata and `created` |
| `POST /projects/:id/council/reviews/:requestId/commit` | Confirm and dispatch the reviewed original | `202`, receipt |
| `POST /projects/:id/council/reviews/:requestId/retire` | Retire a still-reserved review | receipt |
| `POST /projects/:id/council/reviews/:requestId/cancel` | Request cancellation of an owned run | receipt |

The `:id` is a project ID and `:requestId` is a lowercase UUID. Commit, retire,
and cancel bodies contain exactly `{ "intentHash": "<64 lowercase hex>" }`.
Their responses are strict receipts with metadata and a phase; the HTTP receipt
does not expose the service's internal `created` flag.

## Reserve request

The reserve body is strict and contains:

```json
{
  "sourceChoice": { "sourceType": "text", "source": "review text" },
  "profileChoice": "<advertised profile choice>",
  "maxUsd": 1,
  "maxBytes": 200000,
  "redactSecrets": true,
  "deepDiscussion": false
}
```

`sourceType` is `text`, `bead`, `file`, `plan`, or `pr`. `profileChoice` names
an available profile choice. The source selector is at most 256 KiB for text
and 4 KiB for other source types; the request body is capped at 2 MiB. Prepared
context is capped at 1 MiB, the complete stored original at 2 MiB, and each
review's effective `maxBytes` cannot exceed 1 MiB. The service resolves current
project membership and scope, prepares and validates the context/profile, and
snapshots normalized non-secret provider endpoints. Provider credentials are
not stored.

The `202` response is `{ "metadata": ..., "created": true|false }`. A retry of
the same active project/workspace choice returns the existing original with
`created: false`; a different choice conflicts while that unresolved original
is held. The metadata's `requestId` and `intentHash` identify the exact review.
Use that hash for every subsequent action; do not reconstruct or substitute it.

## Dispatch and recovery

Commit re-reads the saved original, checks the exact intent hash, and verifies
the current project scope, selected profile, readiness, and effective provider
endpoints before claiming dispatch. The durable claim happens before provider
work. Only the first successful claim starts a run; commit replay returns the
retained receipt and does not start a second run.

After dispatch has been claimed, an uncertain launch or response stays marked
unknown. The service does not automatically retry provider work or clear that
identity. Read the exact original and run route to recover its state. Retire
only applies to a still-reserved original. Cancellation is an explicit request
against the exact owned original; it does not rewrite or replace review input.

The retained original and its run are correlated with private request, intent,
project, workspace, and scope provenance in addition to the run ID. A matching
run ID alone is not sufficient evidence that a job belongs to the review.

## Read privacy and bounds

History has a strict envelope containing `version: 1`, the trusted
`projectId` and `workspace`, `activeRequestId`, `total`, `omitted`, and at most
100 metadata-only rows. The header is produced from the server-side store's
configured project/workspace pair. The complete history response is capped at
512 KiB; it contains no reviewed source body or transcript.

The exact-original route is the explicit protected read for the prepared
context and profile. Its whole response is capped at 3 MiB. The run route
returns a strict receipt, provenance, and bounded public job/result data,
including the public discussion/transcript needed to inspect a completed run;
the whole response is capped at 8 MiB. Neither route returns private provider
prompts or transport payloads. Oversized or invalid retained data is refused
whole rather than silently truncated.

The durable journal is private to its project/workspace pair and is bounded to
1,000 retained originals and 32 MiB. It does not evict an unresolved or
unknown original to make room.

## Shared contract and composition

Browser and server validation should use the exported strict schemas in
`types/project-council.ts` (`projectCouncilReserveRequestSchema`,
`projectCouncilHistorySchema`, `projectCouncilOriginalReadSchema`, and
`projectCouncilReceiptSchema`) and `types/project-council-run-read.ts`
(`projectCouncilRunReadSchema`). The run-read module also exports its 8 MiB
response bound and projection builder. Clients should parse responses with
these schemas; checking only an `{ ok, data }` envelope is not sufficient.

Hearth composition supplies the existing `withQueueLock` implementation to the
Council store. The store fails closed without that lock; its module does not
import the Bun scheduler lock, keeping the service importable in browser/Node
contexts. The Bead verdict hook is scheduled only for the first created commit
and only for a verified completed run whose saved source is a Bead. Replays and
other source types do not post a verdict.
