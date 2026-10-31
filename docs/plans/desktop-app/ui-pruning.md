# What to remove from today's dashboard

Generated: 2026-10-18 · Scope: the Preact dashboard under `docs/` (`index.html`, `council.html`, `docs/js/`) and the
hearth routes it calls · Companion to [`design-brief.md`](design-brief.md)

This is a recommendation, not a change. Nothing here has been removed yet. Each item says what to remove, why, what
replaces it in the desktop app, and what has to land first so nothing breaks.

## How this was judged

Every route in `docs/js/router.ts`, every island in `docs/js/islands/`, the shell (`docs/js/ds/AppShell.tsx`), the
standalone council document, the hearth routes the pages call, the end-to-end specs in `tests/e2e/`, the committed
screenshots in `docs/images/nocturne/`, and the git history of each file. Three questions per surface:

1. **Does it operate the harness or only describe it?** A page of static reference text loses to the same text in a
   command palette or a tooltip.
2. **Does it duplicate another surface?** Two pages rendering the same table with different filters are one page.
3. **Does it exist only to work around a limitation the desktop app removes?** Copy-this-command fallbacks, snapshot
   refreshes and "needs the local dashboard" notices exist because the page might be served without a hearth. A desktop
   app always has one: it supervises the hearth as a sidecar.

## Today's UI at a glance

Eleven routes in the single-page app plus one separate document, grouped under "Work" and "Author".

| Surface | What it shows | Data source | Verdict |
|---|---|---|---|
| Dashboard | Initiative filter, 4 bead counts, 4 live counts, epic flow, In progress / Ready / Blocked / Recently closed tables | Snapshot + hearth | **Fold** into Project overview and Beads views |
| All issues | Search, status and initiative filters, the same issue table, expandable detail | Snapshot | **Fold** into Beads |
| Epics | Epic cards with progress bars | Snapshot | **Fold** into Beads › Epics |
| Workbench | Queue board: propose / approve / queue / pause / resume / reassign, "waits because" | Hearth | **Keep**, add shifts |
| Forge run | Concurrent runs, phase stepper, checkpoints with approve / request changes, quality gate | Legacy dev API + snapshot | **Keep**, move into the project, switch to `/runs` |
| Timeline | Ledger events of a bead or run, typed in by id, kind filters | Hearth | **Keep the component**, drop the page |
| Commands | Tables of slash commands, workflow tiers, skills, agents, hooks | Generated at build time | **Remove** |
| Insights | 4 KPIs, closed-per-day chart, 12-week activity calendar | Snapshot | **Fold** one card into Overview, drop the rest |
| Skill builder | Form that composes a prompt for you to copy into an agent | None | **Remove** |
| Bead builder | Create-bead form, or a `bd create` command to paste | Hearth | **Keep the form as a dialog**, remove the paste path |
| Repos & knowledge | Registered repos, knowledge YAML age, shared conventions, worktrees | Legacy dev API | **Fold** into Project settings › Workspaces |
| Council (`council.html`) | Source picker, profile, budget, seats, live review, report, history | Hearth | **Keep**, move into the app as Reviews |
| Shell chrome | "Snapshot built …" label, Refresh snapshot button, live-off banner, "Writes to check" stack | Snapshot + hearth | **Remove / replace** |

## Remove

### R1. The snapshot model, everywhere it shows

**What.** The "Snapshot built …" line and **Refresh snapshot** button in the sidebar; the "Live updates are off" banner;
the "No snapshot loaded — run `bun run build-pages`" empty states; the "from your actions on this page" overlays and the
"The row above and the issue lists are a snapshot of the tracker" note in issue detail; the dual-source logic in
`BeadCounts` (tracker counts vs snapshot counts). Behind them: `docs/js/use-snapshot-rebuilt.ts`,
`docs/js/use-shell-chrome.ts`, the `REBUILD_PATH` call in `docs/js/app.tsx`, `scripts/dashboard/rebuild-pages.ts`,
`rebuild-queue.ts`, `snapshot-events.ts`, `scripts/hearth/follow-tracker-writes.ts`, and most of the reconciliation in
`docs/js/islands/bead-writes.ts` (877 lines, 22 commits).

**Why.**
- Every bead list in the app reads `docs/data/beads.json`, a copy of the tracker built by `bun run build-pages`, and the
  hearth then works to keep that copy fresh after each write. Two sources of truth produce two answers: the counts can
  come from the tracker while the table under them comes from the snapshot, and the detail panel has to explain which is
  which. That is the most confusing copy in the product.
- The reason for the snapshot was static GitHub Pages hosting. That reason is gone: `docs/data/beads.json` is gitignored,
  and the tracker is local-only by rule (`CLAUDE.md`, "Tracker is local-only"), so a published Pages site would have no
  data, and publishing it would leak the tracker.
