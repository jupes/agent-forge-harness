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
- Tests must not write the real ledger under the user's home. Two things hold that: `test-preload.ts` points the test process (and any child that inherits its environment) at a temp `AGENT_FORGE_HOME`, and a test that hands a child its own environment must put a temp `AGENT_FORGE_HOME` in it — a scrubbed or allowlisted environment (the MCP stdio client builds one) drops the preload's setting and the child falls back to the OS home. `test-isolation.test.ts` checks this by re-running every test file that starts a process with the OS home pointed at a scratch directory and failing if `.agent-forge` appears there; it finds those files by scanning for spawn calls, so a process started some other way is not covered. A test that asserts on ledger contents creates its own temp ledger and passes its `path`.
- The quality gate (`.claude/hooks/quality-gate.ts`) appends `gate.ran` — and `verdict.bound` when its strict check read a verdict — from the builders in `scripts/quality-gate-ledger.ts`. The gate runs the test suite, so no test spawns it: the builders are tested and the call site is checked by running the gate.
- `verdict.bound` never carries an `evaluator`: verdict schema 1 does not name one, and nothing here invents it.
- Schema changes are a new entry appended to `MIGRATIONS` in `db.ts`; existing entries are never edited.
- `hook-events.ts` is what the Claude Code hook scripts (`.claude/hooks/ledger-hook.ts`, `.claude/hooks/session.ts`) call. Its handlers take the parsed stdin object and injected dependencies, store names, hashes and sizes only, and never throw into the host. A hook event with no known model carries no `executor` — never a placeholder.
- The hook tests in `hooks.test.ts` spawn the real scripts with a from-scratch environment (temp `AGENT_FORGE_HOME`, temp `HOME`/`USERPROFILE`, an empty `PATH`), so no live session id leaks in and neither `bd` nor `git` can run.

## Notes

- `bun test scripts/ledger` runs this directory's tests.
- `fixtures/` holds scripts that tests and `bench.ts` spawn as child processes; they are not entry points.
- `bun run scripts/ledger/bench.ts --hook 20` times the PostToolUse hook against a process that does nothing.
