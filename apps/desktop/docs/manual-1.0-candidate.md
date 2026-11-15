# Agent Forge 1.0 candidate: manual testing

This packet is a Windows x64 **engineering candidate**. Building it does not certify full 1.0, an installer, native behavior or human acceptance. Start with the identity in `CANDIDATE.json`; record that commit and workflow run with every result.

The first pass should answer whether Projects, Keeper, sessions and bounded work feel like the product you intended. Record missing capabilities and confusing behavior alongside defects.

## What is in this folder

Keep `agent-forge-desktop.exe`, `desktop-host.exe`, `hearth.exe`, `dashboard/`, notices and this guide together. The workflow builds the existing portable release folder without an installer. `CANDIDATE.json` records SHA256 and byte length for each other packet file; it does not hash itself. The workflow artifact also has its own SHA256 in the build summary.

The build checks source identity, locked dependency files and copied notices. Its Rust tests and automated browser checks do not launch this Windows app or establish a manual pass.

## Current completion boundary

The current engineering source implements the required surfaces below. Actual
Windows and human results remain separate:

| Area | Remaining work |
| --- | --- |
| Settings integrations | Source includes reviewed Claude/Codex/Cursor registration and original-outcome recovery; actual client/profile and activation checks remain |
| Deep links | Project, bead and session cold/warm native activation and recovery |
| Session pop-outs | Source integrated; current packaged child/parent close, IPC and cross-window qualification remain open |
| Native updates and installer | Source includes explicit signed check/download/review/install and durable attempt recovery; publisher setup, actual installer and Windows acceptance remain |
| Full Light appearance and keyboard use | Whole-app and minimum-window acceptance |
| Five workflows below | Current candidate end-to-end and human verification |

All nine Inbox classes and the checkpoint Council return are integrated in this candidate source. Read the exact source commit's hosted checks before treating it as qualified. Earlier failed installer, helper and native runs remain failed.

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

## Product-link checks

Use actual IDs from the disposable test project, bead and session. From the trusted checkout, start the portable executable with one quoted `agent-forge://project/<id>`, `agent-forge://bead/<id>` or `agent-forge://session/<id>` argument. Check the selected project and object after connection.

With the main window already open, repeat the executable invocation for each type. The existing main window should focus and select the verified item without another Hearth or provider start. Check invalid, missing, archived and ambiguous targets, manual navigation during a pending read, and recovery after losing the connection.

The portable folder does not register an OS protocol association. Test an installed `agent-forge://` activation separately when installer/native qualification is admitted; record actual focus, keyboard, Light and lifecycle results instead of inferring them from compilation or browser fixtures.

## Client registration and signed updates

Use a disposable supported client profile, with its ordinary configuration
backed up, and close work that should not be interrupted.

1. In Settings → Integrations, review Claude Code, Codex or Cursor separately.
   Verify the selected checkout and fixed client target. Cancel first and check
   that no configuration changed. Review again, then explicitly register.
2. Check that unrelated settings and existing foreign entries are preserved.
   "Configured" does not mean the client has activated or trusted Forge. Open the
   client yourself and follow its supported trust and tool-discovery workflow.
3. If publication reports an unknown outcome, use Check original outcome.
   Reload and recover that same request; do not register again to clear it.
   Record a refusal on unsupported filesystems or transactions as a refusal.
4. In Updates, distinguish the stable-release metadata check from Install signed
   updates. This ordinary candidate has no publisher public key: expect
   "Update publishing is not configured for this build." No download or installer
   should start, and the browser-only view must not gain native authority.
5. Test the configured signed channel separately when a publisher-configured
   candidate and signed Windows package exist. Check → Download → Review must
   leave installation unstarted. Cancel first. Finish or stop active work before
   explicitly choosing Install update and close Forge.
6. Record the actual installer, UAC/cancellation, owned-Hearth shutdown and
   reopened app version. A lost reply must hold the original attempt without
   repeating installation. A running target/newer version is an observation;
   retain the original attempt record and report unresolved outcomes honestly.

The engineering packet does not supply or generate a signing key, publish an
update channel, register an OS protocol or install an app. These actual Windows
checks need a separate attended testing window; current background work runs
none of them.

## Distribution contents

Keep legal/, DISTRIBUTION-INVENTORY.json,
COMPILED-DEPENDENCY-INVENTORY.json and RUNTIME-DEPENDENCY-INVENTORY.json
with the portable packet. They record original bytes and coverage boundaries.
Read their holds before distributing a release. Selected runtime originals
prepare review; complete source/relink and NSIS installer obligations remain
open. Record missing packet members as defects.