- It costs real maintenance. `rebuild-pages.ts` alone has 17 commits; [jupes/agent-forge-harness#239](https://github.com/jupes/agent-forge-harness/pull/239) (merged 2026-10-17) was another rebuild flake
  fix ("czqf: rebuild a .beads/ write made while the watcher arms").

**Replace with.** Live reads from the hearth, like the Workbench already does: one connection-status chip in the title
bar (connected · reconnecting · hearth stopped), and bead lists that update from `bead.transitioned` events.

**Must land first.** The hearth has no bead *list* route today: `scripts/hearth/routes/beads.ts` serves `POST /beads`,
claim, comment, close, `GET /beads/options` and `GET /beads/counts` only. Add `GET /beads` (filters, paging) and
`GET /beads/:id` (comments, deps) first, switch each view, then delete the snapshot path. This also amends
`03-target-architecture.md` §10 ("Static GitHub Pages mode keeps working read-only"); record that as a `design:` comment
and edit the section in the same PR. `bun run build-pages` can stay as a CLI export if anything outside the UI still uses
it.

### R2. The Commands page

**What.** The `commands` route, `docs/js/islands/CommandsIsland.tsx` (24 commits), and `tests/e2e/commands.spec.ts`.

**Why.** It shows static reference text: slash commands and skills generated from `.claude/` at build time, plus
hand-written tables of workflow tiers, agents and hooks. It operates nothing, has no live data, and repeats the tables in
`README.md` and `CLAUDE.md`. In the desktop app the useful part is the list of commands *while you type a prompt*.

**Replace with.** `/` autocomplete in the session composer and entries in the command palette (Ctrl/Cmd+K), both fed by
the same generated catalog. Keep `scripts/dashboard/commands-catalog.ts` and `docs/js/generated/*` as data; delete the
page.

### R3. The Skill builder

**What.** The `skill-builder` route, `docs/js/islands/SkillBuilderIsland.tsx`, `docs/js/skill-builder.mjs`, and its half
of `tests/e2e/builders.spec.ts`.

**Why.** It is a form whose only output is a prompt you copy and paste into an agent. The desktop app *has* the agent:
the same fields belong in the composer, sent straight to the provider you pick. A copy-paste shim around a capability
that is becoming first-class is pure overhead.

**Replace with.** A "New skill" prompt template in the session composer (same fields, pre-filled prompt, sent to the
chosen provider), or a one-line request to the Forge Keeper. The `authoring-agent-skills` skill already holds the steps.

### R4. The bead builder's copy-a-command path

**What.** "Copy the command below" / "Paste it into a terminal" in `BeadBuilderIsland.tsx` and `docs/js/bead-builder.mjs`.

**Why.** The hearth's write path (`POST /beads`) exists and is audited; the plan already says the bead builder "stops
copying commands" (`x1gs.3.3`). Pasting a command into a terminal also skips the ledger.

**Keep.** The form itself, as a **New bead** dialog reachable from the project, the Beads view, the command palette and
a Forge Keeper action card. It does not need its own page or an "Author" nav section.

### R5. The separate council document

**What.** `docs/council.html`, `docs/js/council.tsx`, `docs/js/StandalonePage.tsx`, the `STANDALONE` nav list and
`fromDocument` link rewriting in `AppShell.tsx`, and the duplicate `/council-api/runs` and `/council-api/runs/:id/cancel`
route aliases in `scripts/hearth/routes/operator.ts` (they repeat `/council/runs`).

**Why.** A second HTML document with its own boot path and special-case navigation, for a page that is now one action
among many. A desktop window is one app.

**Keep.** All of the council islands (setup, seats, discussion, result, history). They become the **Reviews** view
inside each project, plus the **Send to council** action on beads, checkpoints, queue cards and sessions.

### R6. Legacy and dead routing code

**What.** `LEGACY_VIEWS` and `legacyRedirectFor` in `docs/js/router.ts` and `tests/e2e/legacy-links.spec.ts` (they
redirect pre-hash-router `?view=` bookmarks); the `devOnly` route flag, which is declared on four routes and read
nowhere; the five "needs the local dashboard" empty states (Repos, Forge run, Workbench, Timeline, Council).

**Why.** Bookmarks from before the hash router do not exist inside a desktop app, which has its own deep links
(`agent-forge://…`). `devOnly` is dead code. "Needs the local dashboard" cannot happen when the app supervises the
hearth. A hearth that has stopped is one app-level state, not five page-level ones.

## Fold

### F1. Dashboard + All issues + Epics → one Beads view

All three render the same `IssueTable` with different filters, and the initiative selector is repeated on four pages
(Dashboard, All issues, Epics, Insights). Make one **Beads** view per project with saved views as tabs (Ready,
In progress, Blocked, Recently closed, All, Epics), detail in a **side panel** instead of an inline expanded row (the
row-expand pattern breaks the table and cannot hold actions, comments and activity at once), and an epic filter chip
in place of the initiative dropdown. The project replaces the initiative as the main scope. The Dashboard's stat rows
move to the Project overview. The Epic flow's "Connections" list (`a → b (blocks)` as text) becomes a small dependency
graph in epic detail.

### F2. Insights → one Throughput card on the Project overview

Four KPIs and two charts are thin for a whole page, and the data is a proxy: closed beads are bucketed by `updatedAt`
(the page says so), so a late comment on a closed bead moves its close date. Keep "closed per day" as one card on the
overview and per-smith outcomes on the Smiths page (the hearth's `GET /scoreboard`). Drop the 12-week activity
calendar, the only user of the `chartjs-chart-matrix` dependency. Better still, add a real `closedAt` to the bead read
route so the chart is not a proxy.

### F3. Repos & knowledge → Project settings › Workspaces

Registered repos, knowledge YAML freshness and worktrees describe the project's setup, so they belong in its settings,
not in a top-level "Author" section. Worktrees also appear where they matter: on each session (its worktree and branch)
and on shift runs. The "Shared conventions" table (from `knowledge/_shared.yaml`) is reference text: show it read-only
under Settings › Knowledge or drop it. Switch the page from the legacy dev API (`/__agent-forge/dev-api/repos-knowledge`)
to the operator API (`GET /worktrees` exists already; add repos and knowledge reads beside it).

### F4. Timeline page → Activity tab on everything

The Timeline makes you type a bead id or run slug into a form. Nobody should type ids. Keep the component and put it
where the context already is: an **Activity** tab in bead, run, session and shift detail, plus a project-wide feed. Deep
links keep working.

### F5. Forge run → Runs inside the project

Keep the page's content (run list, phase stepper with artifact links, checkpoints with approve / request changes,
quality-gate results). Read it from the operator routes (`GET /runs`, `GET /runs/:slug`) instead of the legacy dev API
(`/__agent-forge/dev-api/forge-run`), and read checkpoints from live beads instead of the snapshot. Once Forge run and
Repos have moved, `scripts/hearth/routes/dev-api.ts` (421 lines) can go.

### F6. Page-top notices → one notification center

"Writes to check" (`PendingWrites.tsx`) stacks unresolved bead writes at the top of every page, and the live banner adds
another line. Keep the semantics (a write whose outcome is unknown must be shown until it is dismissed), but put it in
a notification center with a toast when something arrives, alongside gate failures, halts, council verdicts and beads
awaiting approval.

## Keep and promote

- **Workbench.** The approval queue board is the heart of the command center. Promote it into each project and add the
  missing shift controls (below).
- **Issue detail content and actions.** Claim, comment and close; Send to council; the timeline link; acceptance
  criteria; dependencies; work branches from comments. All of it moves into the side panel.
- **Council setup, live progress, result and history.**
- **Nocturne.** The token sheet (`docs/js/ds/tokens.css`) and primitives are sound. They need a light theme, chat and
  terminal components, and a provider color set, not a replacement.

## In the API but not in the UI: design these, don't cut them

The hearth already serves these, and no page uses them:

| Capability | Route | Becomes |
|---|---|---|
| Sessions across providers | `GET /sessions` (folded into the stream, shown today only as an "Open sessions" count) | Sessions list and session view |
| Shifts | `GET /shifts`, `POST /shifts`, `POST /shifts/:id/stop`, `POST /shifts/:id/recover` | Shift panel on the Workbench, start-shift dialog |
| Scoreboard | `GET /scoreboard` | Smiths page and project overview |
| Smiths, benches and config with provenance | `GET /smiths`, `GET /config` | Smiths page, Settings |
| Reservations and eligibility | `GET /reservations`, `GET /eligibility` | Conflict badges on Workbench cards (eligibility is used today; reservations are not shown directly) |
| Worktrees | `GET /worktrees` | Project settings › Workspaces, session headers |

## Order of work

1. Add `GET /beads` and `GET /beads/:id` to the hearth (R1's prerequisite), plus `closedAt` (F2).
2. Move Forge run and Repos to operator routes (F3, F5); delete `dev-api.ts`.
3. Switch the bead views to live reads; delete the snapshot path and its tests (R1), and amend §10 of the architecture.
4. Merge the views (F1, F2, F4), fold council into the app (R5), and add the notification center (F6).
5. Delete Commands and Skill builder (R2, R3), the bead builder's paste path (R4) and the legacy routing (R6).
6. Build the missing screens from the API table above; that is where the desktop design starts.

Steps 1–3 are worth doing even if the desktop app slips: they remove the biggest source of confusing UI copy and
flaky tests in the dashboard today.

## Suggested beads

The tracker is local-only, so these were not filed from this session. File them with `/add-bead` or `bd create` (no
`--repo`), under the command-center epic:

- `[command-center] Hearth bead read routes: GET /beads and GET /beads/:id with closedAt` (P2)
- `[command-center] Retire the dashboard snapshot path; bead views read the hearth live` (P2, blocked by the routes)
- `[command-center] Move Forge run and Repos to operator routes; delete the legacy dev API` (P2)
- `[command-center] One Beads view with saved views and a side-panel detail` (P2)
- `[command-center] Council inside the app; drop council.html and the /council-api aliases` (P3)
- `[command-center] Remove Commands and Skill builder pages; feed the catalog to the palette and composer` (P3)
- `[command-center] Remove legacy ?view= redirects, the unused devOnly flag and local-dashboard notices` (P4)
