# Project notification delivery

Project Settings → Notifications exposes **Enable window interruptions** and
**Pause window interruptions**. The window switch starts off on every launch.
The matching saved project event preference must also be on. Permission is
requested only by the explicit Enable action; opening Settings never prompts.

This first delivery slice calls the production Web Notifications API (`new
Notification`) in the Windows WebView2 renderer. The shell does not intercept
`NotificationReceived`, so WebView2 owns its default notification UI. Microsoft's
[WebView2 API overview](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis)
documents this native non-persistent notification behavior. No fake delivery
provider is installed in production and no new native privilege is granted.

For Shift halted, only the selected project's newly observed **stopped** shift with the exact
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
tray operation and cold activation remain work under the existing notification/app/tray
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


## Gates, councils and approval interruptions

The other three saved project preferences now have production native consumers.
Failed gates require canonical `gate.ran` metadata with `passed: false`.
Council verdicts require `council.run.finished` outcome `pass`, `fail` or
`unreadable`; cancelled runs and verdict comments do not qualify. Bead approval
requires a `bead.transitioned` event to `proposed` and a fresh protected bead
page confirming the same still-open bead in the backed proposed queue.

The existing shared stream cursor establishes initial/reconnect baselines. Each
refresh stages at most four 200-event protected Activity pages, validates exact
project/workspace/filter/cursor/ULID identity, and permits at most32 eligible
interruptions. Larger backlogs report unavailable and establish a new baseline,
with all source records retained in Activity. Each candidate rechecks its exact
protected Activity detail, current approval queue where applicable, and current
catalog preferences before the native request. Positively verified events can
be reported while other source discovery is incomplete; no complete-feed claim
or totals are inferred. Open rechecks the exact event again and only navigates
to Activity or the pending bead; it never Approves or Allows.


## Persisted app interruption policy

Settings now exposes a machine-wide notification master switch and local-computer
quiet hours. Policy is stored privately under AGENT_FORGE_HOME, independent of
project preferences and of the ephemeral renderer origin. Defaults permit the
existing explicit window and saved project opt-ins; no quiet hours are configured
until saved. Master off or an active quiet interval suppresses only interruption.
Quiet start is included, end is excluded, overnight intervals are supported,
and equal endpoints are invalid. The computer's local clock follows DST changes.

Protected GET/POST /app-settings/notifications use the operator table, audit-before-
effect and revision CAS. An initialization marker makes a missing saved policy
unavailable rather than default-on. Malformed/unavailable policy holds native
interruptions. Saves have exact receipt/readback verification; an unknown save
cannot be retried until a newer revision fences its original CAS. Policy reads
are receiving-bounded before parsing. After every awaited policy read, the owner
rechecks exact source and current project opt-in before the native constructor.
Missing verifier or retired scope holds delivery. Native/manual evidence remains
not-run; broader app settings and tray features remain open.
