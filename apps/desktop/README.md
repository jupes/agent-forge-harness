# Windows desktop tracer

This first desktop checkpoint wraps the existing dashboard in a Tauri 2
window. It needs Bun, Rust 1.99.1 (the version validated for this build),
Visual Studio C++ Build Tools with the MSVC toolchain and Windows SDK, and the
WebView2 Runtime. The build compiles the dashboard, desktop host, and hearth
locally; it does not run `build-pages` or package a Beads snapshot.

From the repository root, run `bun install --frozen-lockfile`, then
`bun run desktop:build`. The Release executable and its dashboard/sidecar files
are staged under `apps/desktop/build/windows-x64`. This is a runnable Release
folder for the first tracer, not an installer. Start it with an explicit
checkout path: `apps/desktop/build/windows-x64/agent-forge-desktop.exe --root <checkout>`.
The staged folder alone has no default checkout selection or
visible startup retry state yet.

`bun run desktop:smoke` starts that Release app against a temporary checkout
with an isolated `AGENT_FORGE_HOME` and unique WebView2 profile, with a bounded
loopback WebView debugger used only by the smoke. It checks the dashboard
launch exchange, packaged asset MIME types, and clean child shutdown; it does
not call a paid provider or alter the repository's Beads data. The native
shell does not yet provide a default checkout selection or a visible recovery
state if its supervised host stops after startup.

The `.ico` is a neutral, build-only tracer asset created for Windows resource
validation. It is not a final or approved product mark.
