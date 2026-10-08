# AGENTS.md — scripts/executors

Adapters that drive provider CLIs headlessly and turn their output into hearth events.

- `cli-adapter.ts` is the shared machinery; `claude.ts` / `codex.ts` supply flags and a line parser only.
- The prompt goes on **stdin**, never argv. Child env is built by `buildChildEnv` — never pass `process.env` through.
- Events are metadata only (hash of tool input, never the input). Validate with `scripts/hearth/validate.ts`.
- `EventSink` is the seam to the ledger. `sinks.ts` writes NDJSON until `scripts/ledger` exists; swap there.
- Tests use `fixtures/fake-cli.ts`; they prove plumbing, not real provider output. Re-verify flag and stream names
  against installed CLIs before trusting them (tracked in the follow-up bead).
- Adding an adapter: implement the spec, register in `registry.ts`, add it to `contract.test.ts`.
