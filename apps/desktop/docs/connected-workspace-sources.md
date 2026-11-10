# Complete own-workspace tracker source

> Current release boundary: Foreign Source authorization, live multi-workspace previews and Scope editing are deferred to 1.1 and absent from the production 1.0 route table. Saved Scope is read-only. The local complete-tracker producer described below remains in production for core project work, with historical native qualification holds unchanged.

The production Hearth now reads its own initialized tracker through a fixed,
supervised helper. This implements the local producer prerequisite for connected
workspace sources. It does **not** grant another workspace, aggregate foreign
workspaces or complete the Project Settings Scope milestone.

The helper uses Bun's pinned MySQL driver directly, never `bd sql`: the installed
Beads CLI can run version tracking and migrations before a readonly command. No
tracker initialization, server startup, configuration write, migration, fallback
export or retry is part of this reader.

## Supported source and identity

The trusted Hearth composition supplies its own tracker root (`localStateRoot`),
never a renderer/catalog/repository path. The reader captures initialized Dolt
server metadata, project UUID, database, local port and exact config bytes. This
first producer supports an already-running loopback server using the default
anonymous root connection. Redirects, environment files, unsupported routing,
credentials, sockets and remote/TLS configurations refuse rather than guessing.
A missing port/descriptor is unavailable. An observed registration replacement
retires the reader; restoring old bytes cannot revive it. Restart/regrant is
required. No private descriptor, SQL or process error is returned to the UI.

A single fixed statement includes issues, wisps, labels, wisp_labels, dependencies
and wisp_dependencies. Its manifest includes the database and actual
`metadata._project_id`, plus exact counts for all six tables. The parser rejects
missing/extra/duplicate/malformed parts, mixed identities, absent targets,
conflicting parents and unsupported fields. A complete zero manifest is distinct
from missing output. Existing project-label AND epic-ancestry semantics remain.

Full description, acceptance criteria, notes, timestamps and supported display
fields are retained. Queue metadata projects only queue_state, queue_resume and
smith. Empty assignment/AC fields retain existing export semantics. Comments are
a bounded embedded fallback from the same view: at most100 comments/64KiB text
per issue, each body at most16KiB. Otherwise the known count accompanies an empty
fallback. The existing protected selected-bead comment read remains authoritative;
unavailable comments never suppress Scope membership or become a claimed complete
comment history.

## Bounds and process ownership

