# Complete own-workspace tracker source

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
