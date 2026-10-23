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
| Continue this Chat | An idle Claude Chat with the confirmed native binding and supported `--resume` capability. This only focuses the reply box; the operator must explicitly send the next message. |
| Codex exec Task continuation | Unavailable: the current Task route accepts one turn. |
| Fork | Unavailable: no native fork or reviewed-summary continuation producer is connected to this view. |
| Native terminal handoff | Unavailable: no authorized handoff is connected to this exact native conversation. Copy original CLI preview is a separate explicit clipboard action and includes its input instructions. |
| Live permissions | Unavailable on these routes. Historical reported denials remain read-only evidence, not a pending approval request. |

The matrix describes the current Claude and Codex exec Task producers. A future native
Chat or permission producer must add its own strict codec and authorization before
this view advertises the capability.

## Design and verification source

This increment follows the authoritative design brief at commit
`7e41bba140493849d9f9b2dd3b8ada6773e374a2`, sections 6.8 and 9, and reuses the
actual Light Session template `95744122`, shared Nocturne tokens and the existing
session reading area. The supplied eleven HTML pages were inspected as multi-board
documents. No unseen Composer-Claude or dark Session-Codex board is claimed as
verified design evidence.

Focused units cover complete revision and scope/hash validation, oversized refusal,
separate archive revision chains, before/after-save faults, cross-window reservation,
unknown recovery, late replies and response bounds. Real-hearth browser journeys use
compiled inert CLI fixtures: more than 100 saved frames plus an attachment download,
running archive/reload/retry/restore, applied lost replies, explicit native Chat resume,
read failures, keyboard focus and the 1100 by 700 reduced-motion layout.
