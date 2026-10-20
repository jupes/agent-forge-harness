# Windows desktop tracer

This first desktop checkpoint wraps the existing dashboard in a Tauri 2
Building requires Bun, Rust 1.99.1 (the version validated for this build), and
Visual Studio C++ Build Tools with the MSVC toolchain and Windows SDK. Running
the staged app requires the WebView2 Runtime and a valid checkout path; it does
not require Bun or Node on the runtime `PATH`. The build compiles the
dashboard, desktop host, and hearth locally; it does not run `build-pages` or
package a Beads snapshot.

From the repository root, run `bun install --frozen-lockfile`, then
`bun run desktop:build`. The Release executable and its dashboard/sidecar files
are staged under `apps/desktop/build/windows-x64`. This is a runnable Release
folder for the first tracer, not an installer. Start it with an explicit
checkout path: `apps/desktop/build/windows-x64/agent-forge-desktop.exe --root <checkout>`.
The staged folder alone has no default checkout selection or
visible startup retry state yet.

After `bun run desktop:build` has produced the dashboard assets and sidecars,
run the native Rust checks:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

`bun run desktop:smoke` starts that Release app against a temporary checkout
with an isolated `AGENT_FORGE_HOME` and unique WebView2 profile, with a bounded
loopback WebView debugger used only by the smoke. It checks the dashboard
launch exchange, packaged asset MIME types, and clean child shutdown; it does
not call a paid provider or alter the repository's Beads data. The native
shell does not yet provide a default checkout selection or a visible recovery
state if its supervised host stops after startup.

The Bun 1.3.10 `node:http` host does not currently detect a client disconnect
while an upstream streaming response is open; runtime stream cancellation
remains a tracked gap.

The `.ico` is a neutral, build-only tracer asset created for Windows resource
validation. It is not a final or approved product mark.
