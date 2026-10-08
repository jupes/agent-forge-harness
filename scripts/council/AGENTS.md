# AGENTS.md — scripts\council

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.
- `service.ts`, `workflow.ts` and `ledger-events.ts` never import `scripts/ledger/` or `ledger-wiring.ts`, statically or dynamically: a run reaches the ledger only through the functions its caller hands it. `ledger-events.test.ts` walks the import graph to hold that, and holds the same for what Vite loads under Node (`vite.dashboard.config.ts` and the hearth plugin it imports — the SQLite driver does not exist there) and for what the dashboard bundles for the browser (`discussion.ts`).
- A council run records `council.run.started` and `council.run.finished` only when the caller injects `appendEvent` and an attach (`executeCouncilReview`) or `appendEvent` and `resolveAttach` (the CLI io, the service options). `ledger-wiring.ts` supplies the real ones, and only `cli.ts` and `mcp.ts` load it, through a dynamic import in their `import.meta.main` block. Runs started from the dashboard record nothing: its council routes are served by the hearth (`scripts/hearth/server.ts`, a Bun process the dashboard proxies to), and `createHearth` builds its service without an appender.
- The finished event is appended from a `finally`, so every started event gets one. The ledger stores the outcome, the cost and the chair's summary — never seat outputs, findings or the reviewed text. `--dry-run` creates no run and records nothing.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
