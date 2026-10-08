# AGENTS.md — tests\e2e

The browser suite for the dashboard: `bun run verify:ui` (Playwright, Chromium, a desktop and a mobile project).

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping. The suite also runs on every pull request (`e2e` job in `.github/workflows/quality.yml`), so a red suite blocks the PR.
- **Fixtures are typed against the real API.** Everything in `fixtures.ts` is held to its model type with `satisfies` (`ForgeRunSnapshot`, `ReposKnowledge`, `BeadsPayload`). When an endpoint changes shape, `bun run typecheck` fails here. Do not loosen a fixture to `Record<string, unknown>` or cast it to get past that; update it.
- **No test may depend on this machine's state.** `docs/data/beads.json`, `.tmp/work/forge-runs/`, `repos/` and the quality-gate log are generated or gitignored, and a fresh clone (which is what CI gets) has none of them. Serve a fixture through route interception (`stubSnapshot`, `stubForgeRun`, `stubRepos`), or, for a test that reads the real API on purpose, assert only what the API just returned.
- **Do not skip a test because data is missing.** A conditional `test.skip` on missing data never runs in CI. A normal run reports zero skipped; a skip means something is wrong and needs a Beads issue and a reason.
- A test that is not meant for every run is deselected in `playwright.config.ts`, not skipped at run time. A project's `grepInvert` replaces a top-level one, so each project lists everything it leaves out.
  - `@screenshot` (`screenshots.spec.ts`) writes image files. It is selected only when `SHOT_DIR` is set: `SHOT_DIR=.tmp/shots/after bun run verify:ui -- --grep @screenshot`. CI never runs it. Its only assertion is a visible heading, so look at the images after changing a fixture it uses.
  - `@mobile` tests assert a 375px layout. They run on the mobile project only.
- New or changed tests are shown failing for the right reason before they count: break the thing under test, watch the test go red, restore it.

## Servers

- The config starts two servers, in order, and stops them afterwards: the hearth (`bun scripts/hearth/server.ts`, port 8798), then the dashboard (`bun run dashboard --strictPort`, port 8799), which attaches to that hearth. `control-plane.spec.ts` fails if the dashboard is proxying to any other hearth.
- A server that is already answering on either port is never reused; the run stops with an error naming the URL. It could belong to another checkout or to a hearth in your real `~/.agent-forge`. To run beside one, set `PORT` (dashboard) and `E2E_HEARTH_PORT` (hearth).
- What a busy port looks like:
  - something answering HTTP 200–403 there: `… is already used, make sure that nothing is running on the port/url`;
  - something answering with another status on the hearth port: `[hearth] Failed to start server. Is port 8798 in use?`;
  - the same on the dashboard port: `[dashboard] Error: Port 8799 is already in use`;
  - a listener that accepts connections and says nothing: no message at all. The runner's own availability check has no timeout, so it waits. If a run prints nothing for a while, check the two ports.
- Servers can outlive a run that was killed hard (the runner only stops them on a normal exit or Ctrl+C). Find and stop them by port, for example on Windows `netstat -ano | findstr :8798` then `taskkill /PID <pid> /T /F`, or use the two port variables for the next run.
- Each run gets a hearth home of its own, `agent-forge-e2e-<pid>-<time>` in the OS temp directory, removed when the run ends. The reason: the runner kills its servers outright, so a hearth never releases its lock, and a hearth started directly treats any lock with a live pid as a running hearth and exits (`agent-forge-harness-kt0q`). A home shared between runs would stop the suite from starting whenever an old lock's pid had been reused.
  - The home is left behind when a server fails to start or the run is killed. `agent-forge-e2e-*` directories in the temp directory are safe to delete; each holds a lock file and a token for a hearth that no longer exists.
  - `AGENT_FORGE_E2E_HOME` overrides the location, for inspecting what the hearth wrote. A home set that way is never deleted, and if it still holds a lock from an earlier run the suite will not start. Empty it first.
- `bd` writes during a local run can reload the page mid-test: the dashboard watches `.beads/` and rebuilds the snapshot. Leave Beads alone until the run ends.

## Notes

- Counts, as of the change that put the suite in CI: 130 tests exist (65 per project). A normal run selects 110 (54 desktop, 56 mobile): the 18 captures are opt-in and the 2 mobile-only tests are left out of the desktop project. Recompute with `bun run verify:ui -- --list`, and with `SHOT_DIR` set to include the captures.
- What a green CI run does not prove. CI has no Beads snapshot and no forge run, so there: Dashboard, All issues, Epics and Insights render their "No snapshot loaded" state, and the real-API Forge run test takes its no-run branch. Populated states are covered only where a test serves a fixture. CI runs Chromium on Linux only.
- A failed CI run uploads `test-results/` (a trace per failed test and a screenshot of the page at failure) as the `playwright-test-results` artifact. Open a trace with `bunx playwright show-trace <trace.zip>`.
- `bun run lint` does not cover this directory. Keep new files clean with `bunx biome check <file>`.
- `bun test` does not collect these specs (`bunfig.toml` roots it at `scripts/`).
