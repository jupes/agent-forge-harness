# AGENTS.md — docs\js

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.

## Notes

- **One connection to the event stream per page** (`use-stream.ts`). A view never opens its own: it reads a slice of the live state with `useStream(select)`, or follows the ledger with `useLiveRead(route, kinds)`, which reads a dev-only route on mount and again when an event of one of `kinds` is applied, or `useOperatorRead(path, kinds)`, the same for an operator API read route (`/__agent-forge<path>`, its envelope unwrapped, an `ok: false` answer an error in the hearth's words). `useOperatorRead` also returns a `reload`, for a view that just changed something: an `operator.action` event is appended before its effect, so a read it triggers can come too early (the Workbench reads again after each answer). Pass `kinds` as a module constant. The app root holds one subscription for the life of the page (`LiveBanner` in `app.tsx`), so moving between routes does not close the connection.
- The rules that turn a snapshot and its deltas into state are pure functions in `app-state.ts` (`applySnapshot`, `applyDeltas`, `liveStats`), and the session and reservation folds there mirror `listSessions` and `activeReservations` in `scripts/ledger/query.ts`: change both sides together. Runs and the queue are not folded from events; their read routes are fetched again on the event kinds named in `use-stream.ts`.
- The stream is read with `fetch`, not the browser's event-source class: the hearth takes the resume id only as the `Last-Event-ID` request header, which a page cannot set on a connection that class opens. Reads send no operator token.
- An answer that is not an event stream (a static host) turns live updates off after one request, for the life of the page; a failure is retried with a jittered, doubling wait and gives up after six in a row. A connection that sends nothing for 45 s (three keepalives) is a failure, timed from the request: a hearth that hangs never answers. Behind the dashboard's proxy, the answer arrives only with its first byte, which on a resume is the keepalive 15 s after the request, so the limit must stay above that. A connection counts as working, and the count starts again, only when it has been open for 5 s and is then heard from (a delta or a keepalive); a stream that stays silent never resets it. Every page of a static copy therefore makes one request for the stream, which fails and shows in the console. Nothing polls on a timer, and nothing is logged per event. A page must keep working with live updates off: `useLiveRead` still does its first read, and anything drawn from the live state is absent, not broken.
- A new component that reads the stream is a pure view plus a thin wrapper that calls the hook (`islands/LiveStatus.tsx`), so the view is testable as a plain function.
- The dashboard's Beads cards (`islands/BeadCounts.tsx`) read `GET /beads/counts` with `useOperatorRead` and follow `bead.transitioned`. They show the tracker's counts while every initiative is shown (the route counts the whole tracker), and the snapshot's with an initiative chosen, before the hearth has answered, and where none answers (on a static copy that read is one more failed request each time the dashboard is shown). A write made with `bd` outside the hearth records no event, so the cards show it at their next read. The dashboard's two stat rows are mounted without a snapshot as well (`app.tsx`); each is absent where it has nothing to show.
