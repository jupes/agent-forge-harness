# Review Keeper session proposals

The session card opens the same Claude form used by the provider-aware New
session and bead launch composer. Keeper review currently accepts only Claude;
Codex and Gemini Task/Chat remain available through ordinary New session. It
keeps the source proposal visible while the operator edits the full
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

Before any Start or retry is sent, a bounded browser journal reserves and reads
back only its source-bound UUID metadata under an origin-wide Web Lock. It stores
no prompt, attachment, launch options or input fingerprint. An existing identity
from another window wins. Unavailable, corrupt or full storage refuses dispatch;
uncertain identities are never evicted. If the app reloads before the server has
recorded the original, its UUID remains held through a protected 404. The exact
private input is unavailable until a later protected read recovers it; there is
no replacement Start or automatic resend.

The protected recovery receipt is checked against the source, original UUID and
the SHA-256 of the complete canonical Start input. A registry reservation alone
does not confirm admission. The owner adopts only a matching session plus original
private-journal turn receipt into the existing session client. Adoption sends no
ordinary Start and leaves ordinary composer drafts and navigation state alone.
Late malformed replies cannot undo confirmed admission. Full prompt, attachment
and launch history remains in the private recovery route rather than public
session-list rows or activity metadata. Protected reads recheck current project
membership and the served workspace after the proposal journal and private
session reads. Archiving a project preserves readable history.

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

The packaged Windows probe runs after the existing empty Keeper checks. It
plants a completed strict private proposal, reads its original through the
compiled protected route, and checks prefill, a separate edited draft, keyboard
Cancel, visible provider limits, unavailable Claude and unchanged private files.
Its read-only Git stand-in answers only three metadata commands from the two
planted smoke checkouts; no command is forwarded to a real Git or provider.

The review screenshot shows the source and form at a capture-only 1280×1400
viewport, with its repository masked. Functional keyboard, reduced-motion and
no-write assertions run first at 1100×700; the command footer remains below the
captured scroll area.
