# Agent Forge full 1.0 release guide

Evidence snapshot: 2026-11-11, accepted source baseline
`3266b533ae993aeddcd28355faa71b93442fffe5` (PR497). This is a release preparation
guide. Full 1.0 is **incomplete** and human Windows acceptance is **open**.
Beads remains the status authority; a closed implementation child does not
close its native, integration or human parent. This source snapshot is not a
sealed full-featured candidate or an all-green postmerge result.

## Scope and authority

The owner restored the full release after the historical monitoring cut.
The current release retains foreground Settings, saved Scope read-only,
Activity and Inbox, app-wide Settings, palette, native restart/cleanup,
session pop-outs, light appearance, deep links and five complete journeys.

The approved 1.1 cuts are foreign-workspace Source authorization and Scope
editing, OS notifications, notification master/quiet-hours controls and tray
keep-alive. Provider expansion and permission decisions also remain deferred;
read-only permission Inbox is required for 1.0. Langfuse remains a post-1.1 spike.
Other app-wide Settings requirements were not deferred with notifications.

Traceability to the preserved local tracker records:

| Decision | Authoritative record |
|---|---|
| Full release replaces monitoring-only completion | `cla5.111` comment `01a1b2b9-f393-77f3-baef-ca44fbf25684`, 2026-11-06T21:18:13Z; current owner continuation |
| Foreground, saved read-only Scope and notification/tray cut | `cla5.7.9.15` comment `01a1c25d-23db-7299-b8e3-1aa959df30ec`, 2026-11-09T22:10:46Z; merged PR475 |
| Provider/permission decision deferral; read-only Inbox remains | `cla5` comment `01a1a33b-ede0-7e5e-ba78-247b5d100d39`, 2026-11-03T21:06:16Z, restated by the current owner |
| Remaining app Settings stays required | `cla5.8.1` comment `01a1c25d-2e34-7780-837d-94a4b592c5f3`, 2026-11-09T22:10:49Z |
| Current journey/evidence owner | `cla5.111.1`; original `cla5.7.10` AC and dependency edges remain unchanged |

Bead ids above and below use the repository prefix `agent-forge-harness-`.
[Monitoring-only guidance](monitoring-1.0.md) and the old shell/frame
demonstration are historical evidence, not the present completion boundary.

## Build, package and first launch

The current build target is Windows x64. Building requires Bun 1.4.2, the
validated Rust 1.99.1 toolchain, Visual Studio C++ Build Tools/MSVC and the
Windows SDK. Running the staged app requires Windows and WebView2, plus a valid
Agent Forge checkout; Bun and Node are not required on its runtime PATH.
These are shell-launch prerequisites, not proof that every workflow is ready.
Actual Git/worktree operations and tracker writes require their existing Git
and Beads tools. Claude/Codex sessions require installed, authenticated supported
vendor CLIs. These tools and capabilities are separately probed; they are not
bundled or established by opening the app. A version response alone does not
prove authentication. macOS is not qualified by these Windows receipts.

From an isolated checkout of the reviewed source:

```powershell
bun install --frozen-lockfile
bun run desktop:build
```

The build replaces that checkout's `apps/desktop/build/windows-x64` stage.
Preserve any earlier frozen candidate before rebuilding. The current command
produces a portable Release folder, not an installer. Keep its dashboard,
desktop-host and Hearth sidecars together. Installer delivery and Windows
installer acceptance remain open; a portable ZIP is not evidence of them.

A separate frozen installer review kit exists for source `f4757f3d`:
`agent-forge-installer-f4757f3d-windows-x64.zip`, SHA-256
`A4FE953EEE00C5903813344749E816A9B61C6317D673777519A9DF83631A5F10`.
That hash establishes only the retained kit's identity. Its immutable freeze
labels and failed qualification evidence remain intact. It excludes PR492 and
later source, including the nightly backup scheduler, manual compaction,
update check, startup controls, environment controls and palette timing fix.
It does not qualify installation, uninstallation, actual logon, native lifecycle,
notices/legal completeness or human acceptance. Installer/archive attempt
budgets remain consumed; this guide authorizes no rebuild or helper replay.

Open `agent-forge-desktop.exe` to choose a checkout, or supply one explicitly:

```powershell
.\apps\desktop\build\windows-x64\agent-forge-desktop.exe --root "C:\path\to\agent-forge-harness"
```

The app starts and supervises its own host/Hearth. An invalid explicit root is
refused; cancelling the chooser exits. A startup failure offers explicit
Retry/Cancel. Do not start another Hearth to hide a failed owned launch.
Core project work needs the existing initialized local Beads/Dolt source.
The complete-tracker reader does not initialize, migrate, start, reconfigure,
pull or push that service. An unavailable source remains unavailable.

