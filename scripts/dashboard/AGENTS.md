# AGENTS.md — scripts\dashboard

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.

## Notes

- `use-stream.test.ts` covers the dashboard's stream client: the state rules of `docs/js/app-state.ts`, the client of `docs/js/use-stream.ts` on a stand-in transport with stand-in timers (nothing in it waits on the real clock), the fetch transport on a stand-in `fetch`, and three tests against a real hearth (`startTestHearth`) for what a stand-in cannot show: that a resume carries the last id and the server then sends no second snapshot, that the sessions and reservations folded from events equal what the hearth's own routes answer, and that a route which is not a stream turns live updates off after one request. Hooks are not run here (there is no DOM); the logic they call is in `createStreamClient`, `createRefetcher` and `startLiveRead`, which are. The page itself is exercised in `tests/e2e/live-stream.spec.ts`.
- Do not use bun's fake timers for these tests: the per-test timeout is faked with them. Pass a `Timers` stand-in to the client instead.
- `rebuild-pages.test.ts` runs a real Vite dev server with `rebuildPagesPlugin` and a stand-in build (a small script that waits for the test to write a `release` file), never `scripts/build-pages.ts` or bd. A build that blocked the server's thread could never be released, which is what those tests detect. Give each server a port the system just handed out (`freePort`), not port 0: Vite reads 0 as 5173 or the next free one, a range other dev servers on this machine use.
- `POST /__agent-forge/rebuild-pages` is answered only for a loopback peer (`isLoopbackAddress` from `scripts/hearth/gate.ts`, the check `guardRequest` uses), before the method is looked at: the hearth's guard does not cover it, because Vite answers it without the proxy. Its test sends a real request from source address `127.0.0.2` through a Node child process (Bun ignores `localAddress`), which the check counts as another machine; it is skipped where `node` is not on PATH.
