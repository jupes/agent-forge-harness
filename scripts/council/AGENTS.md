# AGENTS.md — scripts\council

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.
- `dashboard.ts`, `service.ts`, `workflow.ts` and `ledger-events.ts` are loaded by Vite under Node, where the event ledger's SQLite driver does not exist. They never import `scripts/ledger/` or `ledger-wiring.ts`, statically or dynamically; `ledger-events.test.ts` walks the import graph to hold that.
- A council run records `council.run.started` and `council.run.finished` only when the caller injects `appendEvent` and an attach (`executeCouncilReview`) or `appendEvent` and `resolveAttach` (the CLI io, the service options). `ledger-wiring.ts` supplies the real ones, and only `cli.ts` and `mcp.ts` load it, through a dynamic import in their `import.meta.main` block. Runs started from the dashboard record nothing.
- The finished event is appended from a `finally`, so every started event gets one. The ledger stores the outcome, the cost and the chair's summary — never seat outputs, findings or the reviewed text. `--dry-run` creates no run and records nothing.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
