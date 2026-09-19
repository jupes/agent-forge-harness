---
name: forgemaster-auto
description: Run the full Forge pipeline unattended: each phase is reviewed by a fresh evaluator subagent, the findings feed back, and the run advances itself. Use when the user runs /forgemaster-auto or wants a feature built end to end without approval gates.
---

# /forgemaster-auto — Run the Forge pipeline end to end without stopping for a human

Same four phases as `/forgemaster` — **research → plan → implement → ship** — but every phase
reviews its own output with a **fresh evaluator subagent**, feeds the findings back, revises, and
**advances itself**. No `AskUserQuestion`, no approval gates in the happy path.

Use it for work you want run while you are away. Use `/forgemaster` when you want to steer — a gate
you would have used to correct course is exactly what this command removes.

See `.claude/workflows/forge-auto.md` for the full loop, and `.claude/workflows/forge.md` for the
phases themselves.

## Usage

```
/forgemaster-auto <description>          # free text → run the whole pipeline unattended
/forgemaster-auto <BEADS-ID>             # e.g. agent-forge-harness-f25 → that issue is the work
/forgemaster-auto <JIRA-KEY>             # e.g. PROJ-1234 → mirror into Beads, then run
/forgemaster-auto <slug>                 # resume an existing run unattended from its first
                                         #   incomplete phase
/forgemaster-auto <input> --worktree     # build in a fresh worktree (recommended when other
                                         #   runs are in flight)
/forgemaster-auto <input> --max-revisions <n>   # revision budget per phase (default 2)
```

Runs are concurrent — starting one does not disturb another. `bun run forge:runs` lists them.

---

## Step 0 — Preflight (mandatory)

```bash
bd ready >/dev/null    # if this errors, run `bd dolt start` and retry
```

**Do not proceed without Beads.** An unattended run with no issue tracking leaves nothing to read
afterwards.

Then resolve the input exactly as `/forgemaster` Step 0 does (existing Beads id → use it; JIRA key
→ mirror into Beads with `--external-ref jira-<KEY>`; free text → derive a kebab-case `<slug>`).
**Do not ask the user to confirm the slug** — state it and continue.

If the input names an existing run, resume it at its first incomplete phase.

### Pick a worktree

If any other run is in flight, or `--worktree` was passed, build in a fresh one:

```bash
bun run worktree create feat/<slug>
```

Use its path as `<checkout>` below. Two runs sharing a checkout will interleave commits and the
quality gate cannot tell their results apart.

---

## Step 0.5 — Complexity triage

Judge complexity the same way `/forgemaster` does (see its table), but **do not ask** — pick and
say what you picked.

- **Mini-sized** → still run the full four phases here. Auto mode's value is the review loop, and
  the mini path deliberately has no phase gates to hang one on. Keep the phases thin instead: a
  short research doc, a small plan, one checkpoint.
- **Medium or higher** → the full phase set, as written.

---

## Step 1 — Walk the phases unattended

For each phase in order, run the loop in `.claude/workflows/forge-auto.md`:

1. `bun run forge:phase-gate <phase> --slug <slug>` — non-zero means the previous phase never
   finished; **halt**, do not work around it.
2. Run the phase by following `.claude/skills/forge-<phase>/SKILL.md` end to end.
3. `bun run forge:phase-gate <phase> --slug <slug> --write --mode auto --checkout <checkout>`
   (add `--feature` / `--epic` the first time you have them).
4. **Spawn a fresh Evaluator subagent** (`.claude/agents/evaluator.md`) on the phase's exit
   artifact — a different agent from the one that built it, at a tier **≥** the builder's
   (`.claude/protocols/model-tier-policy.md`). Have it write `.tmp/work/<TASK-ID>-verdict.json`
   per `.claude/protocols/evaluation-verdict.md`.
5. ```bash
   bun run forge:review --slug <slug> --phase <phase> --verdict .tmp/work/<TASK-ID>-verdict.json --tier <tier>
   # add --max-revisions <n> when the caller passed it
   ```
   Record the printed `comment` on the phase's Beads issue (`bd comments add <id> "<comment>"`).
6. Branch on the exit code — **0 advance, 3 revise, 2 halt**:
   - **advance** → file medium/low findings as follow-up Beads issues when `fileFollowUps` is
     true, then start the next phase.
   - **revise** → re-run the phase skill with the evaluator's findings as the brief. Fix what was
     found; do not narrow the phase to dodge it. Then go back to step 4.
   - **halt** → stop the run. The handoff is already written; update Beads to reflect reality and
     report which phase stopped and why.

Never advance a phase that has no recorded review, and never edit the verdict to get a better one.

---

## Step 2 — Finish

After ship records complete:

- Confirm `reports/<slug>-ship.md` and the **draft** PR exist. The PR body must pass
  `bun run pr:check <body>` (template in `.claude/skills/pr-description/`).
- Close the Beads epic/feature with evidence; leave follow-ups open and prioritized.
- Push. Work is not complete until `git push` succeeds.
- Report: the slug, the four artifacts, every review round (`--ledger`), the follow-ups filed, and
  the PR link.

---

## What this command will not do

- **Merge, enable auto-merge, or force-push.** Ship opens a draft PR and stops.
- **Guess a decision the code cannot settle.** A product call, an irreversible migration or a
  security trade-off halts the run with the question written into the handoff.
- **Recover destructively.** A dirty tree, a conflict or a failed rebase halts — never
  `reset --hard`, never `push --force`, never delete work to get moving.
- **Advance on its own say-so.** Every advance is backed by a recorded verdict from an evaluator
  that did not write the thing it graded.

---

## Notes

- **Cost**: this is the most expensive path in the harness — four phases, an evaluator each, up to
  two revisions each. For small work under a human, `/forgemaster-mini` is far cheaper.
- **Watching**: `bun run forge:runs` (what is in flight), `bun run forge:review --slug <slug>
  --ledger` (every round), `bun run dashboard` → Forge run.
- **Taking back control**: a run started with `--mode auto` can be continued under gates at any
  time with `/forgemaster <slug>`.
