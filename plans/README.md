# Plans storage contract

All durable plan artifacts live under the harness-root `plans/` directory.

## Directory layout

- `plans/drafts/` — latest in-progress plan for each issue.
- `plans/committed/` — committed baseline snapshots used for diff/review.

## Naming

Use issue IDs when available so files map cleanly to Beads and UI state:

- Draft: `plans/drafts/<ISSUE-ID>.md`
- Baseline snapshot: `plans/committed/<ISSUE-ID>.md`

Examples:

- `plans/drafts/agent-forge-harness-mk4.md`
- `plans/committed/agent-forge-harness-mk4.md`

If no issue ID exists yet, use a stable slug and replace it with the issue ID once created.

## Ownership and lifecycle

- Commands/workflows that generate implementation plans should write to `plans/drafts/`.
- Committed snapshots in `plans/committed/` should reflect the latest reviewed/accepted baseline in git history.
- Ephemeral handoff/alignment/verdict artifacts stay in `.tmp/work/`; they are not part of this durable plan contract.

## Transient files

Do not commit editor temp files in `plans/drafts/` (see root `.gitignore` rules).

## Session context (plan review auto-follow)

Optional **local-only** file `plans/session-context.json` (gitignored) tells the dashboard **Plan review** page which plan id is currently under discussion:

```json
{
  "activePlanId": "agent-forge-harness-mk4",
  "updatedAt": "2026-04-27T12:00:00.000Z"
}
```

Copy `session-context.json.example` and rename to `session-context.json`. Agents or tooling can overwrite `activePlanId` while work moves between tasks. The dashboard polls this file while `bun run dashboard` is running.
