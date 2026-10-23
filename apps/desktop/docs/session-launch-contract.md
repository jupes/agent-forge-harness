# Private session launch and lifecycle

The session foundations in `cla5.4.1.1` and admission increment in `cla5.4.1.2`
support app-owned sessions. The parent retains composer presentation and its
board-specific acceptance criteria. The standing Keeper retains its sealed
transport and existing storage paths.

## Journal ownership

`OwnedConversationAddress` in `types/conversation.ts` is a trusted server value,
never a provider identity or arbitrary file path. A session address binds one
catalog project UUID to `session-<UUID>`. `createConversationStore` and
`createConversationService` accept an optional fixed address. Omission preserves
the standing Keeper's identity, journal and leases.

Owned journals are `conversations/session-<UUID>.json` below the hearth's private
home. Each has its own dispatch lease and write lock; admission and subsequent
updates use the same write lock. Two service instances for the same address
share ownership fencing, while different sessions can run independently.
Address/project mismatches and foreign journal contents are refused before
mutation. Provider-reported resume identities remain inside the selected
journal; a session cannot borrow another journal's identity.

## Claude launch formatting

`serializeClaudeLaunch` in `scripts/sessions/claude-launch.ts` consumes the strict
`ClaudeSessionLaunch` and separately observed `ClaudeLaunchCapabilities` types.
Its output contains actual argument-array values, private stdin and an equivalent
PowerShell preview. Execution must use the resolved executable plus `argv`,
never parse the preview. Prompt, inline text/images and typed context stay on
stdin. Output schema uses the documented CLI option; its preview is redacted and
explicitly requires restoration before it can reproduce that request.

Task starts once. Chat may resume only an exact previously verified Claude UUID;
this serializer alone does not implement Chat lifetime. Effort requires both an
observed CLI flag and separate support evidence for every exact selected model.
Help/version output proves neither authentication nor a successful model turn.
Unsupported options and permission bypass are refused. Coding tools retain the
existing harness allowlist; this formatter never changes Keeper's tools.

## Explicit admission and identity

`createSessionRegistry` reserves one original Start UUID and canonical content
hash to a project-bound `session-<UUID>`. Exact retries return that address before
current configuration is revalidated. The private metadata index cannot dispatch
work: only an accepted turn in the selected journal grants dispatch authority.
Reads and restart never replay a provider turn. A reservation with no accepted
turn can be retried explicitly using the same Start request.

`createOwnedSessionService` validates current scope under admission and again
under the owned dispatch lease. It freezes a versioned `SessionTurnSnapshot`
before the process starts. Exact retries reconstruct that snapshot, including
attachments, before comparing the journal's request hash. Public Keeper messages
cannot supply it. Generic message text preserves exact whitespace. Snapshots are
capped at 2 MiB; the complete journal still has its existing 8 MiB ceiling, which
is checked before accepting a turn.

Task accepts one turn. Chat's next explicit turn uses only the confirmed native
binding in its own journal. Subsequent turns preserve the original model, effort,
mode and options while replacing text, attachments, checked About references and
the verified resume UUID. A missing identity or unknown outcome holds later
turns. Closing the client does not stop work. Explicit Stop requests cancellation
and immediately returns the `cancelling` phase; `cancelled` is confirmed only
after the supervised process tree exits.

The dedicated coding transport is independent of Keeper's sealed read profile.
It probes the installed CLI without a model request, rechecks the prepared
version and capabilities, filters the environment, supplies private stdin and
uses the existing process supervisor. Its parser deduplicates partial/full text,
checks identity continuity and excludes subordinate messages from the main reply.

The ledger's session id is the stable app-owned id, distinct from the native
provider UUID retained privately as the resume binding. Actual observed model
metadata can carry that native identity independently. Start/prompt metadata is
emitted only after the supervised process frame; the prompt hash and length use
the exact serialized stdin, including context and attachments. No transcript,
attachment, reviewed options or provider-error prose enters the ledger. The
project projection uses the private registry to admit owned sessions with no
bead; it never infers membership from an id prefix or accepts conflicting foreign
bead/run correlations.

## Presentation and remaining integration

The server owns executable resolution, filtered environment, model
capability evidence, repository/worktree scope, optional bead membership,
audited explicit Start, durable request identity, provider lifecycle and project
session projection. A supplied context or extra-directory string grants none
of those capabilities. Composer UI, creation of a new worktree, command/template
selection and additional provider integrations remain with the parent and later
beads. Existing worktrees must be in the served repository's current Git registry;
extra directories stay physically inside that checked worktree. Child-script
session mirrors/run correlation are a separate integration and are not claimed
by these tests. No credential files or paid model requests are involved.

Unit tests exercise independent journals, cross-instance leases, write-lock
contention, foreign binding refusal, strict formatting and actual supervised
fake-process argument/stdin/environment pipes. Existing desktop E2E verifies
that the default Keeper paths remain compatible.
