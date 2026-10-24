# Project storage and scope

Producer contract for `agent-forge-harness-cla5.2.1.1` (Persist project records
and enforce explicit bead scope). Full home rendering remains
`agent-forge-harness-cla5.2.1` (Open and switch scoped projects from home).

## Recorded decision

The settled source is commit `7e41bba`,
`docs/plans/command-center/05-decisions.md`, item 20, and the desktop handoff,
section 6: a project is a hearth-level object above workspaces, stored in the
private hearth home; bead membership uses both an epic and a `project:<slug>`
label; Projects home uses option A. Older packets reference `7035fd8`, which
predates that register. On 2026-10-21 the owner also authorized a file if no more
specific contract was recovered. The register leaves filename, schema and id
format unspecified; the following details implement it.

## Public types and persistence

`types/projects.ts` exports `ProjectRecord`, `ProjectWorkspace`, `ProjectCatalog`,
`NewProject` and `ProjectPreferences`.

One machine catalog lives at `<home>/projects/catalog.json`. The home is
`AGENT_FORGE_HOME`, otherwise `~/.agent-forge`.

```ts
interface ProjectCatalog {
  version: 1;
  revision: number;
  projects: ProjectRecord[];
}
```

Each record has a generated immutable `project-<UUID v4>` id, an immutable unique
lowercase ASCII slug (1–48 characters, alphanumeric segments separated by
hyphens), name, description, icon text, pin/archive flags and ISO creation/update
times. Selection uses the id; the exact membership label is `project:<slug>`.
Changing the display name must change neither. No credentials or transcript
bodies belong here.

Each workspace entry has the canonical ledger `root`, canonical repository
paths and explicit selected `epicIds`. Creation normalizes explicitly supplied
checkout paths with `resolveCheckout`, including linked worktrees. Catalog reads
never traverse those stored paths. A project can span repositories and
workspaces; it is not an epic.

Limits: 100 records, 16 workspaces per record, 32 repositories and 64 selected
epics per workspace. The whole UTF-8 file is capped at 65,536 bytes by both the
guarded reader and writer. These are bounded local-storage limits.

`scripts/projects/store.ts` exports:

```ts
createProjectStore(home, now?)
  .read(): ProjectCatalog
  .create(input: NewProject, expectedRevision: number): Promise<ProjectCatalog>
  .preferences(id, expectedRevision, patch): Promise<ProjectCatalog>

projectCatalogPath(home): string
parseProjectCatalog(value: unknown): ProjectCatalog
isProjectId(value: unknown): value is string
```

`create` is a trusted producer seam for later onboarding. This checkpoint has
no creation HTTP route, tracker writes, label creation, repository scan/clone,
Keeper launch or provider execution.

Reads use `readHomeFile`; writes use the existing atomic owner-only replacement
`writeOwnerOnly`. Missing means first-run empty. Unreadable, malformed, oversized,
duplicate-id/slug or future-version files fail the whole read and cannot be
replaced by a preference write. No record is silently discarded.

Writers use the existing cross-process `withQueueLock` at
`projects/write.lock.db`, with a one-second acquisition bound. That SQLite file
is only the existing process-lock mechanism; records stay in JSON. While holding
the lock, each write compares the revision and increments it once. Old revisions
conflict instead of overwriting another window. A crashed process releases the
lock through the operating system; there is no stale lock to steal.

## Hearth routes

Rows in `scripts/hearth/routes/projects.ts`, mounted by `operatorRoutes`:

- `GET /__agent-forge/projects`: the catalog in `{ok,data,error}`, no query
  parameters. It grants no filesystem access to stored paths.
- `POST /__agent-forge/projects/:id/preferences` with
  `{revision, pinned?: boolean, archived?: boolean}`. At least one preference
  is required; extra body/query fields are refused.

The existing runner enforces same-origin, current token, body and validation,
then appends `operator.action` (`project.preferences`, target project id) before
the effect. Success returns the confirmed new catalog. Store conflicts are 409,
missing projects 404, invalid input 400, unavailable catalogs/locks 503. Lost or
unexpected write answers follow the existing unknown-outcome rules: read and
check before offering another action, never replay automatically.

The catalog is not a new stream/snapshot collection. Home should use the existing
bounded operator read, refetch on project-preference `operator.action` events and
after confirmed local writes. A hearth still serves one workspace. Another
workspace's catalog change is visible at the next read; cross-workspace event
broadcast is not implemented.

## Scope selector

`scripts/projects/scope.ts` exports
`selectProjectBeads(project, canonicalWorkspace, issues): BeadsIssue[]`.
The caller must supply normalized rows from **only that workspace's tracker**;
never combine untagged rows from different trackers.

