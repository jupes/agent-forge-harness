# Plan: agent-forge-harness-ajj — Create epic flow view: children connections and summarized changes

## Summary
Add a dedicated epic flow view in the docs dashboard so users can select an epic, see child issue relationships, and quickly understand completed work via condensed change summaries. This extends existing Beads payload + dashboard rendering with graph-oriented derived data and a focused UI panel that emphasizes dependency flow and recent outcomes.

## Implementation Steps
1. Define epic flow derived data contracts — `types/beads.ts` — add typed structures for epic child graph nodes, edges, and summary fields.
2. Build derived-flow helpers from current issues/deps/comments — `scripts/beads-dashboard.ts` — compute child set, relationship edges, and summary snippets per child.
3. Add unit tests for flow derivation behavior — `scripts/beads-dashboard.test.ts` — cover ordering, edge inclusion, and summary extraction edge cases.
4. Render epic flow UI section — `docs/js/islands/IssuesViewsIsland.tsx` — add an epic-focused panel/table/flow list using derived data with clear status and connection cues.
5. Wire data consumption in page shell if needed — `docs/js/app.mjs` and/or `docs/js/issues-selection.mjs` — ensure selected initiative/epic drives the new flow view reliably.
6. Add/adjust UI-level tests or deterministic snapshot assertions where available — `scripts/issues-selection.test.ts` or adjacent tests.

## Files to Modify
| File | Change |
|------|--------|
| `types/beads.ts` | Add types for epic flow model and payload extension fields. |
| `scripts/beads-dashboard.ts` | Compute epic child flow data and summary extraction from comments/status/deps. |
| `scripts/beads-dashboard.test.ts` | Add tests for graph and summary derivation logic. |
| `docs/js/islands/IssuesViewsIsland.tsx` | Render epic flow section, including child connections and summary text. |
| `docs/js/app.mjs` | Pass through or initialize state needed by epic flow panel. |
| `docs/js/issues-selection.mjs` | Reuse or extend epic/child filtering helpers for flow view selection. |

## Files to Create
| File | Purpose |
|------|---------|
| `docs/js/islands/EpicFlowView.tsx` (optional) | Isolate epic flow rendering logic if island file complexity grows. |

## Test Strategy
- Unit tests for derived flow builders:
  - Child inclusion under selected epic.
  - Dependency edge direction and deduplication.
  - Summary extraction preference order (review/worklog/description fallback).
- Integration-level checks for dashboard rendering:
  - Initiative filter updates epic flow section.
  - Empty-state handling when epic has no children.
- Edge cases:
  - Child issues missing comments.
  - Mixed dependency types (`blocks`, `requires`, `relates`) where only relevant links should appear.
  - Closed blockers should not be displayed as active blockers in flow context.

## Validation Commands
```bash
bun run typecheck
bun test scripts/beads-dashboard.test.ts
bun test scripts/issues-selection.test.ts
bun run build:pages
```

## Estimated Scope
- Files: 6-7
- Complexity: Medium
- Estimated time: 90 minutes

## Interfaces (if shared with other tasks)
```typescript
export interface EpicFlowNode {
  issueId: string;
  title: string;
  status: IssueStatus;
  type: IssueType;
  summary: string;
  blockers: string[];
}

export interface EpicFlowEdge {
  from: string;
  to: string;
  relation: "blocks" | "requires" | "relates";
}
```
