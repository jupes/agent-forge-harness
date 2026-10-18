# Plan: x1gs.3.37 — discover every live dashboard for a root

## Summary

Give every Vite server a random registration identity, including servers in the same process. Discover checked registrations for the requested root and require explicit `--url` selection when several distinct literal-loopback addresses remain.

## Implementation Steps

1. Prove two same-process Vite servers overwrite one another on the baseline.
2. Add an optional instance suffix to `dashboardRecordPath`; each server owns one never-reused filename and removes only that file when it closes.
3. Enumerate strictly matching filenames, read each with `readHomeFile`, validate stored root and PID, canonicalize with `launchBase`, and deduplicate/sort addresses. Refuse ambiguity before any lock/token read or exchange.
4. Keep legacy singleton compatibility and explicit URL selection. Retain dead files physically, excluding them from discovery: safe handle-relative housekeeping is separate work, approved by the lead to avoid unsafe path-based unlink.
5. Verify focused integration tests, typecheck, lint, and CI full suites; obtain a fresh evaluator review.

## Files to Modify

| File | Change |
| --- | --- |
| scripts/hearth/home.ts | Optional random instance suffix |
| scripts/hearth/vite-plugin.ts | Per-server publication and owner cleanup |
| scripts/hearth/dashboard-open.ts | Checked multi-record discovery and explicit ambiguity |
| scripts/hearth/vite-plugin.test.ts | Same-process lifecycle regression |
| scripts/hearth/dashboard-open.test.ts | Discovery, trust boundaries, ambiguity and compatibility |
| scripts/hearth/AGENTS.md | Actual registration and selection contract |

## Test Strategy

Baseline red: two Vite servers in one process must retain two registrations. Green: closing one preserves the other. Discovery tests cover dead records retained but ignored, legacy deduplication, invalid/foreign root records, unsafe reads, ambiguity without exchange, and explicit selection. Existing launch/guard and Node import tests remain relevant.

## Validation Commands

```sh
bun test scripts/hearth/dashboard-open.test.ts scripts/hearth/vite-plugin.test.ts
bun test scripts/council/ledger-events.test.ts
bun run typecheck
bun run lint
```

## Estimated Scope

Seven files including this plan; medium complexity. Lead approved up to 350 changed lines. No public API changes beyond the optional path-helper argument. No token/session protocol changes.
