# Project Workbench boundary

Bead: agent-forge-harness-cla5.5.3. Source: desktop brief6.10 and queue/list state galleries at7e41bba. The existing queue table, scheduler eligibility, reservation rules and operator action effects remain authoritative.

## Interface alternatives

**Scoped snapshot plus canonical moves.** One protected `GET /projects/:id/workbench` projects the current project queue, eligibility, host observation and supported smith choices. Project-scoped move rows wrap the existing queue action objects. The desktop uses the existing window ledger stream to refetch and its persistent write journal for exact outcomes. A caller sees one bounded page and only explicit operator moves. Scope enforcement, foreign wait redaction, current catalog checks and canonical state rules stay behind the boundary.

**Dedicated Workbench stream.** A new event stream could combine tracker, scheduler and shift observations into independently pushed cards. This would introduce a second window stream, new resume/cursor semantics, polling ownership and another recovery protocol. Those costs do not improve the current ledger-triggered page refresh and would increase the ways stale project state could arrive.

**Desired-state command.** A single apply endpoint could accept a bead and target queue state, selecting intermediate transitions automatically. That hides steps from the caller but obscures human approval and may perform several effects for one gesture. Approval, queueing and resuming must remain individually reviewed operations, so this shape is unsuitable.

The first interface is selected for the authorized implementation bead. It keeps one read boundary and reuses the actual legal-move table. It accepts a bounded snapshot rather than a new continuous protocol, and explicitly retains each operator decision. The existing desktop metadata journal can admit queue move receipts without changing the ledger's separate BeadWrite and QueueAction domains.

## Read and write contract

The page is bound to project id, canonical served workspace and read time. Current epic ancestry **and** project label establish membership before card details, activity, eligibility reasons or reservations are exposed. Unknown tracker data refuses the page; unavailable eligibility, smith configuration or host observation has its own reason and cannot produce a positive May start badge. An outside-project prerequisite or reservation remains a conservative wait with its private identity and paths withheld.

All eight queue states retain the queue's backed-label and resume semantics. Legal moves come from `operatorMoves`; `queueStateOf` checks the complete raw scoped row, including unknown queue labels. Duplicate or unknown labels offer no moves; inherited/unbacked labels offer only Propose. Unknown-only labels are identified in a scoped warning rather than silently counted as an empty queue.

`smithFor` resolves the actual bead metadata, deterministic weighted complexity bench, then configured default. Cards and smith filters use that same name and provenance. Unknown or disabled selections remain unavailable and cannot produce May start. A shift's explicit smith override is separate from this default observation. Reassignment confirms the exact requested configured smith. No gesture starts a shift or provider process. Host checks use the existing cross-platform sampler and current configured threshold; positive eligibility remains subject to a shift's own admission and limits.

Project moves perform the common origin/token/body/audit gate and recheck the current catalog, workspace, archive state and bead membership before the unchanged canonical queue effect. Response verification requires the exact selected bead, requested action, destination and recorded result; reassignment additionally confirms the chosen smith. Lost replies hold the original project write in the persistent Inbox journal. Refetching changes the displayed snapshot and never repeats a move automatically.

The canonical API now answers a post-write external-writer conflict with504: the update already happened, so409 Refused would incorrectly release the desktop hold. A pre-existing broken label or illegal move still answers409 before an update. The queue algorithm and ledger event kinds are unchanged.

The journal retains requested smith metadata, exact verified destination and operation identity without storing a private request body. Successful moves restore keyboard focus only after the confirmed destination/smith is observed. A transient background read uses `aria-disabled` with the same held handler guard, preserving focus while preventing a premature write. Reads reuse one window ledger stream, refresh after action results and reservation/session/shift/gate events, and poll every15 seconds while visible. Positive eligibility expires after30 seconds or any failed refresh.

| Backed state | Operator moves |
| --- | --- |
| Proposed | Approve, Pause, Reassign |
| Approved | Queue, Pause, Reassign |
| Queued | Pause, Reassign |
| Running | Pause |
| Review | Pause |
| Done | None |
| Paused | Resume to the saved legal destination, Reassign |
| Halted | Queue, Reassign |

Closed beads offer no move. Done starts collapsed. Selection uses the bead id in the Workbench route and survives moves; its inspector uses the existing scoped bead read. Running cards link the newest observed session, provider, start time and worktree when available. A queue label supplies no PR, gate pass, halt explanation or repair count: those values remain explicitly unavailable until a producer supplies them; the bead opens recorded details and worklogs. Shift management belongs to the dependent5.4 bead, and council/other work connections retain their own delivery beads.

## Design source evidence

All eleven supplied nested template pages were audited. The `e6d4004b` Beads/queue gallery provides all state and priority treatments; `3aea77ca` provides Workbench loading, empty, error and filtered-to-nothing treatments. The local export does not contain the complete Workbench composition, so this implementation uses brief6.10 at7e41bba, the existing desktop frame and Nocturne tokens. No unseen-board fidelity claim or invented sample activity is made. The board scrolls inside its own container at1100×700; counts and Done remain keyboard accessible.

## Verification boundary

Focused tests cover project isolation, canonical legal/illegal moves, inherited/broken labels including an unknown second label, foreign reservation redaction, unknown host/eligibility, canonical smith provenance, post-write conflict classification and retained exact write outcomes. Real-hearth fake-tracker browser journeys cover all eight states, deliberate approval/queue/pause/resume/reassignment, selected inspector/focus, actual applied lost approval response and reload/Inbox hold, initial/refresh errors, held-read focus and early-action refusal, empty/filter states, visible2px focus and reduced motion at1100×700. The held-read test is also run against the previous native-disabled behavior and must fail before the fix counts. Full repository, desktop and Windows native gates remain required before completion. Human Windows review stays in its separate open checkpoint.
