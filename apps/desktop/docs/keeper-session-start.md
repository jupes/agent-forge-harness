# Reviewed Keeper session Start contract

This backend increment implements cla5.4.3.1. A Keeper `start-session` suggestion remains a small, untrusted source draft. The operator reviews the full ordinary session launch in the shared composer. Opening, editing and cancelling that draft grant no approval and create no session. Preview and Create worktree retain their separate explicit, audited actions.

## One explicit Start

`POST /projects/:id/keeper/proposals/:proposalId/session-start` accepts only `{sourceHash, expectedRevision, start}`. `expectedRevision` is the proposal journal revision; `start` is the existing strict ordinary Start request with its original UUID. Caller-supplied provider resume identity and server context are refused. The action is `keeper.proposal.session.start`, through the existing operator gate, token, bounded body validation and persisted audit runner.

Fresh admission verifies the completed Keeper source and hash, served project/workspace, current scope and supported full launch. It verifies the source again after preparation. Only then does the existing private proposal journal durably store the complete typed intent, original UUID and full reviewed body. The existing owned-session service alone admits the private user turn and dispatches it. Ordinary Start's request format and canonical hash are unchanged; the proposal review hash separately covers project, proposal, verified source and full Start.

The old small proposal Approve route cannot authorize a session launch. An unsupported source provider is unavailable; it is never silently replaced with Claude.

## Original request and recovery

Protected `GET` on the same path returns `{projectId, proposalId, revision, record, original, startHash, session, receipt}`. An optional `requestId` must name the exact original UUID. Reads never dispatch, reserve, approve or replay. The original body is returned only by this private lookup; ordinary proposal pages keep their bounded source draft and metadata.

A registry reservation is not dispatch evidence. Confirmation requires the original private turn and first user frame, matching UUID, exact text, object context, attachments and full launch, including the server-owned project/repository/worktree context. The bridge verifies smith, working directory, immutable session metadata and the private turn's existing input hash. Missing or mismatched private input refuses confirmation and preserves stored bytes. An accepted turn is distinct from a started process or a successful provider outcome; the receipt retains the actual current turn phase.

After a lost or refused response, keep the original UUID and complete body. Check the protected original request. A missing receipt or a `404` is not permission to create another identity while an earlier POST may still finish. No read automatically continues a saved intent. Only an explicit retry of the exact original can call ordinary Start again; its existing journal prevents repeating an accepted turn. Changed content or identity refuses. Mutable configuration can become unavailable without preventing same-workspace history reads. Another served workspace cannot read or retry the private original, even when both share one home and project.

## Storage and evidence

The owner-only proposal journal reads legacy version 1 and upgrades to strict version 2 on the first typed session intent. It preserves existing reviews, caps records and intents at 1,000 and the file at 8 MiB, and refuses overflow without eviction. Corrupt, future-version and linked journal storage is preserved and refused. Full prompts, attachments, launch bodies and provider error prose never enter the ledger. Existing audited session metadata remains the only session projection there.

Focused tests cover operator authority and audit order, strict requests, source/revision/capability refusal, source changes during preparation, shutdown, exact full-launch preservation, three interruption boundaries, restart reads, one-run explicit retry, original user/hash correlation, workspace privacy, legacy migration, bounds, links and a fixed ordinary Start hash fixture. All runtime effects use fakes.

The UI follows design source `7e41bba140493849d9f9b2dd3b8ada6773e374a2`, sections 6.5 and 6.7, by reusing the actual shared Light Session composer (board 95744122). The exact Composer-from-Keeper board was unavailable; this backend contract does not claim visual verification of it. Composer interaction and browser coverage belong to cla5.4.3.2.