1. Require the project's matching workspace entry. Canonical Windows drive
   paths compare without case; POSIX paths retain case.
2. Start at the selected actual epic rows and follow explicit `parent` edges.
   Dotted ids and shared prefixes never establish ancestry.
3. Keep only rows with the exact `project:<slug>` label, including the selected
   epic itself. An unlabeled intermediate parent establishes ancestry but is
   not included as a project bead.
4. Deduplicate ids across overlapping selected epics. Conflicting duplicate
   rows are excluded along with their unsupported ancestry. Missing parents
   and unreachable cycles grant no membership.

Repository paths describe grouped checkouts, not an alternative bead selector.
This also supports central-tracker sub-repo beads. There is no label-only,
all-repository or inferred project-equals-epic fallback. Onboarding must verify
actual epic ids and show the scope count before saving.

Later summaries must scope sessions, queue entries and runs through actual
member bead ids plus the named workspace, or an explicit project id supplied
by a later producer. Unbound sessions/runs must not appear in every project.
A partial tracker export or missing selected epic must be reported as partial
or unavailable by the summary producer; an empty selector result alone does
not prove that the project contains zero beads.
A workspace this hearth does not serve is unavailable, never zero. Do not scan
stored paths or spawn another workspace's tracker from a route parameter.
Multi-workspace hearth serving remains its own existing task.

## Fixtures and verification

`scripts/projects/testing.ts` exports `projectFixture(workspace, overrides?)`,
`projectCatalogFixture(workspace)` and `FIXTURE_PROJECT_ID` for private test homes.
Production ids are always generated.

Focused tests: `scripts/projects/store.test.ts`, `scope.test.ts`,
`scripts/hearth/routes/projects.test.ts`, plus the table-wide action/read fixtures
in `scripts/hearth/api.test.ts`. They cover durable preferences, conflicting
writers, damaged/future catalogs, disjoint projects, multiple repositories,
explicit ancestry, labels, duplicates, missing parents/cycles, and the shared
origin/token/validation/audit ordering.

The packaged Windows smoke seeds a private fixture catalog, reads it through
the compiled hearth and confirms a pin write with a separate read. Its
`projectCatalogTested` result proves that backend path in Tauri/WebView2.
`projectHomeTested` additionally checks the rendered persisted preference and
opens the card into its own project scope.

## Home summaries and navigation

`GET /__agent-forge/projects/summary` returns `ProjectsHome` from
`types/project-summary.ts`: the catalog, read timestamp, and summaries keyed
by stable project id. The route takes no parameters. It never opens a path
from a stored project record. One bounded, coalesced readonly tracker export
feeds the normalized scope selector and queue metadata. Malformed or incomplete
exports and missing selected epics cannot produce complete totals.

`summarizeProject(project, sources)` in `scripts/projects/summary.ts` selects
membership before counting. Bead counts reuse the dashboard dependency rules;
queue counts require backing queue metadata and deduplicate bead ids. The
needs-you preview contains proposed, review and halted queue entries, not
assumed permission requests. Sessions must name a member bead and the served
workspace. They are ledger observations, not proof of process liveness. The
500-row ledger bound is explicit through `sessionsComplete`.

Run observations come from the existing checkout-local run store. A run must
name a member epic and cannot claim another checkout. These observations do
not establish that every worktree was searched. Missing Keeper briefs, spend,
unread totals and provider allowances remain unavailable until their owning
producers exist. No hard-coded sample cards or usage meters enter production.

The app keeps one summary read at its root, follows relevant events on the
existing stream, and refreshes after a confirmed preference write. Failed
refreshes retain labelled last-known data and expose the error. The new
`useOperatorRead` refresh-error option is opt-in; existing dashboard views keep
their previous behavior. Pin/archive controls hold while a write or its
verification is in flight. An unknown outcome stays held across navigation
until the operator explicitly checks against the hearth; it is never replayed.
Catalog revisions prevent an older read from replacing a confirmed preference.

`openProject(id, destination)` in `apps/desktop/src/projects-model.ts` always
clears prior object selection. Cards sort by pin, known needs-you items, last
activity, then name/id. Archive filtering and search do not change identity.
Archiving returns focus to the filter. The selected frame name is taken only
from the catalog record matching the route id. Missing ids stay unavailable.

`bun run verify:desktop` runs the desktop renderer against the existing E2E
suite's isolated hearth, recording tracker stand-in and launch/session flow.
It is a separate Playwright config so dashboard-mode tests retain their own
document. CI runs this suite alongside the dashboard shards. These browser
and native checks do not replace the owner's Windows human review.