The statement bounds serialized output before result materialization; the parent
also caps receiving output at16MiB. Max100,000 issues,400,000 labels and200,000
dependencies are supported, never partial totals. Source mode disables dotenv,
preloads and auto-install with fixed runtime flags/config. The packaged Hearth
is compiled with dotenv/bunfig autoload disabled and dispatches the same handler.
The child receives a minimal environment and fixed command/root/fingerprint.
The source command binds its config as a single `--config=<fixed path>` argument.
Pinned Bun1.4.2 declares this flag optional; its parser consumes an optional value
only from the same token's equals suffix. A separate config path is positional
and can displace the intended helper. See the pinned
[flag declaration](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/cli/Arguments.rs#L88)
and [optional-value parser](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/clap/streaming.rs#L107-L138).


The helper has a five-second hard process lifetime, including native driver
teardown. The parent has a six-second kill deadline and accepts output only after
successful actual process exit and a fresh descriptor check. A failed/timed-out
child, held teardown, partial output or lost registration cannot publish. No
in-process reserve/callback lifecycle claims from the older Source experiment
are reused. Coalesced reads share the pending child until it finishes.

Pinned Bun1.4.2 decodes DATETIME with UTC arithmetic in
[MySQLValue.rs](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/sql_jsc/mysql/MySQLValue.rs#L556).
The actual entry validates finite driver Dates before JSON serialization, so an
invalid due date cannot turn into a plausible null. Snapshot `asOf` is local read
receipt time, not a tracker freshness guarantee.

## Consumers and evidence

The same strict producer backs served project summaries, create/Settings Scope
preview, board/workbench/Activity membership, cleanup review/owner membership and
attended-shift scope checks. Production has no legacy export fallback. Only the
isolated test layer translates its closed-world legacy row fixtures into explicit
complete six-table simulations; malformed fixture data remains a refusal.

Focused headless tests cover actual parser/entry/reader composition, protected
served full/zero/partial controls, queue/content compatibility and affected
consumers. The packaged dispatcher is compile-checked without execution. Actual
native process/database delivery, foreign native consent and Windows UI are
**NOT-RUN** for the later manual bug bash. All historical Source qualification
holds, failed evidence, old units/budgets and unrelated work remain preserved.
One separate hidden, bounded read-only producer-core diagnostic exited with no
stdout or stderr and was retained as a failed attempt, without retry. It does
not establish that the producer ran. The flag correction above is grounded in
pinned parser source; it does not prove the silent-exit cause, actual SQL or
packaged dispatch, or resolve the held compiled-attended/native qualification.


## Running workspace read grants

The receiving Hearth now has protected, audited Source authorization and revocation routes. The desktop native host supplies a distinct `--authorize-project-source` folder dialog. Consent is explicit for an opaque registered workspace reference; renderer-supplied roots, ports, tokens, commands and SQL are refused. Grants live only in the receiving process. Listing registered workspaces performs no foreign discovery or reads.

After consent, the connector reads only the two supported canonical spellings of that approved root's private-home lock, verifies its token, live PID, health/API, directory identity, runtime nonce and actual tracker UUID, and rechecks them around each bounded preview. It never starts or reconnects a source automatically. A missing registration, observed replacement, revocation or shutdown retires authority; restoring old bytes cannot revive it. Exact authorization originals can be read without reopening the native dialog. Capacity is bounded and retained originals are never evicted to admit new requests.

The source computes the canonical project-label AND epic-ancestry membership proof locally from the same complete tracker producer; remote consumers receive only count/hash, freshness and bounded epic choices. Private issue bodies remain in the source. The all-workspace Settings editor is the next consumer slice.

Verification: 13 focused tests / 103 assertions exercise complete-source stand-ins, real protected HTTP/direct-loopback delivery, audit before consent, zero unauthorized chooser/source effects, token replacement, revocation and late-read refusal. Offline Rust `cargo check --locked --tests` compiles the real native dispatcher, but executes no native binaries. Actual native chooser, real SQL delivery and manual Source qualification remain NOT-RUN. All historical Source/Scope holds and failed evidence remain unchanged.

## Editing all-workspace Scope

Project Settings now lists every registered workspace separately. Refresh Scope sources, explicitly authorize each foreign running Hearth, and load its epic choices. Select at least one current epic per workspace, then use **Preview all workspace selections**. Each successful preview shows its count, membership hash and observation time. A missing/unavailable/revoked source, stale selection or duplicate tracker identity leaves the aggregate **Unknown** and disables Save.

**Save Scope** rechecks every selected source under the catalog writer lock and changes only current epic selections. The last synchronous authority check runs immediately before the catalog write. Creation originals and exact creation replay remain immutable; roots, repositories and slug stay bound to the original creation identity. These separate tracker reads are fresh observations, not an atomic cross-workspace snapshot.

Uncertain authorization and Save requests retain their exact UUID in browser session storage. **Check exact action result** only reads that original and never opens another native dialog or repeats Save. Read-only recovery remains available for an archived project. Revocation retries name the exact old grant so they cannot revoke a newer grant. After a receiving Hearth restart, reviewing current Scope does not confirm the old request: the UI explicitly keeps its original delivery unknown and requires fresh consent/review before a new change.

Focused verification includes real protected HTTP through two explicit complete-source fixtures, actual catalog persistence and original recovery; partial, duplicate, stale, unavailable, revoked and held-read cases; creation/General/Scope/reopen/exact-replay history; unknown results across remount/restart and archived read-only recovery. Browser and packaged Hearth import graphs compile without execution. Keyboard/screen-reader/mobile/native SQL/chooser acceptance remains deferred to the manual bug bash; no prior native failure or qualification hold has been replaced by fixture evidence.
