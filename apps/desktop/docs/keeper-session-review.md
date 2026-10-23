# Review Keeper session proposals

The session card opens the same `SessionComposer` used by New session and bead
launches. It keeps the source proposal visible while the operator edits the full
launch: prompt, selected files/images, About context, repository/worktree, Task or
Chat, smith, model, effort and supported options. Opening, editing, templates,
preview and Cancel do not approve or start a session. Worktree creation remains a
separate explicit action; closing a review preserves an already created worktree.

The app-root review owner keys drafts by project, proposal ID and source hash.
Ordinary New session drafts and other proposal drafts keep their own values and
worktree receipts. A proposed `current` worktree resolves only to a checked
registered main whose canonical path matches the proposed repository. Otherwise
the form requires an explicit worktree choice. The proposed smith and configured
effort are retained. An unavailable provider is locked with its reason; the form
does not choose another provider automatically.

Only explicit Start posts the reviewed envelope to the audited Keeper-to-session
bridge. The envelope freezes the proposal source hash, proposal-journal revision,
one original Start UUID and the entire strict Start body. A lost or refused reply
does not release that identity. Check is read-only; retry sends the same envelope.
Even a 404 cannot rule out an earlier request still reaching admission. After
reload, a card's recorded request UUID also keeps a replacement Start locked until
the full original can be recovered.

The protected recovery receipt is checked against the source, original UUID and
the SHA-256 of the complete canonical Start input. A registry reservation alone
does not confirm admission. The owner adopts only a matching session plus original
private-journal turn receipt into the existing session client. Adoption sends no
ordinary Start and leaves ordinary composer drafts and navigation state alone.
Late malformed replies cannot undo confirmed admission. Full prompt, attachment
and launch history remains in the private recovery route rather than public
session-list rows or activity metadata.

Source authority is commit `7e41bba140493849d9f9b2dd3b8ada6773e374a2`, design brief
§6.5 and §6.7. The audited eleven HTML pages contain multiple boards. They include
Light Session `95744122`; no separately named Composer-Claude-from-Keeper board
was present. This implementation reuses that verified session treatment, the
brief's composer order and existing Nocturne tokens. It does not claim fidelity
to an unseen board.

Focused tests cover inert Cancel/edit, exact original retries, saved input/hash
recovery, registry-only uncertainty, known-UUID 404 locking, deferred reply races
and project isolation. Real-hearth browser coverage uses compiled fake providers
and a recording tracker stand-in; no paid provider or real tracker is reachable.
The guarded temporary-Git journey holds an actual worktree creation reply across
Cancel and a protected history read. Once that read finishes, the confirmed path
is selected without another creation; Cancel retains the worktree and starts no
provider.
