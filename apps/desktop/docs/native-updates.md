# Native signed updates

Settings separates the GitHub release metadata check from signed Windows
package preparation. The signed updater is an explicit foreground path:
Check signed package, Download signed update, Review installation, then
Install update and close Forge. Cancel closes the review without installation.
No mount, stream event or reconnection checks the remote update channel.
The initial native status read only inspects cached/private recovery metadata.

The native broker is limited to the current main window, literal loopback
origin and live owned Hearth generation. Its closed operations accept an
original UUID only. URLs, public keys, filesystem paths, commands, installer
arguments and operator credentials cannot be selected by the renderer.
Every check, download and installation first requires a confirmed protected
operator.action audit and an exact scope-bound private authorization ticket.
Only three fixed ticket filenames are retained, one per operation.

The fixed channel is:
https://github.com/jupes/agent-forge-harness/releases/latest/download/latest.json
It must supply a stable numeric SemVer and a windows-x86_64-nsis platform entry.
The package URL must name this repository, that exact vVERSION release and an
x64 NSIS setup executable. HTTPS redirects are limited to this repository's
release paths and GitHub's release-assets host. Ambient proxies are disabled;
TLS uses the Windows trust store. Metadata is capped at64KiB/10seconds and the
package at256MiB/120seconds, including streaming reads. No package is executed
by a check or download.

Tauri updater2.14.1 is pinned. The bounded metadata is passed to restore_update;
its signed-version requirement and the build-time publisher public key verify
the downloaded bytes. The SDK verifies again before installation. Original
npm and locked Cargo notices remain separate distribution inventories.

Set AGENT_FORGE_UPDATER_PUBLIC_KEY in the release build environment to the
publisher's Tauri public key. There is no development/test-key fallback.
Without a key the app reports publishing unconfigured and refuses update
network/download/install work. The private signing key must remain with the
release publisher; no signing key is generated, requested from the renderer
or committed by this integration. Publisher signing and channel provisioning
remain release requirements. A portable engineering build has no configured
publisher key unless one was explicitly supplied to its build.

Before an install can be sent, the renderer saves and reads back metadata-only
intent. The native owner keeps a private prepared original, a cross-process
lease and an attempted record before retiring the exact owned Hearth lifetime.
One private global gate prevents a new installation while an earlier outcome
is unresolved. The SDK opens its Windows installer; success launching it exits
the native process and does not fabricate an installation-complete receipt.
Finish or stop active work before confirming installation. The app stays closed
after the installer; reopen it explicitly.

A lost reply never resends installation. Exact read-only recovery distinguishes
no launch, attempted/unknown and a target-or-newer running version observation.
The native journal also restores an unresolved original when a fresh native
launch uses a different loopback origin and browser metadata is absent.
Original attempted records are retained after version observation. For pinned
SDK2.14.1, a returned Windows installation error occurs before successful
ShellExecuteW; an exact private no-launch receipt permits a fresh preparation.
If that receipt cannot be stored, the original remains unknown. No raw SDK
error, private path, configuration or package bytes reach renderer recovery.
A cancelled installer that already launched can remain unknown; inspect its
actual outcome before proceeding. Journal admission refuses beyond2048 entries.

Focused local tests cover persisted confirmation, audit ordering, exact target
versions, lost replies, reload/native-journal restoration, storage failure,
disconnect/disposal and unconfigured builds. The protected API matrix checks
route completeness and audit-before-effect. Hosted browser journeys include
capture-phase blocked-click witnesses, original recovery, no replay,2px focus,
1100px width fit and a review screenshot. Native Rust units exercise publisher
policy, private originals, leases and outcome observations in temporary homes.
Browser fixtures do not qualify a real signature, installed package, installer,
UAC choice, Windows reboot or provider/client execution. Those remain explicit
packaged Windows manual acceptance requirements.
