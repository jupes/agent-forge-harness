# AGENTS.md — scripts\ledger

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.
- `appendEvent` is the only writer of the `events` table. It never throws; emitters must not fail because the ledger could not be written.
- The ledger is metadata only. A new payload field needs an entry in `payload-allowlist.ts`. Every string `appendEvent` stores goes through the secret scanner (`scripts/secret-patterns.ts`), with two outcomes: payload strings and the executor's `provider`, `model`, `effort` and `smith` are stored redacted; `workspace`, `beadId`, `runId`, `sessionId` and a caller-supplied `ulid` are what events are joined on, so an event whose value the scanner would change is refused (`{ ok: false }`, nothing stored) rather than stored under a secret or a mangled id. `kind` and `ts` are validated, not scanned. The scanner only knows the shapes in its list, and leaves `sk-` alone inside an ordinary lowercase slug such as `task-queue-state-machine-v2` so ids like that stay queryable.
- `db.ts` imports `bun:sqlite`, which only loads under Bun. Nothing Vite loads under Node (`vite.dashboard.config.ts` and what it imports: `scripts/hearth/vite-plugin.ts`, `supervisor.ts`, `lock.ts`, `home.ts`) and nothing the dashboard bundles for the browser (`scripts/forge/runs.ts`, `scripts/forge/phases.ts`, `scripts/forge/review-rules.ts`, `scripts/council/discussion.ts`, `scripts/hearth/paths.ts`) may import from this directory at runtime; `scripts/council/ledger-events.test.ts` walks both graphs. The council service and workflow (`scripts/council/service.ts`, `workflow.ts`) run under Bun — in the CLI, the MCP server and the hearth — but still take the ledger by injection and import nothing from here.
- The directory the ledger lives in is resolved by `scripts/agent-forge-home.ts`, a leaf module the hearth shares (`scripts/hearth/home.ts`): the ledger owns `ledger.db` (and SQLite's `ledger.db-*` files), `backups/` and `hook-probe.jsonl` there; the hearth owns `hearth-<key>.lock` and `tokens/`.
- Tests must not write the real ledger under the user's home. Two things hold that: `test-preload.ts` points the test process (and any child that inherits its environment) at a temp `AGENT_FORGE_HOME`, and a test that hands a child its own environment must put a temp `AGENT_FORGE_HOME` in it — a scrubbed or allowlisted environment (the MCP stdio client builds one) drops the preload's setting and the child falls back to the OS home. `test-isolation.test.ts` checks this by re-running every test file that can start a process with the OS home pointed at a scratch directory and failing if `.agent-forge` appears there. It finds those files by a scan: a test file is in when it, or a module it loads through relative imports, names a spawn primitive (`Bun.spawn`, the Bun shell, `child_process`, the MCP stdio client), so a test that starts a hearth or an executor through a module is covered; a process started some other way is not. A test that asserts on ledger contents creates its own temp ledger and passes its `path`.
- The quality gate (`.claude/hooks/quality-gate.ts`) appends `gate.ran` — and `verdict.bound` when its strict check read a verdict — from the builders in `scripts/quality-gate-ledger.ts`. The gate runs the test suite, so no test spawns it: the builders are tested and the call site is checked by running the gate.
- `verdict.bound` never carries an `evaluator`: verdict schema 1 does not name one, and nothing here invents it.
- Schema changes are a new entry appended to `MIGRATIONS` in `db.ts`; existing entries are never edited.
- `resolveCheckout` (`workspace.ts`) spells a checkout by its real path on disk, so a Windows 8.3 short name or a link does not make one directory two workspaces. Emitters get `workspace` from it (through the hook context or `resolveAttach`); `appendEvent` and the query only normalise slashes and drive-letter case, so a `workspace` handed to them directly is stored as spelled.
- `hook-events.ts` is what the Claude Code hook scripts (`.claude/hooks/ledger-hook.ts`, `.claude/hooks/session.ts`) call. Its handlers take the parsed stdin object and injected dependencies, store names, hashes and sizes only, and never throw into the host. A hook event with no known model carries no `executor` — never a placeholder.
- `.claude/hooks/session.ts` takes its event from stdin `hook_event_name`, else from a `SessionStart` / `SessionEnd` token on its command line, else acts as SessionStart (a run by hand). The command-line token is what keeps a SessionEnd whose payload is missing or late from running the SessionStart path; the registration in `.claude/settings.json` does not pass the token yet, so until it does that case still falls through to SessionStart.
- The hook tests in `hooks.test.ts` spawn the real scripts with a from-scratch environment (temp `AGENT_FORGE_HOME`, temp `HOME`/`USERPROFILE`, an empty `PATH`), so no live session id leaks in and neither `bd` nor `git` can run.

## Notes

- `bun test scripts/ledger` runs this directory's tests.
- `forge:audit` cuts a result at `--limit` (default 500) and says so in one stderr line; the `--json` envelope's `data` is always the array of events and never carries the note. The cut itself is `queryEventPage` in `query.ts`, shared with the hearth's `GET /events`, which also takes its filter rules from `parseAuditArgs`: a new `forge:audit` flag does not reach the API until it is added to the route's own list.
- `query.ts` also holds the reads the hearth serves: `listSessions` (bounded to the newest 50,000 events of a workspace; one pass, then lookups by primary key — a per-session `ORDER BY id DESC` makes SQLite walk the workspace index), `activeReservations` (through the kind index, for the same reason) and `latestEventId`.
- `fixtures/` holds scripts that tests and `bench.ts` spawn as child processes; they are not entry points.
- `bun run scripts/ledger/bench.ts --hook 20` times the PostToolUse hook against a process that does nothing.
