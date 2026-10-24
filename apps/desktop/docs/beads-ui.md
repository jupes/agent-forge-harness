# Live project beads

The desktop Beads destination reads the current hearth tracker, scoped by saved
epic ancestry **and** `project:<slug>`. It does not load a dashboard snapshot.
`GET /projects/:id/beads` is an operator-protected read in the common route table.
The existing shared project export supplies the data; this adds no second tracker
command and no ledger stream.

The list preserves numeric P0–P4 and raw tracker status. In particular, deferred
does not become open, P4 does not become P3, and creator/owner is not an assignee.
Ready requires exact `open`, no assignee, and no unresolved active blocking edge.
`from` depends on `to`; parent-child hierarchy and related edges do not block.
Closed dependents are excluded from Blocked. A missing prerequisite is unresolved.
Foreign prerequisite details are withheld; an unresolved count explains the wait.

The six views compose with search, type, priority, status, queue state, label,
epic and assignee filters and grouping. Counts describe the current served scope.
Epic progress follows explicit ancestry with a cycle guard. Queue state and smith
come only from backed queue entries. Unknown values stay dashes with an explanation.

Selecting a title opens the inspector. Enter or double-click opens the stable bead
route with `view=full`; ids are encoded, never row indexes. Tabs support keyboard
navigation. The selected bead alone is expanded with the bounded `beadId` query;
every other row reports `detailsLoaded: false`. This keeps long implementation
packets and comment histories out of the metadata list. Unknown, foreign and
repeated query fields are refused. Reads exceeding 1,000 rows or 1 MB fail explicitly.

Details retain description and acceptance criteria separately. Comments preserve
their recorded prefix, author and time; a short embedded export is labelled
incomplete. Files uses the scheduler's existing pure Files-section parser and
the selected bead's workspace ledger reservations. Declared globs are not changed
files. Activity returns only bead-bound event identity, kind and time, never event
bodies. A failed ledger read remains unavailable; empty observations are qualified
by source. Sessions uses the existing scoped project observations.

Both inspector and full-width reads show errors, retry and the read timestamp.
Failed refreshes label retained details as the last confirmed read. Start is
disabled while details are loading or unavailable; its composer still performs
fresh server-side scope and capability validation. Tracker writes, the new-bead
dialog and council review belong to their subsequent beads.

Source: handoff and brief at `7e41bba140493849d9f9b2dd3b8ada6773e374a2`,
brief section 6.9, plus the supplied States-lists and States-beads-queue galleries
(templates `3aea77ca` and `e6d4004b`). The supplied eleven pages were recursively
inspected, including bundled templates. They contain those states; the complete
Beads-ready and Beads-epics composition boards are absent. This uses the brief's
specified structure and existing desktop frame/tokens, without claiming a visual
comparison against an unavailable full composition board.

Focused tests cover scope, exact priority/status, dependency direction, closed and
missing blockers, selected-detail bounds, protected reads, scoped ledger metadata,
combined filters and cycle-safe epic progress. Browser journeys exercise the real
hearth with the compiled tracker stand-in; they never write the actual tracker.
