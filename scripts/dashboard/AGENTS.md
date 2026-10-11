# AGENTS.md — scripts\dashboard

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.

## Notes

- `use-stream.test.ts` covers the dashboard's stream client: the state rules of `docs/js/app-state.ts`, the client of `docs/js/use-stream.ts` on a stand-in transport with stand-in timers (nothing in it waits on the real clock), the fetch transport on a stand-in `fetch`, and two tests against a real hearth (`startTestHearth`) for what a stand-in cannot show: that a resume carries the last id and the server then sends no second snapshot. Hooks are not run here (there is no DOM); the logic they call is in `createStreamClient`, `createRefetcher` and `startLiveRead`, which are. The page itself is exercised in `tests/e2e/live-stream.spec.ts`.
- Do not use bun's fake timers for these tests: the per-test timeout is faked with them. Pass a `Timers` stand-in to the client instead.
