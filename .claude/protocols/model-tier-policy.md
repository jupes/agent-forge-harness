# Model-tier policy

Guidance for routing harness work to the cheapest model that still clears quality for that work. Informed by Yegge's `gt-model-eval` (Promptfoo comparison of Opus / Sonnet / Haiku on patrol decisions) — see `knowledge/gastown-code-archaeology.yaml` → `gt_model_eval`.

This is **convention**, not automation. Cursor / Claude Code / CLI already expose model selection; this doc tells humans and agents **which tier to pick** and when to escalate.

---

## Tiers

Three abstract tiers. Map them to whatever your client exposes (Claude Opus/Sonnet/Haiku, GPT-5 Large/Medium/Small, Gemini 2.5 Pro/Flash/Nano, etc.):

| Tier | Typical role | Good for |
|------|--------------|----------|
| **Top** | Largest / strongest reasoning model available | Novel architecture, multi-file refactors, ambiguous requirements, **graders** (see below), final evaluators on shipping-quality PRs |
| **Default** | Mid-tier model (strong at instruction following, good coder) | Most feature/fix work once aligned, single-file edits in familiar code, routine script changes |
| **Cheap** | Smallest fast model | Mechanical edits, narrow text substitutions, trivial triage, deterministic YAML/JSON fixes, quick `bd` metadata updates |

---

## When to use which

**Top tier is required for:**

- **Evaluators / graders** — an evaluator must be **≥** the tier that produced the output under review (the `gt-model-eval` grader principle). Reviewing an Opus-built change with Haiku is a false positive machine.
- **Initial `/plan` or alignment** on anything touching ≥ 3 files or any new architecture.
- Tasks where acceptance criteria are incomplete and judgment is part of the work.
- Writing or modifying contracts in `.claude/protocols/interfaces.md`.

**Default tier fits:**

- A claimed task with a clear alignment doc / AC.
- A fix-tier change (≤ 3 files, clear scope).
- A sub-repo `AGENTS.md` / `CONTRIBUTING.md`-guided implementation.
- Writing tests next to existing well-covered code.

**Cheap tier is appropriate for:**

- A one-file rename across call sites once scope is locked.
- Comment / docstring / markdown phrasing passes.
- `bd` metadata edits (priority, labels, comments) that don't need reasoning.
- Formatting, lint autofixes, and other mechanical corrections.

---

## Escalation — when cheaper isn't holding

Switch up a tier at the first clear sign:

1. **Blocker or High finding from the evaluator.** Repair passes should use at least the tier of the original build; escalate once to Top if a second pass still fails.
2. **AC drift during implementation.** If the worker keeps finding the spec is wrong, stop and move the **alignment** step back to Top tier.
3. **`> 2 fix attempts` on the same check** (per `.claude/workflows/fix.md` Hard stop conditions). Escalate rather than flail.
4. **Multi-file refactor reveals a cross-cutting interface.** Promote to Feature and swap to Top for the contract write-up.

Never silently escalate: leave a `worklog:` Beads comment noting the tier change and why so future session / triage can audit cost.

---

## Grader ≥ subject rule

For any **Evaluator Agent** pass (see `.claude/agents/evaluator.md`) and any automated eval harness (future `scripts/evals/…` — GT-REC-01):

- If subjects ran on Default tier, the grader must be **≥ Default**, typically Top.
- If subjects ran on Top tier, the grader stays on Top. A same-tier grader is acceptable only when the task is purely mechanical (e.g. JSON shape conformance).
- Write the grader's tier into the review / verdict output so it's auditable (free-form `summary` in `.tmp/work/<TASK-ID>-verdict.json` is fine until schema v2 formalizes it).

---

## Cost + latency thresholds

If you run an actual cost/latency eval (see GT-REC-01 follow-up), `gt-model-eval` uses `cost ≤ $0.10 / test` and `latency ≤ 15s` as first-class assertions. Borrow those as starting thresholds for harness evaluator fixtures — tune per task class.

---

## Out of scope for this policy

- Specific model SKU names (they rotate — pick the tier label, not the SKU).
- Pricing calculations (client / console show current rates).
- Automated model selection. The harness trusts the operator; this doc gives them a rubric.

## Related

- `.claude/agents/evaluator.md` — grader rules
- `.claude/agents/lead.md` — tier chosen at delegation
- `.claude/agents/worker.md` — tier chosen at claim
- `.claude/protocols/evaluation-verdict.md` — verdict gate
- `knowledge/gastown-code-archaeology.yaml` → `gt_model_eval` and `GT-REC-01`
