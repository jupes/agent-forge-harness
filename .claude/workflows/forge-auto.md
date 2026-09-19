# Forge Auto Workflow

The **unattended** Forge path. Same four phases as the full pipeline, but instead of stopping at
each boundary for a human, every phase reviews its own output with a fresh subagent, feeds the
findings back, revises, and advances itself.

```
          ┌──────────── revise (bounded) ────────────┐
          ▼                                          │
  work the phase ──▶ evaluator subagent ──▶ feedback ┘
          │                  │
          │             PASS / medium-low only
          ▼                  ▼
      (blocked)        next phase ──▶ … ──▶ draft PR
          │
          ▼
    halt + handoff
```

**When to use**: work you want run end to end without sitting with it — an overnight run, a queued
feature, a batch of independent changes. Use `/forgemaster` instead when you want to steer, or when
the scope is genuinely ambiguous: a gate you would have used to correct course is exactly what auto
mode removes.

**Concurrency**: auto runs are per-run like every other forge run (`.tmp/work/forge-runs/<slug>.json`),
so several can be in flight at once. Give each code-touching run its own worktree —
`bun run worktree create <branch>` — and record it with `--checkout`, so two runs do not build on
top of each other and the quality gate can tell their results apart.

---

## What replaces the human gate

Nothing advances on the agent's own opinion of its own work. Each phase ends with a **verdict from
a fresh evaluator subagent**, and the next move comes from `bun run forge:review`, which exits
**0 = advance, 3 = revise, 2 = halt**.

| Verdict | What happens |
|---------|--------------|
| PASS | Advance. Medium/low findings become follow-up Beads issues. |
| FAIL, only medium/low | Advance, file the follow-ups. Same bar as the strict eval gate. |
| FAIL, any blocker/high | Revise this phase with the findings as the brief, then review again. |
| Two rounds no better than the last | **Halt** — not converging. |
| Revision budget spent (default 2) | **Halt.** |
| No verdict, or an unreadable one | **Halt.** A run that cannot grade itself must not advance. |

A halt writes `.tmp/work/session-handoff.md` (or `session-handoff-<slug>.md` when one already
exists) naming what stopped it and the command that resumes the work. The run's state is intact;
nothing is force-advanced past a failing review.

---

## The loop, per phase

For each phase in order — `research`, `plan`, `implement`, `ship`:

1. **Gate entry.** `bun run forge:phase-gate <phase> --slug <slug>`. Non-zero means the previous
   phase never finished — halt, do not improvise around it.
2. **Do the phase** by following its skill end to end (`.claude/skills/forge-<phase>/SKILL.md`),
   exactly as the gated pipeline does.
3. **Record it.** `bun run forge:phase-gate <phase> --slug <slug> --write --mode auto
   --checkout <worktree>`.
4. **Review it with a fresh subagent.** Spawn an **Evaluator** (`.claude/agents/evaluator.md`) on
   the phase's exit artifact. It must be a *different* agent from the one that produced the work —
   the evaluator refuses to grade its own output — and run at a tier **≥** the builder's
   (`.claude/protocols/model-tier-policy.md`). Have it write
   `.tmp/work/<TASK-ID>-verdict.json` per `.claude/protocols/evaluation-verdict.md`.
5. **Decide.** `bun run forge:review --slug <slug> --phase <phase> --verdict <path> --tier <tier>`.
   Record the printed `comment` on the phase's Beads issue.
6. **Act on the exit code:**
   - **0 (advance)** — file any follow-ups, then start the next phase.
   - **3 (revise)** — re-run the phase skill with the evaluator's findings as the brief. Fix what
     was found; do not re-scope the phase to dodge it. Then go back to step 4.
   - **2 (halt)** — stop. The handoff is already written; leave the Beads issues reflecting reality
     and say plainly which phase stopped and why.

What each phase reviews:

| Phase | What the evaluator grades |
|-------|---------------------------|
| research | `plans/research/<slug>.md` — are the unknowns actually resolved from real code, or asserted? |
| plan | `plans/drafts/<slug>.md` — do the AC, the file map and the TDD checkpoints match the research and the code? |
| implement | the diff + tests — AC met, tests real, gates green, no scope creep |
| ship | `reports/<slug>-ship.md` + the PR body — does the summary match what actually changed? |

---

## Safety rails

Auto mode removes the *approval* gates, not the safety ones.

- **Beads is still mandatory** and updated as the run goes: claim on start, `worklog:` at each
  checkpoint, `review:` for every round, close with evidence.
- **Quality gates still run** and still block. A failing typecheck/lint/test is a blocker finding,
  not something to advance past.
- **Ship opens a DRAFT PR** and stops there. An unattended run never merges, never enables
  auto-merge, and never force-pushes.
- **No destructive recovery.** If the run is stuck on a dirty tree, a conflict, or a failing
  rebase, halt with a handoff — never `reset --hard`, `push --force`, or delete work to get moving.
- **Questions halt, they do not get guessed.** If a phase hits a decision the code cannot settle —
  a product call, an irreversible migration, a security trade-off — halt and write it in the
  handoff. `AskUserQuestion` has no one to ask in an unattended run.
- **One escalation, then stop.** If a mini-sized run outgrows itself, escalate once to the full
  phase set and continue; if it outgrows *that*, halt.

---

## Cost

An auto run is the most expensive path in the harness: four phases, a fresh evaluator per phase,
and up to two revisions each. Route the builder to the cheapest tier that holds quality and let the
grader-≥-subject rule pull the evaluator up where it matters
(`.claude/protocols/model-tier-policy.md`). For small, clear-scope work, `/forgemaster-mini` under
a human is still cheaper than an unattended full run.

---

## Watching a run

- `bun run forge:runs` — every run in flight, its phase, and the command that continues it.
- `bun run forge:review --slug <slug> --ledger` — every review round the run has recorded.
- `bun run dashboard` → Forge run — phases, checkpoints and the quality gate, per run.
