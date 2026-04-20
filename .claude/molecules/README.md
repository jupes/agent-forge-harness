# Molecules

Workflows **as data** — an analog of Gas Town's **molecules** (chained Beads steps, loops, gates). See `knowledge/gas-town-harness-insights.yaml` → `MO-01-formulas-as-skills`.

This directory is a **spike** (bead `agent-forge-harness-9z1`). Format is JSON today for portability and zero new deps; the same shape can later be sourced from TOML/YAML (“Formulas”) and macro-expanded into per-step Beads tasks.

## Why data, not markdown?

`.claude/workflows/*.md` are readable but not enumerable. A molecule file is:

- **Machine checkable** (see `scripts/molecules/parse.ts`)
- **Composable** (`depends_on` DAG across steps)
- **Round-trippable** to Beads (`step.id` → candidate `bd` task title; `step.depends_on` → `bd dep add`)

## Schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "id": "feature-delivery",                 // kebab-case, unique
  "title": "Feature delivery molecule",
  "description": "Plan → Build → Evaluate → Ship",
  "steps": [
    {
      "id": "plan",                         // unique within molecule
      "title": "Plan",
      "agent": "worker",                    // lead | worker | evaluator | user
      "produces": ["alignment-doc"],         // opaque artifact names
      "consumes": [],                        // artifacts this step reads
      "depends_on": [],                      // other step ids
      "gate": null                           // optional; see gates below
    }
  ]
}
```

### Gates (optional)

A step may carry a gate that the harness already enforces elsewhere. Allowed `kind`:

| `kind` | Enforcer | Meaning |
|--------|----------|---------|
| `"quality-gate"` | `.claude/hooks/quality-gate.ts` | Core checks (typecheck, lint, tests, clean tree) |
| `"eval-verdict"` | `scripts/eval-verdict.ts` + strict hook | `.tmp/work/<TASK-ID>-verdict.json` PASS or only medium/low |

The parser validates shape only; runtime enforcement stays with the existing hooks.

## Rules

1. `steps[].id` unique per molecule; `depends_on` must reference known step ids.
2. DAG only — cycles are rejected.
3. `produces`/`consumes` are free-form strings; used for documentation and future dependency inference.
4. `agent` is an advisory role label; Lead still decides actual dispatch.

## Validating

```bash
bun run molecules:check                       # validate every *.json here
bun run molecules:check feature-delivery.json # single file
```

Emits a `{ ok, data, error }` JSON envelope per file; exits non-zero on any failure.

## Non-goals (spike)

- No runtime/executor — Lead still drives workflows.
- No automatic `bd create` / `bd dep add` emission. Captured as a follow-up idea in the Gas Town knowledge YAML.
- No TOML ingestion. JSON keeps the first cut dependency-free.
