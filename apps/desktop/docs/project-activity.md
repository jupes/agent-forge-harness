# Project Activity metadata contract

Bead `agent-forge-harness-cla5.7.4.1` delivers the ready scoped feed core. Parent
`agent-forge-harness-cla5.7.4` retains Runs, Reviews, shift attendance and Keeper
outcome navigation that depend on their actual producers.

## Protected reads

`GET /projects/:id/activity` accepts `after` (default 0), `limit` (1–200, default
100), comma-separated exact `kind` values, recorded `provider`, `bead`, `session`,
`run`, `shift`, `since` and `until` (ISO UTC instants, inclusive). Unknown or repeated
parameters refuse; a misspelled filter never widens the query.

`GET /projects/:id/activity/:eventId` accepts no query parameters and checks the
same membership before returning the selected event. Both routes use the common
operator table, require operator authority and emit no audit or mutation.

Current catalog/served workspace and checked epic ancestry plus project labels
establish bead membership. A foreign explicit bead tag always excludes a row,
including a shared session. An unowned session's untagged row uses its latest
explicit assignment at that event's ledger sequence, not its latest assignment
today or any historical project tag. Current verified registry project metadata
can admit an owned session's untagged row; it grants no new private-read, resume or
process authority. A verified scoped run can include its untagged non-session
events. Untagged shift/council root IDs alone cannot establish project membership.

Historical session candidate membership is limited to 1,000 recent distinct
addresses, current bead IDs to 5,000, and effective assignment lookup to one page
of 200 rows. Candidate truncation is incomplete/unknown, never proof of external
ownership. `membershipComplete` also reflects existing project source bounds and
unavailable sources. Registry records remain metadata and do not prove dispatch.

The raw cursor and `more` advance over all queried rows, including suppressed
foreign and filtered records. An empty visible page with `more:true` requires
continuation; it is not a complete-empty result. Filtering retains this rule.

## Wire boundary

`types/project-activity.ts` and `scripts/projects/activity-protocol.ts` are pure
browser contracts. A page holds at most 200 events/512 KiB UTF-8, exact echoed
filters and monotonic cursor/order. Each event has a bounded summary and scalar
metadata allowlist; unknown extra/private fields refuse. All renderer codecs
explicitly support CSP without generated code.

The server projects each ledger kind field by field. It omits opt-in verdict and
council bodies, tool inputs/commands, prompt text, internal provider request fields
and decision/control authority. Hashes, lengths, durations, recorded names and
supplied outcomes are metadata. Provider/model values are labelled as recorded
metadata; requested registry models are not substituted when absent. Missing
usage/cost remains absent, with each provider's actual cache field names retained.
An `operator.action` records an attempted operation, not confirmation of its effect.

## Design provenance

Authoritative source: `7e41bba140493849d9f9b2dd3b8ada6773e374a2`, desktop design
brief §6.13 Activity (the following §6.14 is Providers & usage). The source calls
for a time-grouped virtualized metadata feed, object filters and an inspector.

All 11 supplied nested templates were audited. The actual Activity list state
gallery is `f97e4690-089b-4441-8b07-7a6968437962`; write/Keeper outcomes are in
`ea25663d-e914-4e16-8c3d-bebe2731d3da`. A standalone board named Activity is not
present. This slice uses those supplied state treatments and existing Nocturne
tokens, and does not claim unseen-board verification or invent producer facts.
