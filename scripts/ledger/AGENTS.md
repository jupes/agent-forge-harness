# AGENTS.md — scripts\ledger

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.
- `appendEvent` is the only writer of the `events` table. It never throws; emitters must not fail because the ledger could not be written.
- The ledger is metadata only. A new payload field needs an entry in `payload-allowlist.ts`, and every stored string passes through redaction.
- `db.ts` imports `bun:sqlite`, which only loads under Bun. Modules that Vite loads under Node or bundles for the browser (`scripts/council/workflow.ts`, `scripts/council/service.ts`, `scripts/forge/runs.ts`, `scripts/forge/phases.ts`, `scripts/forge/review-rules.ts`) must not import from this directory at runtime.
- Tests never touch the real ledger under the user's home. `test-preload.ts` points the test process at a temp `AGENT_FORGE_HOME`; a test that asserts on ledger contents creates its own temp ledger and passes its `path`, and a spawned script gets `AGENT_FORGE_HOME` in its environment.
- Schema changes are a new entry appended to `MIGRATIONS` in `db.ts`; existing entries are never edited.

## Notes

- `bun test scripts/ledger` runs this directory's tests.
- `fixtures/` holds scripts that tests spawn as child processes; they are not entry points.
