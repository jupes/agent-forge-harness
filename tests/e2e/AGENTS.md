# AGENTS.md — tests\e2e

The browser suite for the dashboard: `bun run verify:ui` (Playwright, Chromium, a desktop and a mobile project).

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping. The suite also runs on every pull request (`e2e` job in `.github/workflows/quality.yml`), where a red suite shows as a failed Playwright check. That check is not a required status check on `master`, so GitHub will still let the PR merge: treat red as blocking yourself.
- **Fixtures are typed against the real API.** Everything in `fixtures.ts` is held to its model type with `satisfies` (`ForgeRunSnapshot`, `ReposKnowledge`, `BeadsPayload`). When an endpoint changes shape, `bun run typecheck` fails here. Do not loosen a fixture to `Record<string, unknown>` or cast it to get past that; update it.
- **A request to the hearth's operator API is made from page context** (`page.evaluate` with `fetch`, or the page's own code), not with the runner's `request` fixture: the API answers only a declared same-origin request, and the runner's requests carry no `Origin`. The hearth is the real one (`main()`), but its `bd` is the suite's recording stand-in (see Servers): `GET /queue` and the stream snapshot get an empty list from it, here and in CI.
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
- Each run gets a hearth home of its own, `agent-forge-e2e-<pid>-<time>` in the OS temp directory, removed when the run ends. It holds the hearth's lock and token, its ledger (`operator-api.spec.ts` reads what the hearth recorded there) and the artifacts of the one simulated council run that spec starts (`COUNCIL_RUNS_DIR` points there, so nothing lands in `reports/`). The reason: the runner kills its servers outright, so a hearth never releases its lock, and a hearth started directly treats any lock with a live pid as a running hearth and exits (`agent-forge-harness-kt0q`). A home shared between runs would stop the suite from starting whenever an old lock's pid had been reused.
  - The home is left behind when a server fails to start or the run is killed, and on Windows after every run: teardown runs while the hearth still holds its ledger open, so the removal fails quietly. `agent-forge-e2e-*` directories in the temp directory are safe to delete; each belongs to a hearth that no longer exists.
  - `AGENT_FORGE_E2E_HOME` overrides the location, for inspecting what the hearth wrote. Teardown deletes a home only when its path has the generated shape (`agent-forge-e2e-<pid>-<time>` directly in the OS temp directory); it goes by that shape, not by who chose the path. Any other home is left alone, so the previous run's lock stays in it. That is harmless while the lock's pid is dead: the next hearth replaces it. Once that pid has been reused by any live process, the suite stops at start-up with `[hearth] hearth already running on …` and `Process from config.webServer exited early.` Empty the directory before reusing it.
- **The suite never reaches a tracker.** A hearth runs `bd` for a write, and the hearth here is the real one, so the `bd` it finds is not left to chance:
  - `bd-stand-in.ts` is a recording stand-in. It appends every argument array it is called with to `bd-stand-in/state/calls.jsonl` in the run's home, keeps the issues it created beside it, answers the four writes of the Beads routes in the shapes `bd` prints (from `scripts/hearth/bd-answers.ts`, the module the unit tests use), refuses what `bd` refuses (an unknown parent or id, a claim of a closed issue), answers `list` with `[]` and exits 2 for anything else. Ids are `e2e-<n>`, a child's `<parent>.<n>`.
  - Global setup (`global-setup.ts`) compiles it to `bd-stand-in/bin/bd` (`bd.exe` on Windows) in the run's home with `bun build --compile`, and stops the run when the build fails or the program does not answer. It is compiled because a hearth runs `bd` by name with an argument array, and only a real program of that name receives the arguments as they were given. Teardown removes that directory first and on its own (it is about 115 MB and nothing holds it open).
  - Both servers are started by bun's absolute path with a PATH of their own (`standInEnvironment` in `servers.ts`). The hearth's holds the stand-in's directory and nothing else: it can run no other `bd`, and `gh` is not found either. The dashboard's holds the stand-in's directory first, then node's (Vite's launcher needs it): a hearth the dashboard starts in place of the suite's inherits that and finds the stand-in. Playwright starts the servers before global setup; until the stand-in is built the hearth finds no `bd` at all.
  - At config load the suite refuses to start when node's directory, or a `node_modules/.bin` from the checkout up to the root of the drive (`bun run` puts those on the dashboard's PATH itself), holds a `bd` under any of its spellings. The message names the file. Run the suite with a node whose directory holds no `bd`.
  - A spec that writes calls `requireStandIn` first (`builders.spec.ts`): it reads `/queue` and requires the stand-in's own record to have grown by a `list` call. Every spec of a run shares that record, so compare it from a mark taken in the test and leave `list` calls out.
  - A test that acts on a bead creates it first through the page, so the stand-in knows it and each project's run has its own. A snapshot is only read when the page loads: after `stubSnapshot`, load the page afresh (`openIssues`).
- The issue views in a local run may be showing this checkout's own `docs/data/beads.json`; `bd` writes made elsewhere while the suite runs can also reload the page mid-test, because the dashboard watches `.beads/` and rebuilds the snapshot. Leave Beads alone until the run ends.

## Notes

- Counts, as of the Beads write path specs: 158 tests exist (79 per project). A normal run selects 138 (68 desktop, 70 mobile): the 18 captures are opt-in and the 2 mobile-only tests are left out of the desktop project. Recompute with `bun run verify:ui -- --list`, and with `SHOT_DIR` set to include the captures.
- What a green CI run does not prove. CI has no Beads snapshot and no forge run, so there: Dashboard, All issues, Epics and Insights render their "No snapshot loaded" state, and the real-API Forge run test takes its no-run branch. Populated states are covered only where a test serves a fixture. CI runs Chromium on Linux only.
- A failed CI run uploads `test-results/` (a trace per failed test and a screenshot of the page at failure) as the `playwright-test-results` artifact. Open a trace with `bunx playwright show-trace <trace.zip>`.
- `bun run lint` does not cover this directory. Keep new files clean with `bunx biome check <file>`.
- `bun test` does not collect these specs (`bunfig.toml` roots it at `scripts/`).
