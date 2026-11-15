# Agent Forge 1.0 candidate: manual testing

This packet is a Windows x64 **engineering candidate**. Building it does not certify full 1.0, an installer, native behavior or human acceptance. Start with the identity in `CANDIDATE.json`; record that commit and workflow run with every result.

The first pass should answer whether Projects, Keeper, sessions and bounded work feel like the product you intended. Record missing capabilities and confusing behavior alongside defects.

## What is in this folder

Keep `agent-forge-desktop.exe`, `desktop-host.exe`, `hearth.exe`, `dashboard/`, notices and this guide together. The workflow builds the existing portable release folder without an installer. `CANDIDATE.json` records SHA256 and byte length for each other packet file; it does not hash itself. The workflow artifact also has its own SHA256 in the build summary.

The build checks source identity, locked dependency files and copied notices. Its Rust tests and automated browser checks do not launch this Windows app or establish a manual pass.

## Current completion boundary

Required work still open when this guide was introduced:

| Area | Remaining work |
| --- | --- |
| Settings integrations | Register supported clients with preserved configuration and durable outcome recovery |
| Deep links | Project, bead and session cold/warm native activation and recovery |
| Session pop-outs | Source integrated; current packaged child/parent close, IPC and cross-window qualification remain open |
| Native updates and installer | Installation/update delivery and actual Windows acceptance |
| Full Light appearance and keyboard use | Whole-app and minimum-window acceptance |
| Five workflows below | Current candidate end-to-end and human verification |

Current checkpoint and Inbox repairs are subject to their exact-head hosted checks. Read that run's actual result before treating a failed workflow as fixed. Earlier failed installer, helper and native runs remain failed.

The established 1.1 cuts are foreign-workspace Source authorization and Scope editing, OS notifications and tray keep-alive, provider expansion and in-app permission decisions. Saved Scope and permission status remain read-only in 1.0. These cuts do not defer the remaining rows above.

## Set up the first pass

1. Use Windows x64 with WebView2 and a separate test checkout. The checkout must have the existing initialized local Beads/Dolt source; opening the app does not create or start it.
2. Keep your everyday checkout and agent home separate. Set `AGENT_FORGE_HOME` to a dedicated local test folder in the shell used to launch this candidate.
3. Have Git and Beads available for actual worktree/tracker operations. A supported Claude/Codex session additionally needs its installed, authenticated vendor CLI. Opening a screen should never start a provider.
4. Launch the executable and choose the test checkout, or run `./agent-forge-desktop.exe --root "C:/path/to/test-checkout"`. Bun and Node are not required on the runtime PATH.
5. Verify that Projects and Hearth status identify the intended checkout. If the source is unavailable, record that state and its recovery controls before attempting a write.

Use a disposable project and bead for write tests. Any Start, queue approval, Shift, Council or configuration change should follow its explicit review and confirmation.

## Five product workflows

### 1. Morning check-in

Open Projects, choose the test project and read Overview and Keeper. Ask what is blocked, follow a returned bead reference, review a proposed change and explicitly approve it into the queue. Open Workbench and confirm the actual resulting bead and queue state.

Record whether project context, next actions and explanations are clear. An unknown source count must remain unknown.

### 2. Put Codex on a bead

Choose a ready test bead and open Start session review. Check project, bead, worktree, provider/model and execution settings. Start once through the supported route, observe session activity, inspect reported file changes and send the intended source to Council.

Read permission status where available. Permission decisions use the vendor's supported workflow; in-app Allow once is deferred. Confirm that navigation does not start a second session.

### 3. Run a bounded Shift

Approve the intended beads, review the Shift's boundaries and start it explicitly. Follow the live panel and Activity. Observe a test halt or stop, find the same item in Inbox, open the halted bead and ask Keeper for an explanation and reviewed next step.

Foreground updates must work. An OS notification or tray background run is outside the current 1.0 scope.

### 4. Choose by reported headroom

Open provider usage and inspect its source, timestamp, reported allowance and reset information where supplied. Missing reporting must show its reason rather than a fabricated percentage or zero. Deliberately select an actually supported Claude/Codex route and review a single Start.

Check that configured usage thresholds produce the intended retained Inbox items. Changing a threshold must not imply the provider's allowance changed or automatically reroute work.

### 5. Review a checkpoint

Open a Run and its in-progress checkpoint. Publish the intended checked source through the explicit source action. Verify that the review refers to that exact source version. Follow Council's result back to the same Run/checkpoint, then enter a separate human review note and explicitly submit the intended verdict.

Check keyboard focus at the review note and after navigation. A Council verdict must not silently become human approval.

## Recovery and everyday use

- Reload and move between projects with an unsent draft. Observe whether the app explains what is retained and what needs another explicit action.
- If a write reports Outcome unknown, inspect its original/receipt using its own Check or recovery control. A matching current value is not proof of earlier delivery. Do not repeat Start or approval to clear a warning.
- Inspect Inbox permission, checkpoint, approval, failure, halted/stopped work, Council, unknown-write and usage items. Follow an item and return without losing its scope.
- Use the command palette and keyboard throughout. Check visible focus, Escape, reduced motion and layout at 1100×700 and 1440×900.
- Switch Dark/Light/System and density in Settings; restart to check persistence. Inspect provider diagnostics, Hearth logs, backup status and update availability without confusing metadata with successful effects.
- Test close/Cancel and explicit Quit, then relaunch. Observe session and owned-host cleanup separately. Current foreground host failure requires explicit relaunch.
- Record pop-out, deep-link, startup and update behavior separately; do not infer a pass from a browser fixture or an earlier candidate.

## Record each result

Use this shape for each workflow or defect:

| Field | Record |
| --- | --- |
| Candidate | Source commit, tree, workflow run and artifact SHA256 |
| Environment | Windows version, WebView2, viewport/theme and supported provider/CLI version |
| Action | Starting project/object, exact steps and explicit confirmation used |
| Expected / observed | User-visible behavior and actual outcome |
| Evidence | Redacted screenshot, relevant timestamp and non-secret object identifier |
| Result | Pass, fail, blocked or not run |

Keep credentials, tokens, raw private transcripts and diagnostic homes out of reports. A defect report should describe one reproducible behavior.

The source checkout's `apps/desktop/docs/release-1.0.md` contains the broader release matrix and historical evidence. Reviews and actual human release signoff remain separate after engineering completion.
