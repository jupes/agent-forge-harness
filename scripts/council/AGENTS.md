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
- A bead source (`bead-source.ts`) packs one bead, the one its caller names in full, and nothing implicitly: `bd` is run only as `bd --readonly show <id> --json` and `bd --readonly comments <id> --json`, after `parseBeadsIssueId` has accepted the id and never before; the issue `bd` answers with must carry that exact id. Of a dependency only the id and type are packed. The PR packer is called with `linkedCriteria: false`, so the beads a PR body names are not read. No code path writes to the tracker.
- What a bead source may pack is a fixed list: id, title, type, priority, status, labels, dependency ids and types, acceptance criteria, each comment's timestamp and text, description, design and notes. Never owner, assignee, author or any other field. Adding a field is a decision for the owner, recorded on the bead.
- Parts of a bead survive the evidence budget in this order: acceptance criteria, latest comments newest first, description, linked plan/research/report, pull request. `buildContextPackFromParts` scans every chunk and every label in full before anything is cut — a part the budget drops is still scanned — and a hit refuses the source naming the part, never the match. The sum of evidence bytes never exceeds `maxBytes`.
- A linked file is read only when its path, and the real path it resolves to, is a Markdown file under `plans/research/`, `plans/drafts/`, `plans/committed/`, `docs/plans/` or directly inside `reports/`. Nothing under `reports/council-runs/` is ever linked: those reports embed the evidence of earlier runs.
- A pull request is fetched only when the parsed mention is `https://<origin host>/<origin owner>/<origin repo>/pull/<n>` with no userinfo and no port, and `gh` is handed a URL rebuilt from the origin and the number. The origin remote's text is parsed and then dropped: it never appears in a listing line, an error, a title or metadata.
- The listing (`source.metadata.parts`, `contextListing`) has one line per part considered and is what an operator sees before a provider is called: the CLI prints it (dry run, and stderr before a real bead run) and the engine's `run.started` event carries it for `council_status`. It is not rendered into prompts.
- Tests for a bead source hand in a fake command runner (`runner` on `prepareCouncilContext`, `runCommand` on the CLI io) or a stand-in service (`service` on the MCP options). No test runs the real `bd`, `git remote` or `gh`, and fixtures are invented, never copied from the tracker.
- The finished event is appended from a `finally`, so every started event gets one. The ledger stores the outcome, the cost and the chair's summary — never seat outputs, findings or the reviewed text. `--dry-run` creates no run and records nothing.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
