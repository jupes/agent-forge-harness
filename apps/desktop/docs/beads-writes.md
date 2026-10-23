# Project Beads write contract

This increment implements cla5.5.2 on the project browser from PR284. Existing global Beads routes remain the canonical write implementation. Their new create fields are optional, so existing dashboard and Keeper approval callers retain their prior behavior.

## Create fields and scope

`GET /__agent-forge/beads/options` supplies types, priority hints, limits and the supported complexity benches. Create additionally accepts `labels` (at most30 bounded ASCII labels), `complexity` (`low`, `medium`, `high`) and `fileMap` (at most100 relative globs). Queue labels and raw complexity labels cannot be submitted as ordinary labels. The existing file-map parser validates globs; a supplied map becomes the canonical `## Files` section of the description. An existing Files section and a separate map are refused rather than silently shadowing one another. The final description still has its original4,000-character limit.

Explicit labels disable parent-label inheritance. Complexity becomes its existing `complexity:<bench>` label. This prevents inheriting an approved queue label or conflicting complexity from a parent. Ordinary callers that do not supply labels or complexity keep their original inheritance behavior. A rich create confirms the title, type, priority, description, acceptance criteria and explicit label set printed by `bd`; missing or different fields produce an unknown outcome naming the created bead, never a retry.

The desktop uses `POST /projects/:id/beads` and `/projects/:id/beads/:beadId/{claim,comment,close,propose}`. These are action rows in the existing operator table. Origin, token, bounded validation and persisted audit precede the effect. The scope wrapper checks the current catalog revision, served workspace, archive state and exact ancestry-plus-project-label membership. Create requires a current parent epic and adds the current project's label; another project's label is refused. After a create, a fresh read verifies actual project ancestry and membership before reporting Done. A failed post-create read remains unknown and never creates again.

Proposed is an explicit existing queue transition after a confirmed create. Creating under an approved parent grants no approval. A lost or refused proposal transition must preserve the confirmed created identity and report that transition separately; it cannot invite a second create. Claim, comment and close reuse their original single-call confirmation, with exact returned-identity checks. Close requires readable evidence in its reason.

## Contract evidence

The create arguments and JSON fields were measured with installed `bd1.1.0` in a newly generated OS-temp Git repository and embedded tracker with no Git or Dolt remotes. Explicit `--no-inherit-labels` plus project/UI/low-complexity labels omitted the parent's queue approval and high complexity. The printed description, acceptance criteria, priority and labels matched. The generated fixture was removed after verification; the real tracker was never a test fixture.

The shared hearth and browser stand-ins now model acceptance criteria, explicit labels and suppressed inheritance. The repository's real-tracker queue contract comparison passed all5 cases/64 assertions against that disposable tracker. Focused route tests cover the rich field contract, invalid maps/labels, unknown readback, foreign/archived scope, operator authority, evidence, post-create read failure, and separate Proposed transition. Table fixtures exercise all five protected project actions through the ordinary audit/refusal matrix.

The form, persistent pending notices, client outcome checks and browser journeys are the next integration slice of the same bead. This producer checkpoint does not claim those UI checks or final whole-bead completion.
