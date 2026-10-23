# Smiths inspection

The global Smiths screen reads the current hearth's saved smiths, benches,
default and recorded scoreboard. It is workspace scoped; selecting another
project does not narrow or widen these values. The workspace path is taken
from the app's existing verified provider report when available. A missing
path is shown as unavailable rather than borrowed from a project.

`GET /smiths` and `GET /config` are checked together. Their named smiths,
benches and default must agree before the view accepts new configuration.
The loader excludes the hearth's ambient environment (`env: {}`). The client
refuses environment provenance and sources absent from the returned files.
Unreported field sources stay unreported. A rank is a single recognized
`rank:*` tag; conflicting tags do not certify a rank or model capability.

Bench weights are positive relative weights, not percentages that must sum
to 100. Display percentages are normalized; disabled choices remain visible.
The saved default is not a resolved selection. Inspection does not call the
resolver to pick a smith, write configuration or start providers.

`GET /scoreboard?since=…` is the existing ledger aggregation for the served
workspace. Available ranges are the last 24 hours, 7 days, 30 days and all
retained recorded events. The producer supports a lower time bound, not an
arbitrary closed interval. Compacted events are excluded. Each recorded
smith/provider/model combination remains separate from the current saved
model and from other recorded models. Event executor metadata is labelled
recorded; it is not proof of a native observed model or remaining allowance.
Reported zero remains zero, and absent cost/token/pass-rate values remain
unknown. Session and council cost totals show their reporting counts.

The read-only controller has independent configuration and scoreboard
states, a 45-second deadline, strict response/data schemas, a 2 MiB data
limit, at most 512 configured smiths and 4096 recorded rows. Tables page
recorded rows in groups of 50. Invalid/oversized data refuses the read; it
never becomes a silently truncated successful result. A failed refresh
retains explicitly last-verified data and the original range label. Range
replacement, disposal and workspace-observer replacement fence late reads.
The hook watches the existing app ledger stream and opens no second stream.
`createSmithsReads` opts into the protected reader's receiving byte cap
before its ordinary whole-body buffering. Overflow cancels reception;
caller/deadline aborts cancel a pending body and cannot become an empty
successful answer. The optional receiving cap does not change uncapped
operator reads, writes, the shared token cache or live event streams.

Creation and editing remain in the parent bead
agent-forge-harness-cla5.7.6 (smith and bench management). The existing scalar
writer is not a full-smith transaction; no write endpoint or arbitrary TOML
editor is added here. No target file is selected in this read-only view.

Apprentice effort support is explicitly unverified and retains the exact
verification ID, agent-forge-harness-cla5.6.6.1 (apprentice effort support).
There is currently no protected global bead-detail route: `routes/beads.ts`
has writes/options, `operator-reads.ts` has counts, and `project-beads.ts`
requires verified project membership. The legacy dashboard uses a generated
snapshot. The task control therefore explains its unavailability rather
than choosing an arbitrary project or claiming a live verification result.

Design source: brief section 6.15 at
`7e41bba140493849d9f9b2dd3b8ada6773e374a2` and the supplied decoded
States-lists-three template `3d2dfd14-9fc1-493a-8ff5-39fff8d0c98f`.
The 11 decoded pages contain multiple boards; searching their nested
templates found the Smiths list-state gallery, but no full Smiths layout.
The view uses the brief's section order and existing Nocturne components
without claiming verification against an unseen board. The gallery's sample
claim that built-ins still work after a malformed file is not copied: the
actual loader refuses malformed configuration, which this view reports.

Focused tests live in `scripts/desktop/smiths-model.test.ts` and
`smiths-client.test.ts`. Actual browser cases live in
`tests/desktop-worktree-e2e/smiths.spec.ts`, collected by the existing
`verify:desktop-worktrees` command/CI step. That fixture serves the renderer
from the checkout and the hearth from an owned temporary Git repository,
with a temporary machine home, seeded metadata and inert CLI stand-ins.
Configuration bytes are restored after each case; no real checkout config,
credentials, provider session or tracker is used. The empty-scoreboard UI
case explicitly supplies an empty read fixture, because other cases may
already have recorded work in the same temporary ledger.
