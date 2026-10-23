# Session composer and private conversation

The sidebar's **New session**, the session list and a selected bead open the
composer. A template, mention, slash command, capability check or Cancel does
not start a provider. **Start** is the explicit model action. Cancel keeps the
project's draft; navigating between projects keeps their drafts separate.

The composer follows the section order in the settled design brief at
`7e41bba140493849d9f9b2dd3b8ada6773e374a2`, §6.7, §6.8 and Appendix A. The
supplied Light Session template `95744122` contains the header, transcript and
composer reference. All eleven supplied HTML pages include nested boards. The
source audit did not find the separately named Composer-Claude or dark
Session-Codex boards. This implementation uses the brief's explicit order,
the established Nocturne tokens and the supplied transcript structure; it
does not claim verification against those unavailable boards.

## Reviewed launch

An enabled Claude smith supplies provenance and its configured model and
effort. Custom options retain that source smith. An unsupported configured
effort remains visible until the operator explicitly selects another effort
or the CLI default. The other provider tiles, permission integrations, raw
flags and saving a smith explain their current unavailable or locked state.
Sign-in, remaining allowance, tool details and files changed remain unreported
when the current producer does not supply them.

The audited supported-options request returns a strict shared Preview receipt.
The browser verifies its project, request, source smith, directory and complete
serialized input. Subsequent draft edits use the same pure serializer and
observed capabilities. Start rechecks current scope and capabilities at the
server. Prompt bodies and selected text/image files travel inline, with a
combined attachment size bound; file paths in mention text do not grant file
access. The displayed command includes the serializer's stdin note and
redactions rather than exposing the private prompt as command-line arguments.

New worktree creation is a separate explicit action. Its original request and
UUID stay frozen through an unknown outcome, a missing lookup and explicit
retries. A planned path from an unknown receipt cannot enter Preview or Start.
Only a confirmed created receipt matching the reviewed repository, base ref,
branch and bead supplies the selected path. A later plan edit requires another
explicit creation. Existing worktrees come from the current registered list;
the main checkout displays the working-copy warning.

## Private conversation and recovery

The app-root client owns Start and Chat request identities independently of
which view is open. A lost Start response is reconciled against its original
admitted private turn; registry reservation alone is not confirmation.
Uncertain actions offer an explicit original-request retry. They never create
a replacement UUID or choose another provider automatically. Confirmation
clears only the unchanged original pieces of a draft, keeping subsequent text,
attachments and About edits.

Only the selected owned session subscribes to its protected private stream.
Frames are bounded, contiguous and checked against the selected project and
session; inactive views release their private frame cache. Sidebar metadata
does not trigger private transcript reads for every row and shows status as
unavailable until observed. The conversation displays actual provider identity,
Markdown replies, partial text, failure and cancellation. Chat replies use the
same native provider conversation. Task accepts one turn. Closing the observer
leaves a running process alone. Stop stays pending until the journal confirms
the provider process ended; a delayed malformed response cannot replace that
terminal confirmation.

## Verification

Focused Bun tests cover immutable Start/message/worktree requests, delayed
responses, field-by-field draft retention, project stream isolation, explicit
effort selection, exact inline files and aggregate attachment bounds. Browser
tests run the desktop renderer against a real isolated hearth and compiled
fake Claude, tracker and Git discovery programs. They exercise Cancel and
preview, draft insertions, lost Start response without a duplicate provider,
native Chat resume, selected attachments, Task, partial failure, observer
close and confirmed Stop. No paid provider or real tracker participates.

The browser assertions include keyboard focus with a computed 2px indicator
and reduced motion at 1100×700. Native window and assistive-technology behavior
remains covered by the epic's separate native/human checkpoints.
