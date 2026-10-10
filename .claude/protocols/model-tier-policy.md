# Model-tier policy

Which model does which work is **data**, not convention. It lives in `agent-forge.toml` (workspace) and
`~/.agent-forge/config.toml` (machine), merged with provenance:

```bash
bun run forge:config show                 # smiths, benches, env allowlist, and where each value came from
bun run forge:config get workflow.default_crew
bun run forge:config keys
```

Template: `agent-forge.toml.example`. Contracts: `types/hearth.ts` (`Smith`, `Rank`, `BenchName`).

## Vocabulary

| Term | Meaning |
|------|---------|
| **Smith** | A named `{ provider, model, effort, enabled, tags }` — who does the work (`claude-journeyman`) |
| **Rank** | `master` / `journeyman` / `apprentice` — the policy level (replaces Top / Default / Cheap); carried as a `rank:*` smith tag |
| **Bench** | Weighted smiths for one complexity class: `[benches] low = ["claude-apprentice:70", "codex-journeyman:30"]` |

Built-in smiths: `claude-master` (high effort), `claude-journeyman` (default), `claude-apprentice` (cheapest),
`codex-journeyman`. Default smith: `claude-journeyman`.

## Resolution order

`--smith` flag → bead `smith` metadata → bench by the bead's `complexity:*` label (stable weighted pick per bead id)
→ `workflow.default_crew` → `claude-journeyman` (`scripts/config/resolve.ts`). An unknown or disabled smith is an
error, never a silent fall-through.

## Running a smith

`bun run forge:exec --bead <id> --smith <name> --worktree <path> --prompt <text>` runs one bounded task through the
smith's provider CLI (`scripts/executors/`). Spawned processes get only the base environment plus
`[execution.env] pass`; nothing else from the parent environment reaches them. `bun run forge:doctor` reports which
provider CLIs are installed.

## When to use which rank

- **master** — novel architecture, ambiguous requirements, contracts in `.claude/protocols/interfaces.md`, and
  **graders** of master-built work.
- **journeyman** — most feature/fix work once aligned; writing tests in well-covered code.
- **apprentice** — mechanical edits, doc phrasing passes, `bd` metadata updates, lint autofixes.

## Escalation

Move up a rank at the first clear sign: a Blocker/High evaluator finding (repair at ≥ the builder's rank, escalate to
master if a second pass fails), AC drift (move alignment back to master), more than two fix attempts on one check, or a
multi-file change that exposes a cross-cutting interface. Never escalate silently: leave a `worklog:` Beads comment with
the new smith and why.

## Grader ≥ subject

An Evaluator must be at **≥** the rank that produced the output under review. A filed verdict records it
(`.claude/protocols/evaluation-verdict.md`): the provider, model and rank that were requested, the provider and model
that were observed to run, and the rank-policy decision with its rule.

In strict mode (`AGENT_FORGE_EVAL_VERDICT=strict`) the quality gate enforces the rule on the observation the verdict
records, never on the request: a model evaluator must have been observed, and its observed rank must be at or above the
builder's. The observation is the model of the session that filed the verdict, and a verdict filed from the session
that built the work records none: an Evaluator subagent shares its spawner's session, so a subagent's own model is not
observed (`.claude/protocols/evaluation-verdict.md`, *Limits*). A
provider and model have a rank through the `rank:*` tag of the smiths configured with them; when smiths of different
ranks share a model, the evaluator is read at the lowest and the builder at the highest. The builder is the executor
stored on the run's state; with no builder whose rank is known, only a master evaluator passes. A human verdict is
taken on its actor kind.

Outside strict mode the rule is held by convention and the Evaluator Agent. The gate accepts an equal rank; by
convention same-rank grading is for purely mechanical checks such as JSON shape conformance.

## Out of scope

Provider pricing, automatic model selection beyond the bench pick, and OS-level sandboxing (the env allowlist and
worktree isolation are the containment on Windows).
