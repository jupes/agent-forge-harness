# Agent Forge 1.0 monitoring release candidate

**Status:** monitoring scope candidate. Automated acceptance does not replace the human Windows release review.

## Included

- Foreground project Overview reads with source freshness, scoped counts, partial `Needs you` and connection/read-failure status.
- Project Sessions metadata for owned, observed and managed Shift sessions, within the existing ownership and workspace boundaries.
- Runs inspection for recorded phases, gate history and verified artifacts, alongside the existing explicitly confirmed checkpoint-review control.
- Activity event metadata, scoped to the selected project and its recorded membership.
- Shared connection and source-freshness states. A failed refresh may retain previously verified data with an explicit stale/read-failed message.

Open these views from a project in the desktop app. The candidate browser journey is `tests/desktop-e2e/monitoring-release.spec.ts`. Supporting acceptance remains in `project-views.spec.ts`, `sessions.spec.ts`, `observed-sessions.spec.ts`, `tests/desktop-shift-e2e/managed-sessions.spec.ts`, `runs.spec.ts` and `activity.spec.ts`. Run the complete desktop suite with `bun run verify:desktop`.

The release journey reads the protected Overview, Sessions, Runs and Activity routes using isolated Alpha/Beta fixtures, including one recorded run scoped to each project. Alpha's Run detail contains one completed research artifact and an active phase; it records no gate event, start time, Full/Mini route or session correlation. The test expects those missing facts to remain unreported and asserts that monitoring sends no protected writes or provider dispatches.

## Limits shown to operators

- `Needs you` is a partial queue summary. Permission requests and run checkpoints are not included in it.
- An observed session does not establish that a process is currently running or idle. Session transcripts and private message bodies are not Activity metadata.
- Runs cover the served checkout. This monitor does not launch a run or infer Full/Mini, start time, route or session correlation from a slug, timestamp, process or bead.
- Gate history is bounded to retained log dates and entries; gaps and older records may be absent. Missing history is not a passing gate.
- A foreground status banner is not a background alert or tray notification.

## Deferred beyond 1.0

New Run preparation and other unfinished launch/convenience work, broad Inbox actions, the command palette, project/app settings, themes, pop-out and deep-link handling remain post-1.0. Tray and background notifications remain a release-scope decision; this candidate includes no tray-acceptance evidence.

Automated desktop/browser evidence is separate from packaged Windows smoke and the required human Windows shell/release checkpoint. Do not tag or publish a stable release from this document alone.
