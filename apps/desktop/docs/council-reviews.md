# Project Council reviews

The Reviews destination prepares a private saved original for a project. The
source and profile choices remain a renderer-local draft until **Prepare
original for review** is explicitly selected. Preparation reserves the
canonical request and reads its protected original back; it does not convene a
Council run or call a model provider.

The saved original is shown only in the explicit review view. The page checks
the project and served workspace, request identity, published original schema,
and SHA-256 of the canonical intent before displaying it. The original body is
held in memory for this view; it is not written to browser storage, ordinary
project feeds, or events. Markdown is rendered as safe elements, and control or
format characters are made visible in the presentation without changing the
saved bytes or their identity hash.

If a reserve or retirement response is lost or cannot be verified, the request
stays held. **Check saved reviews** uses the protected project history, then the
protected exact-original read for the active request. An empty list or missing
read alone never proves that a request was not saved. Retirement is available
only for a verified original whose state is still `reserved`.

After reviewing the original, **Convene this exact original** sends its saved
request ID and intent hash once. A verified receipt is followed by a protected
original read and an identity-bound run read. An uncertain result stays held;
the page offers readback and does not submit Convene again. Explicitly opened
active runs refresh through one bounded, abortable read at a time while the
view is open. Stop requests cancellation and reports it only after a matching
saved result confirms the state.

Saved history loads metadata only. Selecting **Read saved original** is the
explicit action that retrieves a stored private original; **Check saved
result** then reads its complete public transcript, findings, discussion,
seat records, evidence, and actual cost fields. Failed and cancelled results
may show partial records but do not receive a fabricated recommendation.

The selected profile view reports configured readiness, seats, model names,
and gateway routing policy from the local Hearth configuration. Readiness is a
local configuration check, not a provider call. The exact saved view shows the
profile, endpoint snapshot, source material, scope, budget, and request hash
that were actually persisted.

Source-entry prefill from Beads, queue, runs, and session flows is not yet
implemented. Drafts currently live only in this mounted view; preserving them
across navigation and confirming replacement of a different source remain
required work. Mounting, reloading, or changing projects will not start or
commit a run.

This consumer is an integration checkpoint, not completion of the Council
feature. Additional history summary facts, cancellation/failure browser
journeys, source entry points, and keyboard/native acceptance remain on
`agent-forge-harness-cla5.7.2`.
