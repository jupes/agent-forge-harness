# Evaluation verdict artifact (strict gate)

Optional machine-readable output from an **Evaluator** pass, used when **`AGENT_FORGE_EVAL_VERDICT=strict`** is set (see `.claude/hooks/quality-gate.ts`). Aligns with Gas Town–style separation of **generation vs verification**: the worker produces code; the evaluator records a structured verdict that the harness can gate on.

## File location

```
.tmp/work/<TASK-ID>-verdict.json
```

`<TASK-ID>` is the Beads id (same as `CLAUDE_TASK_ID` when hooks run under a claimed task). The `.tmp/` tree is gitignored; the file is **not** committed.

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
| `taskId` | yes | Non-empty string; must match the Beads task id and `CLAUDE_TASK_ID` when strict mode runs |
| `verdict` | yes | `"PASS"` or `"FAIL"` |
| `findings.*` | yes | Non-negative integers: `blocker`, `high`, `medium`, `low` |
| `summary` | no | String |

## Strict gate behavior

When `AGENT_FORGE_EVAL_VERDICT=strict` and `CLAUDE_TASK_ID` is set:

- The verdict file **must** exist and parse under this schema.
- **`verdict: "PASS"`** → gate passes.
- **`verdict: "FAIL"`** with **`blocker > 0` or `high > 0`** → gate **fails** (same bar as `.claude/workflows/feature.md` “FAIL — BLOCKER / HIGH”).
- **`verdict: "FAIL"`** with only medium/low → gate **passes** (file follow-up beads; matches feature workflow “MEDIUM/LOW only → proceed”).

When the env var is unset or not `strict`, the hook **does not** require this file.

## Human vs model evaluator

This file can be written by a human after review or produced from an Evaluator model session. The harness only validates shape and the B/H rule above.

## Related

- `.claude/agents/evaluator.md` — verdict steps and severity definitions  
- `.claude/protocols/evaluation-rubric.md` — dimensions and skepticism rules  
- `.claude/workflows/feature.md` — Step 8 Evaluator review, acting on verdict  
