# Gemini Task assistant replies

The owned Gemini CLI Task viewer renders assistant text with the existing
safe `KeeperMarkdown` subset and shared `SessionReply` copy button. Raw HTML,
images and unsafe links remain inert. Copy preserves the exact reported text,
including Markdown delimiters and whitespace.

`geminiTaskPresentation(page, turnId)` is a pure, turn-scoped view projection.
It joins only consecutive explicit delta reports. A non-delta report starts a
separate message; tool, notice and other frame boundaries close the segment.
Empty deltas add no text, while an empty complete report still closes a segment.
Foreign turns cannot join the selected turn. A caret appears only for the
trailing open delta segment while that accepted turn is actually streaming.
Terminal, interrupted and saved-only views do not claim ongoing generation.

The native parser already removes user-role message echoes. Saved Gemini text
reports carry text and a delta flag, with no native message identifier. The
projection uses original frame sequences only as local rendering keys; it
does not invent native identities, deduplicate repeated complete messages, or
interpret complete reports as cumulative snapshots.

Private frames, launch hashes, storage validation, export and Start/Stop
authority remain unchanged. The complete export retains the original split
reports rather than the assembled presentation. Tool bodies remain separate
from assistant replies. Configured-model labels, per-model native usage,
unknown outcomes and unavailable allowance/context facts retain their existing
wording.

This follows the settled brief at
`7e41bba140493849d9f9b2dd3b8ada6773e374a2`, section 6.8, and the existing
Light Session template 95744122/Nocturne reply styling. It does not claim
verification against unavailable named dark boards.

Focused presentation tests cover split Markdown, exact copy, HTML/link safety,
empty/full/delta boundaries, interleaved tools/notices, separate turns,
unchanged source frames and streaming/terminal caret behavior. The actual
browser journey is authored in `tests/desktop-e2e/gemini-task.spec.ts`: a
compiled inert Gemini process holds split text for keyboard copy, then emits
tool-separated messages and completes. It verifies reload and the unchanged
complete native export at 1100px with reduced motion. Browser execution and
capture evidence are recorded separately when that coordinated gate runs.
