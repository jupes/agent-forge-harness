# Owned session activity

The selected app-owned conversation reads its protected private journal. It
does not reconstruct reasoning, tool output or files from public session-list
or ledger metadata. `ownedSessionTurn` replaces cumulative reports by native
identity within one turn and joins a tool's original input with its later
result. Different turns and providers remain separate.

`SessionActivity`, `SessionOutcome` and `SessionTurnUsage` render these facts
inside the existing conversation. Reasoning and report details start
collapsed. Commands, tool input/output, paths, diffs and structured JSON stay
inert text; reported paths never trigger filesystem reads. Partial, truncated
and redacted reports say so. Missing line counts, exit codes, model identities
and usage are unavailable rather than zero. The existing safe Markdown
renderer continues to handle assistant replies.

Claude cache-read and cache-creation tokens retain their provider vocabulary.
Its reported cumulative cost estimate is labelled separately from this turn's
charge or remaining allowance. Codex exec retains its existing token fields;
it does not establish an observed model, cost, file diff or line counts.
Per-turn usage does not borrow the previous turn's report. Only actual typed
provider error codes establish authentication or usage-limit labels. A reset
is displayed only when a typed ISO reset was reported.

## Lifecycle facts

The source is the settled brief at
`7e41bba140493849d9f9b2dd3b8ada6773e374a2`, §6.8 and §9. The actual supplied
Light Session template is `95744122`; the nested States-connection-sessions
gallery is `0bbda0cf`. The earlier full audit of all eleven supplied HTML pages
did not find separately named dark Session-Codex or Session-usage-limit
boards. This view follows the available transcript structure and existing
Nocturne tokens without claiming verification against missing boards.

| Brief state | Evidence used here |
| --- | --- |
| Starting | Accepted original private turn, before a running report |
| Running | Running private turn; unconfirmed ownership is explicitly labelled saved status |
| Needs permission | Native Codex Chat only: a current protected pending offer for the exact project, session and accepted turn, with current live ownership. Stop, terminal outcomes, interrupted reads and scope changes take precedence. Historical requests and held original-decision metadata alone do not establish this state. A current verified offer remains descriptive waiting even if an unresolved original decision blocks another choice. |
| Waiting for input | Unavailable: these routes do not report an interactive input request |
| Idle | Completed Chat with a confirmed native conversation binding |
| Ended | Completed Task; a Chat without a native binding cannot claim resumability |
| Ended with error | Failed turn or actual typed provider failure |
| Stopped | Confirmed cancellation or actual supervisor Stop outcome |
| Timed out | Actual supervisor timeout flag and private outcome |
| Stale | An actual interrupted private feed; saved facts do not imply process death |
| Observed | External sessions belong to the separate observed-session producer; owned journals are not relabelled Observed |

Outcome unknown remains distinct from a confirmed end. Internal protocol or
storage kills do not become operator Stop. A pending Stop remains pending
until the original turn's actual outcome is confirmed. Existing provider
Task/Chat capabilities and launch hashes stay unchanged; supported lifecycle
controls are described by the provider-specific matrix in `session-library.md`.

## Reading after a feed interruption

When the selected private feed fails, `SessionsClient` performs one protected
saved-read traversal for that interruption. It uses the existing strict page
codec and contiguous cursor, at most 200 pages, the existing 20,000-frame / 8 MiB
retained-body bounds, and a five-second traversal deadline. The underlying
hearth read already has its own network/body deadline. A late traversal cannot
refill an inactive project cache or replace a newer selected/live view.

A successful saved read keeps the feed visibly interrupted. A malformed,
failed, excessive or late read keeps earlier verified frames and gives a
specific read error with Reload. It does not claim the provider ended, send a
message, retry Start or stop the process. A verified live snapshot ends the
fallback and restores live observation.

## Historical permission denials

The first-party [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpermissiondenial)
defines `SDKResultMessage.permission_denials` as records containing
`tool_name`, `tool_use_id` and `tool_input`. The strict private decoder retains
that exact shape with the checked CLI version (the compiled fixture reports
2.1.296), bounded JSON input, distinct native IDs, an item/serialized-event
limit and explicit list truncation. The default Keeper codec remains sealed.

These are historical denials, not outstanding permission requests. They do not
prove which rule decided, supply a deadline, or grant Allow/Deny authority.
The view offers no approval controls from them. Generic text or arbitrary JSON
does not become a permission report. Malformed or conflicting native denial
identities refuse confirmation.

## Verification

Focused tests cover cumulative report replacement, tool correlation,
cross-turn privacy, inert output, redaction/truncation, provider-specific
usage, exact small cost values, typed resets and lifecycle distinctions.
Deferred fallback tests cover scope switches, deadlines, page/byte limits,
malformed later pages and preservation of earlier verified frames.

Nine browser journeys run the real renderer and hearth with compiled inert
Claude/Codex stand-ins. They exercise protected private replay, historical
denials, actual auth/rate/crash reports, partial activity through real Stop and
timeout, feed failure before the first frame, reload, saved-read failure,
keyboard focus with a computed 2px indicator, and reduced motion at 1100×700.
They invoke no paid provider, real tracker, reported command or reported file
operation. The producer's separate strict-codec and native process tests
remain part of the repository gates.
