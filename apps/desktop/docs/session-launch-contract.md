# Private session foundations

This increment prepares `cla5.4.1` without exposing a Start route or composer.
The standing Keeper retains its sealed transport and existing storage paths.

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

## Required integration

The server still owns executable resolution, filtered environment, model
capability evidence, repository/worktree scope, optional bead membership,
audited explicit Start, durable request identity, provider lifecycle and project
session projection. A supplied context or extra-directory string grants none
of those capabilities. Later integration must persist the accepted private
launch snapshot before dispatch, preserve unknown outcomes without replay and
confirm provider identity before resuming. No credential files or paid model
requests are involved in the foundation tests.

Unit tests exercise independent journals, cross-instance leases, write-lock
contention, foreign binding refusal, strict formatting and actual supervised
fake-process argument/stdin/environment pipes. Existing desktop E2E verifies
that the default Keeper paths remain compatible.
