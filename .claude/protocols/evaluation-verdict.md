# Evaluation verdict artifact (strict gate)

Optional machine-readable output from an **Evaluator** pass, used when **`AGENT_FORGE_EVAL_VERDICT=strict`** is set (see `.claude/hooks/quality-gate.ts`). Aligns with Gas Town–style separation of **generation vs verification**: the worker produces code; the evaluator records a structured verdict that the harness can gate on.

## File location

```
.tmp/work/<TASK-ID>-verdict.json
```

`<TASK-ID>` is the Beads issue id: in strict mode, the `beadsIssueId` of the run correlation the quality gate is given (`.claude/protocols/agent-onboarding.md`, *Run correlation*). The `.tmp/` tree is gitignored; the file is **not** committed.

## Schema (version 1)

```json
{
  "schemaVersion": 1,
  "taskId": "agent-forge-harness-uam",
  "verdict": "PASS",
  "findings": {
    "blocker": 0,
    "high": 0,
    "medium": 2,
    "low": 1
  },
  "summary": "Optional short rationale."
}
```

| Field | Required | Rules |
|-------|----------|--------|
| `schemaVersion` | yes | Must be `1` |
| `taskId` | yes | Non-empty string; must match the Beads issue id, which in strict mode is the `beadsIssueId` of the gate's run correlation |
| `verdict` | yes | `"PASS"` or `"FAIL"` |
| `findings.*` | yes | Non-negative integers: `blocker`, `high`, `medium`, `low` |
| `summary` | no | String |
| `attestations` | no | Object with integer scores `0..5` for any subset of `quality`, `reliability`, `creativity`, `maintainability`, `ux`. Informational — never blocks ship. Unknown keys are rejected. |

### Attestations (optional, Wasteland-style stamps)

```json
{
  "schemaVersion": 1,
  "taskId": "agent-forge-harness-k1y",
  "verdict": "PASS",
  "findings": { "blocker": 0, "high": 0, "medium": 1, "low": 0 },
  "attestations": { "quality": 4, "reliability": 5, "creativity": 3 }
}
```

These are **advisory** multi-axis signals. The strict gate still only looks at `verdict` + `findings.blocker|high`. Dashboards and future analytics can chart these dimensions; evaluators may populate whichever apply to the task.

## Strict gate behavior

When `AGENT_FORGE_EVAL_VERDICT=strict`, on a `TaskCompleted` run of the gate:

- The gate **must** have been given a run correlation naming the Beads issue: create one with `bun run forge:correlate --bead <TASK-ID>` (a Forge run gets one from `forge:phase-gate … --write --bead <TASK-ID>`), then run `bun run quality-gate --correlation <pointer>` with the `pointer` that command printed. A launcher can instead set `AGENT_FORGE_RUN_CORRELATION` for the process it starts. Without a correlation the check fails: an uncorrelated run cannot satisfy strict completion.
- The verdict file **must** exist and parse under this schema.
- **`verdict: "PASS"`** → gate passes.
- **`verdict: "FAIL"`** with **`blocker > 0` or `high > 0`** → gate **fails** (same bar as `.claude/workflows/feature.md` “FAIL — BLOCKER / HIGH”).
- **`verdict: "FAIL"`** with only medium/low → gate **passes** (file follow-up beads; matches feature workflow “MEDIUM/LOW only → proceed”).

When the env var is unset or not `strict`, the hook **does not** require this file. A `TeammateIdle` run never reads it, so a passing `TeammateIdle` says nothing about strict completion.

## Human vs model evaluator

This file can be written by a human after review or produced from an Evaluator model session. The harness only validates shape and the B/H rule above.

## Related

- `.claude/agents/evaluator.md` — verdict steps and severity definitions  
- `.claude/protocols/evaluation-rubric.md` — dimensions and skepticism rules  
- `.claude/workflows/feature.md` — Step 8 Evaluator review, acting on verdict  
