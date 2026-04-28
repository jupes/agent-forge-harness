# Plan: agent-forge-harness-u0x — Dashboard + bd export: P1 follow-ups from agent-forge-harness-az0

## Summary
Implement the P1 dashboard/export follow-ups so dependency and issue detail data from `bd export` are fully represented in the generated payload and visible in collapsed issue rows. This closes data parity gaps between Dolt export and legacy JSONL paths while preserving current dashboard behavior.

## Implementation Steps
1. Extend export-row normalization and dependency collection — `scripts/beads-dashboard.ts` — include `requires` and `relates` dependency edges and map agreed export fields (`due`, `estimate`, `spent`, `closed_by`) onto normalized issues.
2. Align TypeScript export-row contract — `scripts/beads-dashboard.ts` — expand `BdExportRow` to include the audited fields and alternative key spellings used by export output.
3. Show blocker IDs in collapsed rows — `docs/js/islands/IssuesViewsIsland.tsx` — compute active blocker IDs from `payload.deps` and show them inline for blocked rows in both Dashboard and All Issues tables.
4. Add/extend unit tests — `scripts/beads-dashboard.test.ts` — cover dependency-type collection and row normalization for due/estimate/spent/closedBy mappings and blocker detection assumptions.

## Files to Modify
| File | Change |
|------|--------|
| `scripts/beads-dashboard.ts` | Extend `BdExportRow`, normalize additional issue fields, and collect all supported dependency edge types. |
| `scripts/beads-dashboard.test.ts` | Add regression tests for dependency-type inclusion and export-field normalization. |
| `docs/js/islands/IssuesViewsIsland.tsx` | Render blocker IDs in summary rows for blocked issues without requiring expansion. |

## Files to Create
| File | Purpose |
|------|---------|
| None | — |

## Test Strategy
- Unit tests for: `normalizeBdExportRow`, `collectBlockDeps` (dependency edge collection), and `issuesAndDepsFromExportRows`.
- Integration-level check (script-level): `bun test scripts/beads-dashboard.test.ts` to validate payload transformations used by page build.
- Edge cases: mixed snake_case/camelCase export keys, closed blocker suppression, duplicate dependency edges, blocked issues with multiple blockers.

## Validation Commands
```bash
bun run typecheck
bun test scripts/beads-dashboard.test.ts
bun run lint
```

## Estimated Scope
- Files: 3
- Complexity: Medium
- Estimated time: 45 minutes

## Interfaces (if shared with other tasks)
```typescript
export interface BeadsDependency {
  from: string;
  to: string;
  type: "blocks" | "requires" | "relates";
}
```
