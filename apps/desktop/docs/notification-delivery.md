# Halted-shift notification delivery

Project Settings → Notifications exposes **Enable window interruptions** and
**Pause window interruptions**. The window switch starts off on every launch.
The saved project **Shift halted** preference must also be on. Permission is
requested only by the explicit Enable action; opening Settings never prompts.

This first delivery slice calls the production Web Notifications API (`new
Notification`) in the Windows WebView2 renderer. The shell does not intercept
`NotificationReceived`, so WebView2 owns its default notification UI. Microsoft's
[WebView2 API overview](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis)
documents this native non-persistent notification behavior. No fake delivery
provider is installed in production and no new native privilege is granted.

Only the selected project's newly observed **stopped** shift with the exact
canonical reason **halted** is eligible. Normal completion, manual Stop, unknown
outcomes and an individual halted bead in a still-running shift do not notify.
The owner reads the protected project shift page, verifies the existing original
request hash and project/workspace identity, then reads current catalog
preferences and membership. Absent preferences, archived/deleted projects,
foreign workspaces and unavailable reads suppress delivery. These reads never
write shift records, approve work, start providers or dismiss Inbox items.

The app-root observer shares the existing ledger connection. A shift event or
operator action triggers a coalesced read; a five-second fallback observes
changes even while the document is hidden. WebView2/Windows background timer
throttling can delay observation. Initial reads, reconnects, navigation and
recovery establish a fresh baseline rather than replaying historical halts.
Suppressed/attempted halts are consumed for this observer, so a preference change
or native failure does not cause a retry storm. The observer retains at most
1,000 identities; capacity exhaustion requires Pause/Enable for a new baseline.
Catalog and receipt responses have a 1 MiB receiving limit before JSON parsing.

Raw route/stream transitions, render scope changes and Pause permanently retire
old observer and permission callbacks, including A → B → A changes. Native
handles are closed on owner disposal. Clicking a notification only opens the
exact original shift after a fresh receipt/hash/catalog check. It never approves
or allows anything. Existing in-app authority still governs all actions.

The Settings status distinguishes a request, a runtime-reported display, denied
or unavailable permission, and unconfirmed native display. Windows notification
settings/Focus Assist can suppress a request. The ephemeral loopback origin can
require permission again after relaunch. This delivery requires a living window;
tray operation, cold activation, other event kinds, persistent app notification
policy and quiet hours remain work under the existing notification/app/tray
issues. The Project Settings notification milestone remains open.

## Evidence and deferred bug bash

Focused tests use isolated receipts and a fake native constructor; they verify
the actual production constructor call and state/authority boundaries. They do
not prove a Windows notification appeared. No browser, app, tray or native
console was opened during implementation. No screenshot or native display pass
is claimed.

During the later manual Windows bug bash: enable the window and saved project
opt-in, grant permission, observe a fresh fixture shift halt while the window is
hidden, click to inspect the exact original, then check Pause, denied permission,
project switching and reconnect baseline. Check keyboard operation and the live
status announcement. Preserve all older Source/Scope qualification holds.
