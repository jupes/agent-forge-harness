# Windows shell review

Status: automated evidence prepared; human review still required for
`agent-forge-harness-cla5.1.4` (Verify the shell on Windows).

Review the Windows x64 Release app, version 0.1.0. The frame baseline is
commit `20827ee` (PR #263). The shared-hearth lifetime correction is
`agent-forge-harness-c9pb` (Keep a shared hearth alive when its first window
closes); record the final PR head commit with the human result.

## Run the isolated demonstration

Use Bun 1.4.2 and the Windows build toolchain described in the desktop README.
From the checkout containing the reviewed changes:

```powershell
bun run desktop:build
bun run desktop:smoke
```

The demo runs the actual packaged Tauri/WebView2 app with a temporary checkout,
private hearth home, compiled tracker stand-in and separate WebView2 profiles.
It does not call a paid provider or write to the real Beads tracker. Its
loopback debugger belongs only to this bounded demo. It removes its temporary
files after the captured child processes have stopped.

Watch the automated sequence without interacting while it drives the windows:

1. Cancel checkout selection and startup recovery; retry an invalid folder,
   then retry a repaired startup.
2. Exchange a launch session and check packaged assets and the connection.
3. Show explicit version mismatch, bounded reconnection attempts and Stopped
   with the last-data time. Restart on the existing origin and refresh the
   session. Lose a restart answer and hold a second action until checked.
4. Show the frame at 1440x900 and 1100x700. Navigate the rail by keyboard while
   preserving project/selection ids. Open the inspector, close with Escape,
   and collapse it on resize with focus returned to its toggle.
5. Crash the fixture host; retry through the native recovery dialog, then
   exercise Cancel on a second failure. Check retired origins and shutdown.
6. Open two native windows on the same isolated checkout/home. They must use
   the same health-reported hearth pid. Close the first window normally; the
   second must keep that pid and its authorized session. Close the last window
   and require the hearth to stop. Reopen with the same WebView2 profile and
   require a fresh launch session, then close normally again.

The normal-close automation uses Windows `CloseMainWindow` (the native window
close request). It does not claim a human clicked the title-bar X.

## Automated evidence

| Area | Evidence |
|---|---|
| Real Windows runtime | Packaged Release executable, native dialogs and WebView2 CDP checks; separate from the Chromium browser suite |
| Launch/recovery | First launch, Cancel/Retry, valid checkout, same-origin launch, session/token, real hearth and host replacement |
| Frame | Captured 1440x900 and 1100x700; no/unknown project, unavailable destinations, constrained long-name slot and wrapped object reference |
| Keyboard/focus | Rail Enter, inspector Enter/Escape, explicit and responsive focus return, visible outlines with the specified 2px Nocturne rule |
| Targets/contrast | Visible enabled frame controls at least 24px; computed muted/accent text contrast at least 4.5:1 against its rendered surface |
| Reduced motion | Reduced-motion emulation; no banner animations; frame animations/transitions disabled |
| State/write safety | Actual retry counts and data receipt time, one resumed stream, unknown-outcome hold, no pending workspace-action replay |
| Window lifetime | Shared pid survives former-owner close; last-owner close stops it; reopening refreshes the session |
| Cleanup | Captured fixture-owned children gone; no leftover app, host or hearth |

Screenshots are in this folder:

- [Wide frame, 1440x900](native-frame-1440.png)
- [Minimum frame, 1100x700](native-frame-1100.png)
- [Stopped connection](native-connection-stopped.png)
- [Unknown restart outcome](native-connection-unknown.png)
- [Native startup recovery](native-startup-recovery.png)
- [Native host recovery](native-runtime-recovery.png)

The connection screenshots record the earlier dashboard transport checkpoint.
The current frame screenshots record the desktop frame. Sample/fixture ids do
not assert that a project, session, allowance or spend exists in production.

Focus measurements distinguish the specified CSS width from WebView2's used
width. On this Windows display under the 1100x700 emulation, the 2px author rule
reports a 1.71429px computed width. The smoke records both as `focusOutline`,
requires the 2px author rule and a visible positive-width ring, and keeps the
scaled appearance in the human checkpoint. It does not report a measured 2px
width when WebView2 reports a different value.

## Human checkpoint — not yet run

Review the real native demonstration and supplied design, then record:

- Whether native title-bar/window behavior and wide/minimum layout match the
  intended Windows experience. Physical pointer use of the title-bar X is
  still a human observation, not the scripted close request.
- Whether actual keyboard use and focus visibility feel coherent, including
  the compact sidebar and inspector.
- Whether Narrator or another screen reader announces connection changes,
  errors and focus appropriately, without repeating ordinary streamed updates.
- Any board/layout discrepancy, with the state, window size and reproduction.

The human result must include reviewer, date, exact commit, Windows/WebView2
versions if available, observed cases and any not-run cases. Automated checks
and screenshots alone do not close this HITL bead.

Project persistence and full destination screens remain later tasks. Their
unavailable states are intentional frame integration points. No installer,
tray behavior, provider execution or five-journey sign-off is claimed here.
