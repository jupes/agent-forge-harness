# AGENTS.md — scripts\forge

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.
- `runs.ts`, `phases.ts` and `review-rules.ts` are bundled for the browser: no Node built-in and no import from `scripts/ledger/`. `review-rules.ts` imports only `./phases`.
- Ledger events are emitted from `ledger-events.ts`, which only the CLIs load, through a dynamic import inside their `import.meta.main` block. `phase-gate.ts`, `auto-loop.ts` and `runs-cli.ts` keep no static ledger import, because hooks and tests import their pure exports.
- Whether an auto run may move on is `reviewGate` and nothing else. There is no stored "halted" flag: a halt is the latest review round's recorded decision.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
