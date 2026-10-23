# Owned Codex Chat and approval decisions

This producer admits the native app-server runtime through the existing owned
session registry, conversation lease and private journal. It adds no composer or
approval UI. The parent Codex feature remains open until those controls are real.

## Interface alternatives

1. **Selected: explicit Chat branch and a live approval broker.**
   `start(projectId, {provider:"codex", launch:{mode:"chat", ...}})` prepares an
   immutable `codexChat` snapshot under the existing dispatch lease. The adapter
   calls `broker.offer(address, actualApproval, signal, persist)`. A protected
   decision supplies only the original decision UUID, accepted-turn UUID, opaque
   approval UUID and one offered decision. The broker hides native process,
   thread, turn, item and typed RPC binding, persistence order and invalidation.
   Existing Claude and Task requests keep their exact parsing and hash bytes.
2. **Generic RPC primitives.** Expose native requests and a caller-composed reply
   object. This is smaller to wire initially, but makes the caller responsible
   for identity, permitted reply variants and duplicate native writes. It is too
   easy to accidentally expose session-wide grants or answer another process.
3. **A separate Chat lifecycle object and registry.** An object would own native
   lifetime, private history, decisions and resume independently. This would
   duplicate the current lease and restart rules, leaving two sources of Start
   and accepted-turn authority. It is deferred rather than replacing settled
   ownership contracts in this increment.

The first design keeps the public decision surface small while retaining native
details privately. It deliberately accepts an additive provider branch rather
than generalizing every existing transport and request codec.

## Public and private boundaries

- `CodexChatStartRequest` is an explicit Codex `mode:"chat"` branch. The server
  supplies cwd/context and checks the current project, repository, registered
  worktree, optional bead and About references. Native command arrays, resume
  selectors, prepared snapshots, staged paths and broader permissions are never
  wire fields. Text attachments are bounded; image/schema staging is unavailable.
- Each accepted turn saves its exact `PreparedCodexChat` in the private user
  frame. A later turn keeps the original smith/model/effort/cwd selection and
  canonical directory identity, and resumes only its confirmed native binding.
  The existing Task service continues to accept exactly one turn.
- Native configuration, scoped usage, approval requests/decisions/resolutions
  and wrapper/provider process identities use a private `coding-chat` envelope.
  Last-response and thread-total usage remain separate. No configured model is
  promoted to an observed execution model. Text remains the common private text
  projection. The sealed standing Keeper codec rejects these additions.
- `GET /projects/:id/sessions/:sessionId/approvals` is operator-protected and
  read-only. It returns only callbacks actually owned by this process, plus an
  optional original receipt selected by `requestId`. Actionable views carry no
  native RPC selector or process identity. Saved request history is never live
  authority; recreation has no actionable callbacks.
  A pending view rechecks the current read-only project/worktree/About scope and
  then reads callback state again, so native resolution during validation cannot
  leave an actionable stale view. Historical receipt lookup does not reauthorize
  execution and therefore does not need fresh mutable execution scope.
- File-change Allow is disabled while actual correlated diff details are
  unavailable. The protected view names that limitation, and accepts only a
  native-offered decline/cancel. Native reason/item identity does not synthesize
  a diff or justify a public Allow action.
- `POST /projects/:id/sessions/:sessionId/approval-decisions` is an audited action
  (`session.approval.decide`). Scope is part of the original decision hash.
  A private `coding-chat-decision` intent is durably appended through the live
  accepted turn's owner before the broker resolves one native callback.
- An immutable `state:"recorded"` receipt proves only the saved decision intent.
  It does not confirm stdin delivery, native approval resolution, command
  execution or file effects. Exact retries return that receipt before mutable
  scope checks and never resolve a second callback. A different UUID cannot
  repeat an already recorded approval. Conflicting content under the original
  UUID is refused. UUIDs are scoped to the owned project/session journal.
- Stop, native resolution, runtime deadline, broker deadline and close invalidate
  callbacks. A late persistence completion may confirm historical intent, but
  cannot restore callback authority. Failed or timed-out persistence never
  releases a callback. Queued decisions disappear from actionable reads while
  their outcome is pending; unknown answers require original receipt lookup.

## Resource and execution bounds

Native runtime bounds remain those in `codex-chat-contract.md`. The broker holds
at most 128 live approvals across its owned sessions, with a 120-second default
approval lifetime (maximum five minutes) and a five-second default persistence
deadline (maximum 30 seconds). Private transcript/frame/registry limits remain
the existing limits; there is no eviction or automatic replay.

The compiled hearth passes its fixed `--codex-sync` command prefix to both Task
and Chat. Public requests cannot select it. Native startup still uses the gated
source/compiled bootstrap and actual process-tree ownership. No account, model,
credential-file or real tracker calls are fixtures.

## Verification

Pure protocol tests preserve the literal Claude hash and strict Task policy.
Broker tests cover persistence-before-release, restart reconciliation, foreign
scope, unoffered decisions, Stop during persistence and never-settling writers.
Actual inert native processes prove private Start and exact thread resume after
service recreation, and accept/decline/cancel round trips. Hermetic HTTP with a
compiled inert provider proves protected reads/actions, audit-before-effect,
held/lost response reconciliation, two turns and actual tree cleanup on Stop.
The common API authority/refusal matrix includes the new read and action rows.
