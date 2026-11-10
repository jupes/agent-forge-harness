# Session windows

In the Windows app, open a session and choose **Pop out session**. The compact
window shows that exact project and session without the main navigation rails
or inspector. Opening the same target again brings its existing window forward.
Its native title includes the session identity so open windows can be distinguished.
You can keep two compact windows beside the main Forge window. Close one before
opening a third target.

An app-owned Chat keeps its existing transcript and composer. Sending from a
compact window uses the same protected conversation and original request
handling as the main view. Opening or closing a window never starts a provider
or creates a session. Observed sessions retain metadata only. Managed Shift
attempts retain read-only attendance tied to their exact original Shift; whole
Shift controls remain in the main window.

All windows share the app process, launch profile, authenticated local host and
Hearth. Compact windows check actual protected conversation pages once a second
after catching up, releasing their HTTP connections between checks. They keep
the normal identity, history, size, uncertain-outcome and bounded reconnect
checks. The main window keeps its existing conversation stream. Unused Keeper
streams do not run in compact windows.

Closing a compact window leaves the session and Hearth running. Closing the
main window asks whether to quit the app and its owned Hearth; Cancel keeps
all windows running. Confirmed Quit closes all windows. If the owned host fails,
the foreground app closes its windows and requires an explicit relaunch.

Use the main window to navigate elsewhere. Changing a compact address makes
its content unavailable and fences writes; it does not adopt another project
or session. Invalid native context shows an unavailable window without mounting
the main app. A native result that cannot be confirmed never retries itself:
check open Forge windows before choosing **Pop out session** again.

The browser preview explains that native windows are available in the Windows
app. It does not emulate native window ownership.

## Qualification

Focused browser checks cover existing Chat reply synchronization with three
views, observed metadata and address fencing, main-only bridge arguments,
invalid native context, and managed attendance without provider or tracker
mutations. Rust checks cover strict target URLs, bounded reservations, pending
deduplication and stale destruction/generation cleanup. Native IPC, window
closure and packaged lifecycle require separate evidence; these checks do not
substitute for the operator's Windows acceptance.
