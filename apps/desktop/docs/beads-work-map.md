# Beads work map

Open a project, choose **Beads**, then **Tree** or **Dependency graph** beside
the existing List presentation. Status tabs and search/type/priority/queue/epic
filters apply to every presentation; switching presentation preserves them.
Choose **All** to start with the whole scoped project.

The tree shows real parent relationships, status, queue state and closed/total
**descendants**, including descendants hidden by filters. Expand/collapse individual
branches or all branches. Keyboard: Up/Down, Home/End, Right to expand or enter
a branch, Left to collapse or reach its parent, Enter to inspect. **Open** links
reach the existing full bead page. Indentation stops growing on very deep trees;
the actual level remains available to assistive technology and is labelled.

Dependency arrows point **from prerequisite to dependent work**. Solid arrows are
`blocks`, dashed arrows are `requires`, dotted lines are non-blocking `relates`.
Amber identifies cycles. Search retains directly connected context so blockers
do not disappear; the outline includes those context beads and their ancestors.
Context is labelled and is not counted as a filter match. Use zoom, Fit, Reset,
scrollbars, dragging, or the four pan buttons. Every graph node is a keyboard
button with its status/context description. The equivalent expandable outline
provides native controls and actual relationship links without relying on SVG.

Click a node to inspect it; double-click or use an Open link for its full page.
The map, zoom and disclosures stay mounted while the same project's selected
bead details load. Project changes still clear the previous project's read.
Use the bead's **Activity** tab for actual recorded work observations.

## Data and limits

This is a live **tracker** view. It works without starting Forge runs, Shifts,
provider sessions or Keeper generation. Closed counts are tracker status counts,
not estimates of time, money or automatic execution completion. No execution
timeline, attempt count or cost is invented for manual/external work.

The existing project membership rule remains unchanged: a bead must descend from
a saved project epic and carry `project:<project-slug>`. Foreign IDs/relationships
are not exposed. If a graph is empty, check the project's epic selection and
matching labels; running Forge will not populate missing membership. The view
does not add labels or modify Beads.

The page shows the tracker read time and existing source problems. Partial reads,
failed refreshes with retained data, unavailable prerequisites, filtered links,
and diagram limits have separate labels. Hierarchy cycles are broken only for
navigation; every bead remains represented and the cycle is labelled.

The scoped API supports 1,000 beads and 10,000 relationships. To keep the diagram
usable, layout pauses above 300 displayed beads or 2,000 displayed links. Narrow
the filters, or use the automatically opened outline, which retains the full
filtered read and connected context. Progress always uses the full scoped data.

## Run locally on Windows

The fastest route in an already installed checkout is the desktop renderer in
your browser. Use **Bun 1.4.2**, the version pinned in the Quality workflow:

Live Beads also requires `bd` on PATH (`bd --version`) and an initialized local
tracker in the selected checkout. Native packaging bundles its Bun runtime,
but does not bundle the Beads CLI or your tracker data. If your terminal has an
older Bun, prepend the chosen 1.4.2 directory to that terminal's PATH before
starting the app, so its child hearth processes find the same version; no
system-wide PATH change is needed.

```powershell
# From the repository root, with Bun 1.4.2 on PATH:
bun --version
bun run dashboard --mode desktop
```

Open the **fresh launch link printed by the command**, not a saved bare URL.
The launch establishes the local dashboard session. If it expires, run
`bun run dashboard:open` in another terminal and use that newly printed link.
Do not share launch links. Stop the dev server with Ctrl+C when finished.

For a fresh source checkout:

```powershell
git clone https://github.com/jupes/agent-forge-harness.git agent-forge-local
Set-Location agent-forge-local
bun install --frozen-lockfile
```

A fresh clone contains code, not this machine's local-only tracker or saved
project catalog. To browse your existing work, use your existing checkout as
the native app's `--root` below. Install dependencies only in a standalone
checkout or a worktree with its own dependencies, never over another worktree's
shared dependency junction.

For the native Windows app, the build prerequisites are Bun 1.4.2, the validated
Rust 1.99.1 toolchain, Visual Studio C++ Build Tools with MSVC/Windows SDK, and the
WebView2 Runtime. See [the desktop build guide](../README.md). Build without
launching any tests, then launch when you are ready:

```powershell
bun run desktop:build
& '.\apps\desktop\build\windows-x64\agent-forge-desktop.exe' --root 'C:\path\to\your\existing\agent-forge-harness'
```

Keep the complete staged `windows-x64` folder together: the executable needs its
dashboard and sidecars. Rebuild after updating source; an older executable does
not contain the new work map. The staged Release folder is not an installer.

## Manual smoke check

1. Open a project with scoped Beads, choose **All**, then **Tree**. Check an epic's
   descendants and closed count against the tracker. Expand/collapse a feature.
2. Use the arrow keys and Enter to inspect a bead, then Open for its full details.
3. Choose **Dependency graph**. Follow an arrow from a prerequisite to the work it
   blocks. Check any known cycle and unavailable-prerequisite labels.
4. Search for one task. Check its context beads, zoom/pan/Fit, select a node, and
   confirm the view stays in place while details load. Inspect relationships in
   the equivalent outline.
5. Refresh after changing a test bead in your normal tracker workflow. Confirm
   the displayed read time/status changes. Check an empty filter and another
   project; data must not carry across projects.
6. Resize to 1100×700. Controls should wrap and graph scrolling should stay inside
   the diagram. For large projects, verify the explicit diagram limit and outline.

Focused headless regression check (no windows or providers):

```powershell
bun test ./scripts/desktop/beads-work-map.test.ts ./scripts/desktop/beads-model.test.ts --timeout 15000
bun run typecheck
bun run lint
```

Hosted browser CI runs the controlled visualization journeys and uploads
`beads-work-map-*` screenshot artifacts. Local browser/native automation remains
deferred to the user-led bug bash; none is required to browse this feature.
