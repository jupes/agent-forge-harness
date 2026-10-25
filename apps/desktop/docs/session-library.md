# Owned session exports and archive

Session actions operate on a registered, private app-owned session in the current
project and served checkout. Public observations and registry metadata do not supply
transcript bodies or process-control authority.

## Complete saved transcript

Export saved transcript performs one protected read of the complete validated private
journal. The JSON document identifies its format/version, session, saved revision,
last sequence and complete frames/turns. It includes user-selected attachments,
provider reports and requested-versus-observed identity exactly as saved. Internal
turn owners, lock records and Keeper decision authority are omitted.

The server verifies the original private launch and each turn's saved input hash.
Missing, corrupted, foreign or unsupported history refuses the export. A complete
document larger than 8 MiB refuses explicitly; a first page is never presented as a
complete transcript. The client independently validates the complete document and
bounds its streamed response. The download notice says that a download was requested,
not that the operator saved the file. A running provider can add later activity after
the exported revision.

## Archive and restore

Archive is a reversible preference in a separate versioned private library. It hides
the known session from the default app-owned list. Show archived app sessions exposes
it again; Restore session returns it to the normal list. The selected conversation
and its genuine Stop control remain available while archived. Archive and restore
never stop a process, change launch identity, remove frames or trim history.

Each explicit change freezes one UUID, expected library revision and archive value.
A bounded browser journal reserves only source identity and that metadata under an
origin lock before dispatch. It stores no prompt, attachments or transcript. A lost
reply retains the exact original across navigation and reload. Check archive status
is a protected read; Retry original archive change is the only explicit resend and
reuses every original field. A missing receipt does not create a replacement UUID.
The server saves applied or refused receipts, checks scope again under its write lock,
and returns the original receipt for an exact retry. Stale revisions are refused.

## Current route capabilities

| Control | Supported boundary |
| --- | --- |
| Export | Complete current saved private revision, subject to the verified 8 MiB limit. |
| Archive / restore | Private reversible metadata; independent of running ownership. |
| Stop | An active app-owned turn controlled by the current hearth; pending until its private receipt confirms cancellation. |
| Continue this Chat | A completed Claude Chat with confirmed native binding and supported `--resume`, or a completed native Codex or Gemini Chat with the matching saved native version and conversation binding. The live private view must be current, with no pending turn or Stop. This only focuses the reply box; the operator must explicitly send the next message. |
| Task continuation | Claude, Codex exec and Gemini CLI Tasks accept one turn. Start another session explicitly. |
| Copy original CLI preview | Uses the serializer for the exact original saved Claude, Codex exec, native Codex Chat, Gemini Task or native Gemini Chat snapshot. The private input is not copied. Native Codex and Gemini Chat previews start only their stdio server; the original handshake and private input are separate. |
| Fork | Unavailable in this view. The pinned native Codex Chat protocol defines `thread/fork`, but this app has not implemented scoped admission, persistence and binding for a new owned child session. Gemini Chat fork is also not implemented. |
| Native terminal handoff | Unavailable in this view: no owned terminal handoff action is implemented. Copy original CLI preview is a separate explicit clipboard action and includes its input instructions. |
| Review native permissions | Native Codex and Gemini Chat can focus their existing inline permission cards while the owned turn and live view are current. This navigation supplies no new approval authority and sends no decision. Only the current protected approval page supplies actionable choices. |
| Other route permissions | Claude, Codex exec and Gemini CLI Tasks cannot receive live permission decisions here. Historical reported denials remain read-only evidence, not a pending approval request. |
| Waiting for provider input | Unavailable: these transports do not expose interactive input requests. A completed Chat may accept an explicit next turn where the Continue control is supported. |

The matrix distinguishes the saved provider and route. A registry row or a CLI
preview cannot establish native approval or process authority. Managed shift origins
remain outside these ordinary actions. Fork and terminal handoff are not offered by
this app; their availability is not inferred from a provider name or historical report.

## Design and verification source

This increment follows the authoritative design brief at commit
`7e41bba140493849d9f9b2dd3b8ada6773e374a2`, sections 6.8 and 9, and reuses the
actual Light Session template `95744122`, shared Nocturne tokens and the existing
session reading area. The supplied eleven HTML pages were inspected as multi-board
documents. No unseen Composer-Claude or dark Session-Codex board is claimed as
verified design evidence.

The native Chat follow-up verifies the unchanged initial header geometry before
keyboard navigation intentionally scrolls that header. At 1100 by 700 with reduced
motion, Session actions keeps its 2px focus indicator, Review native permissions
focuses the existing inline controls, and Continue this Chat focuses the reply box
without accepting another turn. Copy uses the exact saved serializer; only the next
explicit Send resumes the confirmed native thread. Actual inert-provider journeys
also verify interrupted updates, project isolation, Stop through reload, archived
scope and native approval deadlines. A protected still-current offer is descriptive
waiting even when a held original decision prevents a duplicate choice.

Current captures: [session actions](screenshots/native-chat-actions.png) and
[native permission state](screenshots/native-chat-permission-state.png).

Focused units cover complete revision and scope/hash validation, oversized refusal,
separate archive revision chains, before/after-save faults, cross-window reservation,
unknown recovery, late replies and response bounds. Real-hearth browser journeys use
compiled inert CLI fixtures: more than 100 saved frames plus an attachment download,
running archive/reload/retry/restore, applied lost replies, explicit native Chat resume,
read failures, keyboard focus and the 1100 by 700 reduced-motion layout.