State uses `AGENT_FORGE_HOME`, otherwise the OS user's `~/.agent-forge`.
Protected state requires owner-only files; on Windows use an ACL-capable
filesystem such as NTFS. Do not copy tokens, session keys, private transcripts
or raw diagnostic homes into a release packet or issue.

The distribution must retain the exact repository `LICENSE`, `NOTICE`,
`.claude/skills/ATTRIBUTION.md` and `docs/fonts/LICENSE-Inter.txt`, with
`DISTRIBUTION-NOTICES.txt`. [The desktop README](../README.md) owns the build
commands; [the notices producer](../../../scripts/distribution/notices.ts)
owns their required contents.

## Settings and supported workflows

Project Settings includes General, repositories, Keeper, defaults, budgets,
archive/delete, knowledge and guarded cleanup. Saves use current revisions and
confirmed outcomes. Saved workspace/epic Scope is read-only in 1.0: there is no
foreign Source chooser, live multi-workspace preview, authorization/revoke
control or Scope Save in the production route table. Historical grant/revoke
and Scope experiments retain their own holds for 1.1; they are not a current
setup step. See [Settings integration](project-settings-integration.md) and
[the local complete-source boundary](connected-workspace-sources.md).

App Settings has persisted Dark/Light/System appearance and
Compact/Comfortable density. The palette's Settings and Toggle theme actions
use that same owner. [PR497](https://github.com/jupes/agent-forge-harness/pull/497)
also preserves input entered immediately after palette opening; its causal
regression does not explain the earlier missing-option incident. See
[appearance save and recovery](appearance.md).

The following behavior is accepted source in this snapshot. Its focused and
hosted source checks do not replace the remaining native and human gates.

| App Settings group | Accepted behavior and guide | Remaining boundary |
|---|---|---|
| Hearth diagnostics | [PR484](https://github.com/jupes/agent-forge-harness/pull/484): actual bound port, compatibility and logical file lengths; [Hearth guide](hearth-settings.md) | A read does not prove restart settlement, backup health or a transaction-consistent size |
| About and doctor | [PR486](https://github.com/jupes/agent-forge-harness/pull/486): bundled renderer/API metadata and internal navigation to the shared provider report; [About guide](about-doctor.md) | Doctor is explicit; version discovery is not authentication or native binary qualification |
| Nightly backups | [PR492](https://github.com/jupes/agent-forge-harness/pull/492): this Hearth schedules midnight UTC snapshots with current-lifetime next/last-attempt status; [Hearth guide](hearth-settings.md) | Closed apps do not run the scheduler; no backfill, global once-per-day or restore guarantee |
| Manual compaction | [PR494](https://github.com/jupes/agent-forge-harness/pull/494): reviewed machine-wide compaction of events older than 90 days with a backup first and durable unknown-outcome recovery; [compaction guide](ledger-compaction.md) | Explicit acknowledgement and action; no compaction scheduler or automatic restore |
| Update availability | [PR493](https://github.com/jupes/agent-forge-harness/pull/493): explicit bounded credential-free stable-release metadata check; [update guide](app-updates.md) | Compares the renderer version; automatic installation, native updater and package qualification remain open |
| Windows launch at login | [PR495](https://github.com/jupes/agent-forge-harness/pull/495): exact current-user registration/readback and pending-request recovery; [startup guide](app-startup.md) | Source qualification uses fake native transports; actual save/logon/shutdown and exact owned uninstall cleanup remain open |
| Execution environment | [PR496](https://github.com/jupes/agent-forge-harness/pull/496): additional allowed-name draft/review/save with paired revisions and exact receipt recovery; [environment guide](execution-environment.md) | Values are never read; a name does not prove provider inheritance or change running agents |

[PR498](https://github.com/jupes/agent-forge-harness/pull/498) proposes bounded
current-lifetime service logs. It is not part of the accepted source baseline
above; its hosted checks, screenshots and actual merge remain pending in this
snapshot. Integrations, native updater installation and remaining app Settings
service/native acceptance are still required for 1.0.

Use Projects to select the actual project, then its scoped Beads, Sessions,
Workbench, Runs, Reviews, Activity and Keeper. Start work only through an
explicit reviewed action. An observed session or metadata row does not grant
private transcript access or process control. Opening a view does not start
a provider. Existing provider expansion code is not proof of a supported 1.0
provider route.

The current release provider boundary is Claude/Codex through their actual
supported routes. Discovery, version response, authentication, adapter
capability and usage reporting are separate facts. Unknown allowance is not
zero and local ledger cost/token counts are not an account allowance. Do not
invent a percentage or automatically route work to another provider.
See [provider readiness](provider-readiness-contract.md),
[owned session launch](session-launch-contract.md),
[observed sessions](session-observations.md), [Workbench](workbench-contract.md),
[Shifts](project-shifts.md) and [checkpoint review](run-checkpoint-reviews.md).

## Refused, unknown and stopped outcomes

A verified Refused outcome under that specific action's contract means no
committed action. A generic error or non-success response after dispatch is not
that proof and can remain Unknown, as can a lost, timed-out or malformed answer.
Use the [action-outcome contract](../../../docs/js/action-outcome.ts) and that
action's owning original/receipt rules. Retain its original identity, inspect the
matching protected original/receipt and follow that action's recovery control.
Do not turn a matching current value into proof of an earlier delivery.
Do not create another Start, approval, comment or configuration write merely
because its response was lost.

The connection banner shares one recovery owner across the app. Restart
suspends workspace actions and refreshes the launch session once; it does not
replay pending writes. An unknown restart keeps another restart held until
the operator checks the Hearth and pending actions. Acknowledging the warning
does not prove the restart succeeded.

Foreground close uses explicit Quit confirmation; Cancel should keep the app
and its work available. An owned host failure cleans up and exits passively;
recovery is an explicit relaunch. These are required native behaviors with
remaining qualification holds. Do not use the historical retry-dialog/tray
demonstration as proof of the current foreground lifecycle.

## Current required feature and evidence matrix

“Implemented” identifies accepted source, not full release acceptance.
Open rows remain required unless the scope table explicitly defers them.

| Required 1.0 area | Implementation/evidence owner and accepted source | Remaining gate |
|---|---|---|
| Native launch, ownership, frame and recovery | `cla5.1.1–.3`; `src-tauri/src/main.rs`, lifecycle and desktop-host owners | `cla5.1.4`, `8z67`, `w20l`; current packaged/native and human settlement open |
| Projects, Overview and navigation | `cla5.2.1–.4`, `cla5.7.8`; ProjectsHome/ProjectOverview/DesktopApp | Current packaged and human journeys |
| Keeper briefs, selection and reviewed proposals | `cla5.3.1–.5`; Keeper producers and reviewed action owners | Source qualification and complete human journey |
| Owned Claude/Codex sessions and lifecycle | `cla5.4.1–.4`; existing launch/owned-session contracts | `1k0l` publication cause; packaged lifecycle and human acceptance |
| Observed, nested and managed Shift sessions | `cla5.4.5`; observation and managed-session owners | Current packaged boundaries; no inferred process authority |
| Explicit continuation after a limit | `cla5.4.6`; existing supported-provider review | Actual supported route and truthful usage in complete journey |
| Beads browse/tree/graph and verified writes | `cla5.5.1–.2`; ProjectBeads and write owners | Current packaged/human evidence |
| Workbench, approvals, bounded Shifts | `cla5.5.3–.5`; ProjectWorkbench and Shift runtime | Current halt/foreground update/Keeper journey |
| Provider readiness and usage | `cla5.6.1`; protected readiness producer/Providers | Missing required reported data stays an open reporting gap; Unknown is honest, not a waiver |
| Runs, Council and checkpoint review | `cla5.7.1–.3`; accepted Run/Review/Council producers | Full journey; `cla5.90` historical initiating cause remains unknown |
| Activity and shared object tabs | `cla5.7.4`; accepted PR428/shared ProjectActivity | Functional source accepted; named-board mapping remains partial |
| Inbox permissions and unknown writes | `cla5.7.5.2`, `.2.2.3`; PR488 bounded source contract accepted, production surface unmounted | Read-only current permissions, all retained scopes and unknown-write UI integration open |
| Other Inbox classes | `cla5.7.5.3–.5`; PR488 source adoption and existing class owners | All nine required classes and threshold configuration/UI integration open |
| Smiths, benches and scoreboard | `cla5.7.6`; accepted Smiths/config original-and-receipt owners | Current packaged/human coverage, unknown-write holds retained |
| Palette | `cla5.7.7.1` core accepted; PR481 Settings/theme owner; PR497 opening-input correction | `cla5.7.7.2` native/keyboard/current-Scope/full-Light acceptance and historical initiating cause remain open |
| Project Settings and read-only Scope | `cla5.7.9`; completed persistence children, PR475 foreground boundary | `.7.9.14` integration and `.7.9.18` partial native acceptance open; 11/14 is historical |
| App-wide Settings | `cla5.8.1.2–.9`: appearance, diagnostics, About, backups, update metadata, compaction, startup and environment source accepted as above | `.8.1.10` service-log proposal, integrations, native updater/install, owned startup uninstall and remaining service/native acceptance open |
| Session pop-outs | `cla5.8.3.1`, proposed PR482 | Unmerged; native qualification failed/held; no Quit/child-close/ACL/cross-window native pass |
| Supplied light appearance | PR481 shared roles and persisted theme | `cla5.8.4` full board/state and packaged/native acceptance open |
| Project/bead/session deep links | `cla5.8.5` | Cold/warm native navigation and invalid/ambiguous target recovery open |
| Five complete journeys | `cla5.7.10`, reconciled by `cla5.111.1` below | Complete current-candidate evidence and human acceptance open |
| Diagnostics, docs and notices | `cla5.111.2–.3`; this guide and retained diagnostic records | Independent disposition, exact packaged contents and full release docs qualification |
| Packaged candidate, installer and human Windows review | `cla5.111.4` | Full-featured candidate/build-smoke-seal, installer/launch and human record open |

The nine Inbox kinds are bead approval, checkpoint review, permission,
failed gate, halted bead, stopped Shift, Council verdict, unknown bead write
and usage threshold (the closed list in `types/inbox.ts`). Permission decisions
remain deferred; current read-only permission facts and their scope still need
to be present. No single partial notice list satisfies this matrix row.

## Five current journey targets

These are acceptance targets, not claims that five complete runs passed.
They apply the recorded cuts while preserving the original `cla5.7.10`
stories, sample copy, AC and graph as history.

| Journey | Current 1.0 walkthrough | Change from historical story |
|---|---|---|
| Morning check-in | Projects → actual Needs you/source status → project Overview/Keeper brief → ask what is blocked → follow scoped bead chips → explicitly approve reviewed bead proposals into the queue → verify Workbench | No invented count; complete Inbox/Needs you coverage remains required |
| Put Codex on a bead | Ready bead → Start session review → verify bead/worktree/model/effort/sandbox → one explicit supported Codex Start → activity and current permission status → files-changed facts → Send to Council | Read-only permission display; Allow once is deferred, not silently exercised or certified |
| Leave it running | Explicit bead approvals → bounded Shift review and Start → live panel → real fixture halt → foreground Activity/Inbox → open halted bead → Ask Keeper for explanation and reviewed fix proposal | OS notification/tray leg is deferred; foreground updates must actually work |
| Choose by headroom | Inspect actual provider-reported usage with source/time, or its explicit Unknown reason → deliberately choose an actually supported Claude/Codex route → review and start once | No fabricated82%, Gemini expansion or automatic quota routing; absent required reporting remains open |
| Review a checkpoint | Current active Run → exact checkpoint → Send to Council → live seats/result → review → explicit checkpoint approval with note and confirmed original | Preserve unknown-write recovery and current checkpoint identity |

Automated journeys must use isolated fake providers and private fixtures.
A passing simulated SQL-protocol fixture for compiled attended/Keeper code
does not qualify real Dolt semantics or native delivery. Individual component
tests, several bounded browser runs and a later green retry do not constitute
one uninterrupted five-journey or full-suite result.

## Retained diagnostic disposition

No cause is established merely because later suites pass.

| Bead | Current disposition | Evidence boundary |
|---|---|---|
| `8z67` Windows process ownership | Current release blocker; initiating cause unknown | Full Windows cleanup settlement failed; isolated passes do not prove the failing ownership boundary |
| `1k0l` atomic conversation publication | Current release blocker; cause unknown | Native publication returned refusal after private write; immediate trustworthy failure status absent; no ACL/unlink/retry fallback |
| `mdb7` hosted browser bootstrap | Resolved by PR480 | Exact official Bun package bootstrap and six hosted gates; earlier package-index failures retained |
| `5ma7` hosted app-client collection | Resolved by PR483 | Explicit directory argv, actual client-file headers/cases in both OS logs; historical earlier counts omitted these clients |
| `cla5.90` changed Run admission timeout | Historical cause still unknown/open | Exact failed45s response wait retained; current green CI does not identify its pending phase |
| `cla5.111.2.1` missing palette option | Historical initiating interleaving unknown/open | PR497 separately reproduced and fixed opening-input overwrite with causal RED/GREEN; this does not identify the older incident's cause |
| `cla5.111.2.2` Linux job budget | Open/tracking | PR495/496 postmerge cancellations and PR498's initial 7ec cancellation at the 15-minute job bound are retained; later successes do not explain them |
| `cla5.111.2.3` terminal review presentation | Open/unknown cause | Pre-submit source-region failure; bounded failure-only counts/booleans preserve the original assertion. A later 7.5-second pass is nonrecurrence |
| `cla5.111.2.4` Windows isolated read-table timeout | Open/tracking | PR497's earlier 1044 checkpoint exceeded the unchanged 15-second API-table bound; actual row/phase unknown |
| `cla5.111.2.5` Windows postmerge home isolation | Open/tracking | Actual 3266 automatic push 42974007720 failed Windows while the other five checks passed; embedded assertion failures retained, cause unknown |
| `cla5.111.2.6` Windows isolated paired-config writer | Open/tracking | PR498's initial 7ec run 42987825057 failed the home-isolation guard with an embedded paired-writer assertion; actual interleaving/cause unknown |
| `w20l` Windows/Bun restart stress | Open verification gap | Extra ownership-handoff fixture caused a native runner crash; no proven production crash or waived foreign-owner assertion |
| `2tzl` missing external worktrees | Independent external-state unknown/open | Four paths/registrations disappeared historically; no actor/cause/loss inferred; no recreation, restore, prune or cleanup authorized by this guide |
| `cla5.108.4` source-worker/session incidents | Open procedural/evidence hold | Prior boundaries are not retroapproved by later root authorship; retained actors, markers and unknown outcomes remain |
| Local complete-source/Scope qualification | Historical native holds remain | Production own-source prerequisite remains; deferring foreign Scope editing does not settle these holds |
| `cla5.7.9.18` current native Settings | Partial/open | Native rendering/build evidence exists; interactive resize/close/relaunch/accessibility qualification incomplete |
| `cla5.8.3.1` proposed pop-out candidate | Failed native qualification/hold | Two candidate launches charged; deadline forced cleanup, no native IPC/normal Quit acceptance; unspent third slot is not admitted |

The retained pop-out preview was built from `48938f8e`; its ZIP SHA-256 is
`A04E78C7CDA8B0AB839BEBF9405C938B785B51D299B46AC3B0342EEBDCDEF641`.
It is an **interim review packet**, not the full-featured1.0 candidate.
Its later failed runtime receipt supplements the immutable build-only manifest.
Cleanup settlement means owned processes were settled, not that normal Quit
or the feature passed. Do not replay a consumed helper or reset an attempt cap.

## Packaged and human Windows acceptance

The release record must name source commit, tree, ordered merge parents,
candidate version, file hashes, Windows/WebView2 versions, all required notices,
all six exact-head hosted gates and the exact current native receipt.
Native build success alone is not a smoke/seal result.

Prepare a private fixture checkout/home with a complete owned source and inert
provider stand-ins. Preserve earlier candidates and failed diagnostics. A fresh
native run needs its own prospectively reviewed ownership/cleanup limits and
current focus authorization. The November10 focus authorization ended at
08:00Pacific; this guide grants no new desktop-control permission.
The historical `desktop:smoke` experiment is not a current acceptance command.

For the eventual human review, record pass/fail/not-run and defect bead for
each observed case:

1. Verify package contents/notices and the actual installer when available;
   exercise launch, invalid-root/cancel/startup failure and a valid scoped source.
2. Use both minimum1100×700 and normal1440×900 windows; physically resize,
   maximize/restore and inspect long text, keyboard navigation, focus, reduced
   motion and screen-reader announcements.
3. Complete each current journey above with actual current fixture identities.
   A missing required feature is a failure/not-run with a bead, never a pass.
4. Check project Settings save/readback/stale and unknown outcomes; confirm
   saved Scope is read-only. Check app appearance across reopen and actual
   windows, then every remaining supported app Settings group.
5. Verify all required Inbox classes, Activity object tabs, palette scope/actions,
   supplied light states, pop-out synchronization/limits and all three cold/warm
   deep-link kinds once those features are included in the qualified candidate.
6. Cancel close, then confirm Quit; verify exact owned-process cleanup and no
   foreign termination. Exercise the reviewed owned-host-failure and relaunch
   case separately. Do not call forced cleanup a successful Quit.
7. Confirm no1.1 OS notification permission, quiet-hours/master or keep-alive
   control is activated. Record the deferred legs separately.

Keep `cla5.111.4` open until the human records their name, date, exact
candidate/source/build identity, observed outcomes and remaining defects.
Screenshots, agent review and hosted green do not self-certify that acceptance.
