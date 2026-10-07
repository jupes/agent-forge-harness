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

An Evaluator must be at **≥** the rank that produced the output under review. Write the grader's rank (and smith, when
known) into the verdict `summary` (`.tmp/work/<TASK-ID>-verdict.json`). Same-rank grading is acceptable only for purely
mechanical checks such as JSON shape conformance. This rule is still enforced by convention and the Evaluator Agent;
the config only makes the ranks concrete.

## Out of scope

Provider pricing, automatic model selection beyond the bench pick, and OS-level sandboxing (the env allowlist and
worktree isolation are the containment on Windows).
