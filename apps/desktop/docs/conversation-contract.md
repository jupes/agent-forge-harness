# Standing Keeper conversation

This implements the persistence/dispatch boundary of the standing Keeper in
decision 21–22 at `7e41bba`, plus the restricted Claude streaming transport and
project reader. The complete Keeper screen, briefs, action cards and shared
drawer remain in their owning beads.

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
Private transcript reads and the body stream require the operator token,
through the same runner that owns action authority. The model's separate
project reader has no such token and cannot read transcripts.
The existing runner owns same-origin, token, body validation, audit-before-effect
ordering and envelopes. A page accepts only `after`, `limit` (1–100) and an
optional UUID `requestId`; duplicated/unknown parameters are refused. Neither
reads nor transcripts are ledger stream collections. A send body is capped at 80,000
bytes and its message at 16,384 characters. No model token or action tool exists
at this boundary.

`types/conversation.ts` is separate from `LedgerEventInput`. Frames currently
hold user messages, provider identity, assistant text, actual process/configured
smith, observed model, read traces and context provenance. `ConversationTransport`
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

Nonempty object context is refused until mention membership checks are connected;
a path or arbitrary object id cannot grant knowledge. The full conversation and
drawer now share one app-root client. The remaining mention, proposal, brief and
provider-switch features are not counted as complete by the renderer tests.

## Shared renderer and private replay

`GET /projects/:id/keeper/events` is an operator-authorized private body channel,
separate from the page's one metadata ledger feed. It sends validated conversation
pages of at most ten frames, with exact sequence cursors, latest 50 turn records
and the retained last sequence. An ahead-of-history cursor is refused. Stored
frames are published after writes; local change notifications wake observers and
a bounded periodic read observes foreign writers. Slow readers stop further
writes until their socket drains. Closing an observer never stops its provider.

`createKeeperClient` owns per-project drafts and pending request identities at
the app root. Full page and drawer use that same client and local conversation
address. Switching projects closes the observer and releases its body cache;
late callbacks cannot paint the new project. Reconnect uses the last validated
sequence, has deadlines and finite retries, and never sends a provider request.
Strict pure schemas are shared by the store and renderer. Gaps, conflicting
duplicates, foreign addresses and malformed frames preserve partial text and
require a fresh replay.

An uncertain send keeps its original UUID, text and expected revision. A null
lookup does not prove an in-flight request will never arrive. Explicit retry
therefore submits that exact original identity; another message stays held until
its receipt is confirmed. A receipt does not bypass replay: Send waits until the
corresponding revision is observed. Stop remains pending until confirmed terminal
state. Delayed reads or Stop replies cannot regress a newer replay.

The reading column renders escaped Markdown elements (headings, lists, tables,
code, safe web links), scoped read-trace links, source/time/completeness and
reported/estimated/unknown context. The composer grows, Ctrl/Cmd+Enter sends,
plain Enter adds a line, and scrolling away preserves position with Jump to
latest. The shared native dialog traps focus and returns it on Escape. Minimum
viewport, reduced motion, visible focus and inert hostile markup are exercised
in the desktop browser suite. Recorded context fixtures are synthetic; no
production occupancy measurement or allowance is invented.

## Restricted Claude transport

The hearth supplies `createClaudeConversationTransport` by default. The configured
default crew must be an enabled Claude smith; another provider or an unsupported
CLI is explicitly unavailable, without selecting a fallback. Before admission,
bounded, supervised `--version` and `--help` probes check required capabilities
without starting a model. Dispatch checks again and uses the actual observed
session UUID with `--resume`; there is no latest-session, fork or resend fallback.

The prompt and user-controlled project text travel as JSON on stdin, never argv.
Argument arrays use `--restricted`, manual permissions with prompts denied,
`--tools ""`, an exact `--allowedTools mcp__keeper__read_project`, and a strict MCP
configuration containing only the sealed reader. Skills and Chrome integration
are disabled; user/project setting sources are empty and `disableAllHooks` is
requested. Administrator-managed policy remains authoritative. An unexpected
advertised or invoked tool interrupts the stream and leaves completion unknown.

