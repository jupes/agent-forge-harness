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
/forgemaster-auto <input> --smith <name>        # record the run as built by a configured smith
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

**Free text: create the run's task now.** Every review round is filed against a Beads issue, and
research is reviewed before the plan phase creates any. So when the input is free text, create one
task for the run and claim it (`bd create --type task --title "<title>" --priority <p>`, then
`bd update <id> --claim`). From then on this is a run started from that task: it is the `--bead` of
the research, plan and implement writes, the plan phase adds its checkpoint tasks under it
(`--parent <id>`, not a second feature), and the ship step closes it.

If the input names an existing run, resume it at its first incomplete phase.

### Pick a worktree

If any other run is in flight, or `--worktree` was passed, build in a fresh one:

```bash
bun run worktree create feat/<slug>
```

Use its path as `<checkout>` below. With no separate worktree, `<checkout>` is the top level of the
checkout you are in (`git rev-parse --show-toplevel`), and `--checkout` may be left out: the phase
gate then uses the checkout it runs in. Two runs sharing a checkout will interleave commits. A
quality-gate result belongs to a run only through that run's correlation, not through its checkout;
`--checkout` is where the phase gate writes that correlation.

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
3. `bun run forge:phase-gate <phase> --slug <slug> --write --mode auto --checkout <checkout> --bead <id>`:
   the skill's own `--write` line, with `--mode auto --checkout` added. `<id>` is the issue that
   skill names for its phase (`.claude/workflows/forge.md`, *Which bead a phase names*). The first
   time you have them, add `--feature "<title>"` (the run's title, a text) and `--epic <id>` (the
   feature or epic that groups the run, an issue id).
4. **Spawn a fresh Evaluator subagent** (`.claude/agents/evaluator.md`) on the phase's exit
   artifact — a different agent from the one that built it, at a tier **≥** the builder's
   (`.claude/protocols/model-tier-policy.md`). Have it file its verdict with
   `bun run forge:verdict --correlation <pointer> --review <phase>-<round> …` per
   `.claude/protocols/evaluation-verdict.md`; the command prints the file's full path as
   `data.file`. The pointer is `data.correlation.pointer` from step 3 when the run names its bead
   (`--bead`); otherwise `bun run forge:correlate --bead <TASK-ID> --run <slug>` prints one. (The
   one write that names no bead is the research write of a run started from a feature or an epic:
   `<TASK-ID>` is then that issue's id, and the plan write moves the run to its first task.) When
   the run builds in another checkout (step 3's `--checkout`), give that same `--checkout <dir>` to
   `forge:correlate` and to `forge:verdict`: the correlation and the verdict live there.
5. ```bash
   bun run forge:review --slug <slug> --phase <phase> --verdict <data.file printed by forge:verdict> --tier <tier>
   # <tier>: the evaluator's rank (master, journeyman or apprentice; human for a person)
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

**`--smith <name>`**: add it to both `forge:phase-gate` calls of every phase (steps 1 and 3). A name
that is not configured is refused; the write records the smith as the run's executor, which is the
builder the evaluator's rank is compared against. It does not change the model of the session
running this command, nor of the evaluator subagents it spawns. When a phase is handed to a spawned
CLI, it is the name to give `forge:exec --smith` (`.claude/workflows/forge.md`, *`--smith`*).

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
