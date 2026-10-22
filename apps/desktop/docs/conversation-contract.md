# Standing conversation foundation

This implements the persistence/dispatch boundary of the standing Keeper in
decision 21–22 at `7e41bba`. The complete Keeper screen, restricted real provider
transport, project tools, briefs and shared drawer remain in their owning beads.

## Public surface

`createConversationService({home, root, transport, onChange?})` lives in
`scripts/conversations/service.ts`. It exposes:

- `read(projectId, {after?, limit?, requestId?})`: a bounded transcript page,
  latest 50 turn records, an explicitly requested receipt and process-control
  eligibility. Reading never starts a provider or rewrites transcript content.
- `send(projectId, {requestId, expectedRevision, text, about})`: explicit human
  admission; its receipt is not a completed answer.
- `stop(projectId, requestId)`: cancellation requested, with confirmed terminal
  state only after the supervised transport terminates.
- `settled(projectId)` and `close()`: trusted lifetime/teardown seams.

The operator rows are `GET /projects/:id/keeper`,
`POST /projects/:id/keeper/turns` and `POST /projects/:id/keeper/stop`.
The existing runner owns same-origin, token, body validation, audit-before-effect
ordering and envelopes. A page accepts only `after`, `limit` (1–100) and an
optional UUID `requestId`; duplicated/unknown parameters are refused. Neither
reads nor transcripts are stream collections. A send body is capped at 80,000
bytes and its message at 16,384 characters. No model token or action tool exists
at this boundary.

`types/conversation.ts` is separate from `LedgerEventInput`. Frames currently
hold user messages, provider identity and assistant text. `ConversationTransport`
in `scripts/conversations/transport.ts` supplies the private body channel and
must settle only after its supervised process tree terminates, including on
error/abort. It receives the exact observed resume identity. No universal
provider command flags are assumed by the service.

`onChange` contains project/conversation/request ids, revision and phase only.
Its failure never repeats a turn. Transcript bodies, read output and provider
errors must not be projected into the ledger. The API audit target is the
project id; the audit contains no prompt or answer.

## Persistence and recovery

The immutable project UUID derives one local address:
`keeper-<project-id>`. A name change or renderer navigation cannot fork it.
Bodies and recovery metadata are stored together in the hearth-owned session
file `conversations/keeper-<project-id>.json` under the private hearth home.
Version 1 is strict; malformed/future/foreign records are refused and preserved.
There are at most 1,000 turns, 20,000 frames and 8 MiB per conversation file.
There is no automatic retention, deletion, compaction or fresh-session fallback.

`readSessionTranscript` uses the existing opened-file permission and text checks
with a fixed 8-MiB ceiling. It is a Bun hearth reader; the lock/catalog client
reader remains fixed at 64 KiB, including its Node bridge. Conversation and
lease directories reject pre-existing links and non-directory entries before
opening locks. Files are replaced atomically through `writeOwnerOnly`. The
recovery tests cover process interruption; no exactly-once provider or
power-loss guarantee is asserted.

A small SQLite write lock serializes transcript replacement. A separate
per-conversation SQLite lease is held across dispatch and provider lifetime;
the OS releases it when the owning process dies. A waiting contender does not
own control of the active process. Callback writes require the recorded owner
generation, so stale output cannot replace a recovered turn.

Admission persists the caller UUID and canonical content hash before dispatch.
An identical request returns its recorded receipt before revision checks;
conflicting content is refused. Concurrent copies share admission. Only one
turn can be active; an unknown outcome prevents a new turn.

The service persists `running` before invoking the provider. A crash in the gap
can therefore be conservative: delivery is unknown even if the process never
started. It never resends such work. A lease-free read derives the interrupted
view without rewriting transcript data or its last confirmed activity time.
The next explicit action can persist recovery under the lease. Unissued work
is failed, never automatically dispatched. Issued work is unknown. Partial
text stays available. Successful completion requires an identity observation in
that turn; a changed provider session id is a continuity error.

Stop changes an issued turn to `cancelling`; only the actual owning hearth may
claim process control. A late success after cancellation settles as cancelled.
Closing an observer has no service operation and cannot stop a conversation.
Closing the hearth aborts and awaits only jobs it owns; queued admission cannot
dispatch after close begins.

## Verification and downstream integration

`scripts/conversations/{store,service}.test.ts` covers stable addresses,
two-project isolation, duplicate/conflicting/concurrent sends, actual
cross-process leases, hard interruption, partial output, exact resume identity,
pending cancellation/late success, transcript growth, linked and malformed
storage, bounded replay and body-free metadata updates.
`scripts/hearth/routes/conversations.test.ts` verifies the real hearth's audited
admission, lost-response lookup and readonly opening. `api.test.ts` includes
every new row in the common refusal/audit matrix. The hermetic hearth uses
`fakeConversationTransport()` from `scripts/conversations/testing.ts` and never
starts a real provider.

Production transport is explicitly unavailable in this foundation checkpoint.
Nonempty object context is refused until project-bound membership checks are
connected; a path or arbitrary object id cannot grant knowledge. The next
integration supplies the restricted CLI transport and scoped read results,
then renders body frames in the shared full/drawer conversation with escaped
Markdown, linked objects, read traces and honest context measurements. Those
features are not counted as complete by these storage/API tests.
