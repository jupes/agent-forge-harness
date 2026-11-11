# Launch at login

In the installed Windows desktop app, open Settings and check startup
registration. Change **Launch the foreground app at Windows login**, then Save.
The checkbox only creates a draft. Cancel discards the draft without changing
Windows. This app-wide setting applies to the current Windows user across
projects, installations and custom Forge homes.

A login launch always opens the normal workspace chooser, even when its
working directory is already a valid checkout. Cancelling starts no host or
agent. No saved workspace grant, background window, tray keep-alive or provider
task is created by this setting.

Enabled means the helper read back this installation's exact startup command.
Not registered means the value was absent at the read. An existing value that
differs, has an unsupported type or cannot be decoded is left unchanged. The
app never displays a foreign command or treats an unreadable entry as off.
Windows can delay or disable startup apps; registration does not prove that
the app executed at a later logon. Review Windows Startup Apps when checking
actual login behavior.

The command is the quoted current native executable followed by `--from-login`.
Only the current user's `Software\Microsoft\Windows\CurrentVersion\Run` value
`dev.agentforge.harness` is addressed. Commands exceeding 260 UTF-16 code units,
unsupported executable paths and non-Windows/non-native windows are refused or
shown as unavailable. The renderer supplies no executable, registry path,
profile path, command line or workspace selector. The fixed native protocol
exits before any GUI startup, including when its arguments are invalid.

The protected desktop-host read and audited write reuse the existing operator
gate/token/body runner. Native commands use the existing process supervisor,
with a fixed 3-second execution budget, 4 KiB output cap and mandatory owned-tree
settlement. These bounds do not promise a hard filesystem deadline or prove
real native cleanup merely because a fake test promise settled.

The actual OS user's LocalAppData location is resolved by the native helper,
independently of environment home overrides. A fixed private startup journal
and cooperating-writer mutex there coordinate all Forge homes and installations.
An exact pending record is published and verified before a native write. A
pending record from any installation holds later Settings writes. Missing
initialized, corrupt or oversized history never resets itself. Closing joins
the whole write, including queued mutex work, and aborts native calls.

Only the exact latest terminal receipt can resolve a window's preserved pending
request. Matching current registry state alone does not attribute the original
write or clear an unknown outcome. Window session storage preserves the request
across navigation and reload. Native write/readback/settlement or final receipt
publication uncertainty stays unknown; it is never retried automatically. A
definitive pre-effect refusal retains the draft and requires a fresh read.
Only the latest receipt is retained, not a full operation history. Regressed or
contradictory responses hold saves and retain the last verified facts.

The mutex serializes cooperating Settings instances. External registry editors
remain an independent race boundary; this is not OS-level compare-and-set.
The helper rechecks the observed exact entry before modifying it and reads it
back afterward. It does not overwrite an observed foreign entry.

Source qualification uses fake registries, fake native transports, temporary
coordination directories, isolated HTTP fixtures and headless browser fixtures.
Offline Rust tests compile the Win32 adapter but do not query or modify the
actual user's registry. Test-only assets and empty bundle resources are not an
installer/payload qualification. Actual Windows save/reopen/logon, app shutdown,
uninstall and human release acceptance need separate evidence. Required cleanup
of this exact installation's entry during uninstall is tracked by
agent-forge-harness-cla5.111.5 (owned startup-entry removal); it is not deferred
to 1.1 or qualified by this Settings source change. The frozen installer kit
does not include this source.

Primary platform references: [Microsoft Run and RunOnce keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)
documents the current-user key, command-length limit and delayed startup;
[Tauri NSIS configuration](https://v2.tauri.app/reference/config/#nsisconfig)
documents the current-user install mode and uninstall hooks used by the
separately tracked packaging integration.
