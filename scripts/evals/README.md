# Evaluator calibration harness

Promptfoo-driven check for the Agent Forge **Evaluator Agent**. Follows the pattern from [`gastownhall/gastown/gt-model-eval`](https://github.com/gastownhall/gastown/tree/main/gt-model-eval): feed a fixed task spec + candidate output into an Evaluator model and assert the returned **verdict JSON** matches the expected shape and severity counts.

Informs follow-ups to `.claude/protocols/model-tier-policy.md` (grader ≥ subject) and `.claude/protocols/evaluation-verdict.md` (JSON schema v1).

## Why this exists

Today's evaluator is a **prompt** — there's no way to know if a given model follows the rubric. This harness lets you:

- Compare evaluator models (grader candidates) against fixed fixtures.
- Regression-test the `.claude/agents/evaluator.md` + `.claude/protocols/evaluation-verdict.md` contract when you change either.
- Gather latency / cost evidence to justify picking a cheaper grader when it holds.

## Prerequisites

- `ANTHROPIC_API_KEY` in env.
- `promptfoo` — installed on demand via `npx promptfoo`. **Not** pinned as a harness dependency; run ad hoc.

## Run

```bash
bun run evals:calibrate
# internally: npx --yes promptfoo eval --config scripts/evals/promptfooconfig.yaml
```

For richer comparisons:

```bash
npx --yes promptfoo eval --config scripts/evals/promptfooconfig.yaml --repeat 3
npx --yes promptfoo view   # opens browser
```

## Fixtures (`tests/verdict-cases.yaml`)

Three cases, one per gate outcome the strict hook cares about:

| Case | Expected `verdict` | Expected `blocker` / `high` | Gate verdict |
|------|--------------------|-----------------------------|--------------|
| `pass` | `PASS` | `0 / 0` | PASS — ship allowed |
| `fail-blocker` | `FAIL` | `≥1 / ≥0` | FAIL — ship blocked |
| `fail-medium-only` | `FAIL` | `0 / 0` | PASS — file follow-ups |

Each test supplies a short `task_spec` and a fake `candidate_output`. The system prompt (`prompts/evaluator-verdict.txt`) tells the model to emit the JSON in `.claude/protocols/evaluation-verdict.md` schema v1.

## Assertions

`scripts/evals/assertions.ts` provides reusable JavaScript assertion helpers used by `promptfooconfig.yaml`. They reuse `scripts/eval-verdict.ts`'s parser so the same schema rules apply here and in the quality-gate hook.

Unit tests live next to the helpers (`assertions.test.ts`) and run under the normal `bun test scripts` suite — no `promptfoo` install required for lint / tests.

## Tier & thresholds

Per `.claude/protocols/model-tier-policy.md`, grader ≥ subject. Default config here grades with Claude Opus over Sonnet output. Starting budget, borrowed from `gt-model-eval`:

- `cost` ≤ **$0.10** / test
- `latency` ≤ **15 s** / test

Tune these when you widen the fixture set or add cheaper graders.

## When to regenerate fixtures

Change fixtures only when:

- `.claude/protocols/evaluation-verdict.md` schema changes.
- `.claude/agents/evaluator.md` rubric shifts materially.
- You add a new severity axis (e.g. `attestations`) that should be measured.

Otherwise treat fixtures as a stable regression set.