The child receives the executor's environment allowlist plus explicit app home
and adapter marker. All inherited harness correlation variables are removed;
any environment value containing the live operator token is removed even when
explicitly allowlisted. The model receives no operator token or action tool.
Windows requires a native executable, avoiding command-shell shim quoting.

The line decoder preserves split UTF-8 and bounds packets, including an output
producer that never sends a newline. The parser tracks each message's content
blocks, reconciles full assistant packets with partial text, deduplicates packet
UUIDs and omits thinking content. Read traces contain ids, source/time,
completeness and cursor, without duplicating source bodies. Context occupancy is
explicitly unknown when the CLI supplies no measurement; usage totals are not
treated as occupancy or provider allowance. Pending transcript writes are
serialized and bounded. Protocol/storage failures stop the supervised tree;
accepted partial frames remain private. Completion requires matching identity,
the restricted profile, a successful terminal result and exit zero. A timeout,
missing terminal or identity fork cannot claim completion.

The source reader is a Bun entry point. The packaged hearth explicitly launches
itself in `--keeper-reader` mode, so installed apps do not depend on source paths.
`scripts/keeper/verify-reader.ts` checks either runtime against a private fake
hearth. The Windows smoke includes that check before opening the shell.

Installed Claude Code **2.1.296** was checked with help/version only on Windows.
No live model, paid request or authentication probe was made. Fake CLI tests
exercise actual pipes, MCP, hearth reads, persistence, resume and process-tree
termination; they prove that plumbing, not a successful live-provider turn.
The stream mapping follows the provider's [streaming reference](https://code.claude.com/docs/en/agent-sdk/streaming-output)
and [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Project reader

`GET /projects/:id/keeper/read` supports only `beads`, `queue`, `sessions`,
`runs` and `activity`, with an optional id or bounded cursor/page size. Bead
indexes omit descriptions; an id requests details. Exact workspace, saved epic
ancestry and the exact project label jointly control membership. A reused
session id never grants foreign event access. Each activity event needs its own
workspace and member-bead binding. Checkout-only run observation, unavailable
sources, truncation and pagination are explicit.

One MCP tool, `read_project`, wraps that row over a direct literal-loopback
connection. Its launch seals the hearth origin and project UUID; model arguments
cannot change either, supply paths or request actions. Replies are checked for
matching scope/kind/mode/ids before their bodies are returned. Foreign or malformed
responses produce generic errors without echoing their content. Every response
is bounded to 48,000 bytes, including Unicode scope metadata. This reader is a
separate profile from the general hearth MCP server and exposes none of its
operator tools.

## Selection context and drawer

Ctrl/Cmd+J and the session inspector's Ask Keeper control use the shell's existing
typed selection. They open the same project conversation and attach opaque
bead/session/run/event references. The app-root client owns drafts and references;
the drawer owns focus and presentation. Opening, closing, navigation, suggestions
and context checks never start or stop a model turn. Escape closes suggestions
before the drawer; closing the drawer restores the invoking control's focus.

About chips show scope-checking, confirmed and unavailable states. Unknown or
failed context holds Send until retried or removed. The server independently
checks each reference through the exact project reader rules before preflight
and again at admission. Incomplete sources can confirm an exact observed member,
but cannot authorize absent records. Provider prompts carry typed references,
never automatically copied record bodies. The sealed model reader rechecks
current scope when it actually reads an object.

Mentions query a bounded index with provenance and an exact-id fallback. Late
results cannot replace a removed/re-attached chip or another project's choices.
File paths remain human prompt text: no arbitrary filesystem-read capability is
introduced. Slash suggestions use `docs/js/generated/commands.ts`; choosing one
only edits the draft. It does not invoke a CLI or expand a command's permissions.
Each Send snapshots references alongside its request UUID and text. Unknown
delivery and explicit retry preserve that snapshot despite subsequent edits;
an exact recorded retry reconciles its receipt even if membership later changes.

## Briefs

Preparing a brief is a two-step, explicit review. An audited
`POST /projects/:id/keeper/brief-intents/reserve` supplies only the expected
conversation revision and an origin selector that the server resolves. For
onboarding, its request UUID must match the verified, accepted project-creation
request; project paths and scope are never accepted from the browser. Under the
standing conversation lease, the server freezes a bounded project-evidence
snapshot, the effective prompt and About references, and the selected Keeper
configuration into a private canonical original with a server-minted request
UUID. Reservation performs no readiness probe, provider check or model
dispatch.

Operator-only `GET /projects/:id/keeper/brief-intents` discovers only the
bounded identity, scope, selection and lifecycle metadata. An explicit review
uses the protected
`GET /projects/:id/keeper/brief-intents/:requestId` to read the exact frozen
original into renderer memory. The canonical original body remains in the
owner-home journal: it is not stored in browser persistence or copied into
generic pages, feeds, events or audit records. The audit ledger records action
metadata only.

Sending the reviewed original is a separate explicit
`POST /projects/:id/keeper/briefs` containing only its request UUID, expected
conversation revision and intent hash. Under the same conversation lease, the
server atomically admits that exact frozen original and user frame. Only a new
admission (`created: true`) may dispatch one provider turn; a replay returns
readback and never dispatches again. Lost or unknown outcomes remain held under
the same identity; they do not trigger an automatic retry or replacement
request. An unrelated human draft and its About references survive review and
send.

Only a completed, identity-confirmed turn whose structured output cites existing
facts in the correct Moving, Waiting on you or Stuck section becomes a brief.
Failed, unknown, cancelled or malformed brief attempts preserve the last
confirmed brief and its original time. Source titles and model prose are text,
with no action authority. The metadata ledger contains neither snapshots nor
prose.

Operator-only `GET /projects/:id/keeper/briefs` projects the latest confirmed
brief and at most ten earlier briefs from that same journal. Keeper, Overview
and visible Projects home cards use the app-root client's scoped private cache.
Reads coalesce and a completion during a read queues one follow-up read; a failed
read retains the last verified projection and offers an explicit read retry.
Brief age uses source time; missing source counts remain unknown. Runs are
checkout-only observations, sessions are ledger observations, and bounded or
unavailable evidence remains explicit. Follow-up quotes the selected brief and
time into the existing draft and starts nothing. There is no approved scheduling
producer, so this version introduces no timer or unattended paid generation.

## Keeper readiness and explicit continuation

`GET /projects/:id/keeper/recovery` is an operator-only, bounded read. It
projects the selected smith, configured alternatives, timestamped readiness,
the current continuation and an optional exact UUID receipt lookup. Connection
(`ready`, `signed-out`, `adapter-missing`, `unknown`) and allowance
(`available`, `exhausted`, `unreported`) remain separate. A failed report never
establishes sign-out or exhaustion. Unreported allowance permits an explicitly
requested turn when the sealed adapter capability check succeeds. No report
ranks or automatically selects smiths.

Concurrent reads of the same conversation revision and smith catalog share
their in-flight readiness checks. A service-wide budget permits at most four
native capability checks across projects; later reads recheck rather than
cache a readiness claim indefinitely. Closing rejects queued checks and waits
for active checks to settle. Continuation writes independently recheck readiness
under the dispatch lease, so a read never authorizes a later change.

`KeeperRuntime` in `scripts/keeper/recovery-runtime.ts` is the trusted provider
report/adapter seam. Production currently supplies the sealed Claude Keeper
transport, with read-only version/help probes. It does not probe authentication,
read credentials or invent usage. Other coding adapters do not become Keeper
adapters: alternatives without a sealed reader remain unavailable. The known
Haiku/effort verification gap stays explicit. Real provider readiness producers
can supply specific reports later; browser reports and multi-provider transport
tests are synthetic fixtures, not evidence of a live signed-in provider.

`POST /projects/:id/keeper/continuations` is an ordinary audited action carrying
the original UUID, expected conversation revision, explicit smith, `switch` or
`fresh`, and at most 12,000 characters of operator-reviewed retained summary.
The client and private journal preserve that text exactly; whitespace-only
text cannot satisfy the required retained context for a new native identity.
The service holds the conversation dispatch lease, rechecks current configuration
and readiness, then atomically commits selection and continuation in the same
private journal. Active or unknown turns, disabled/unknown smiths, stale
revisions and unavailable adapters refuse without changing selection or history.
Exact retries reconcile the original record before mutable readiness checks;
lost responses never cause a second change or a model start.

The optional `keeperRecovery` journal extension retains all prior frames and up
to 100 immutable continuation receipts; it refuses further changes rather than
evicting UUID history. Generic session journals do not populate it. Private body
replay exposes only current selection/generation/continuation, not raw receipt
history. Native identity remains for a same-provider smith change. Start fresh
or a different provider clears that identity; another provider never receives
the old provider's resume id. A change itself starts no provider. The next
explicit Send receives the exact reviewed summary on stdin; subsequent turns
resume the new observed native identity without redundantly injecting it.

Start fresh never silently generates a summary. The operator can review text
prefilled from the last confirmed brief or write the exact context to keep. The
UI describes that retention, preserves the saved transcript and draft, and shows
context occupancy as unknown until the new conversation reports it. Confirmed
historical briefs remain verified against their own completed turn identities,
so changing native identity cannot erase the last confirmed brief. Full Keeper
and drawer share original pending change identities and receipts at the app root.
Overview's brief panel also explains unavailable or unverified readiness and
links to that project's Keeper controls. A missing CLI keeps both attended
brief Refresh and Send disabled; the packaged no-CLI smoke fixture verifies
that refusal, while compiled fake-provider E2E tests verify available starts.

`recovery-{store,service}.test.ts`, `readiness.test.ts`, the renderer recovery
client tests and the common API authority matrix cover fencing, bounded history,
cross-provider identity isolation, no silent fallback, changed readiness,
unknown delivery and delayed responses. `keeper-recovery.spec.ts` uses the real
isolated hearth and compiled fake CLI to verify explicit switching, a lost
response, shared drawer selection, reviewed-summary stdin, new/resumed native
ids, distinct unavailable reasons, keyboard focus and the minimum viewport.

## Keeper proposals and explicit review

Completed, identity-confirmed ordinary replies may contain one strict
`keeper.proposals.v1` message with at most seven inert drafts, capped at 24 KB.
The server derives each source id and reply hash from the private transcript.
Partials, examples embedded in prose, brief replies and model-supplied result or
approval fields never become action cards. The provider still receives only
the sealed `read_project` tool; no operator token or mutation tool is added.

Protected `GET /projects/:id/keeper/proposals` shows up to forty recent cards,
bounded at 128 KB. Its optional request UUID reconciles an original review even
when the source card falls outside that window. The app-root client shares local
drafts, pending requests and confirmed receipts between full Keeper and drawer.
It follows existing private conversation updates and the shared ledger stream;
there is no extra stream, polling loop or automatic business retry.

Approve and Dismiss are ordinary audited action rows. Owner-only private
`conversations/keeper-<project-id>-proposals.json` retains reviewed arguments,
request UUID/hash, the actual audit event id and result under a lease. Approval
is persisted before dispatch. Exact retries observe the original attempt;
changed attempts or a second review of the same card are refused. Interrupted
effects remain outcome unknown and are never replayed on read or restart.
Ledger rows contain metadata, never reviewed prose or decision bodies.

The fixed server dispatch map reuses the existing operator routes for checked
queue approvals, child creation then queue proposal, pause/resume/reassign, and
`design:` decision comments. Each step rechecks current project membership and
legal queue capability. Partial or unverifiable responses stop later steps and
retain links to affected objects. The provider cannot select routes or headers.
Activity opens verified metadata from the original audit row. Session, attended
shift and council cards expose review fields with a concrete unavailable reason
until their destination integration beads land; they never report success.
