---
name: forge-ship
description: Phase 4 of the Forge pipeline. Summarize the whole workload — what was built, which Beads issues closed, a before/after, and a step-by-step walkthrough the user can run to verify it themselves — then run quality gates, push, and open the PR. Use when starting /forge-ship or the ship step of /forgemaster.
---

# forge-ship

Phase 4 of 4 in the Forge pipeline (research → plan → implement → **ship**). It closes the loop: a
human-readable summary of the entire run plus the actual push/PR. Output is `reports/<slug>-ship.md`
and a pushed branch with a PR.

This phase complements the existing [[ship]] command — it adds the **narrative summary and test
walkthrough** on top of the quality-gate/commit/push mechanics.

## When to Use

- The user runs `/forge-ship <slug>` or `/forgemaster` enters its ship phase.
- The implement phase is complete (all checkpoints demoed, tasks closed).

## Prerequisites

```bash
bun run forge:phase-gate ship --slug <slug>     # verifies implement is complete in forge state
cat plans/research/<slug>.md                    # original goal
cat plans/drafts/<slug>.md                      # plan + checkpoints + Beads map
```

Beads must be reachable. If `bd` errors, stop and fix it (`bd dolt start`) before shipping.

**`--smith <name>`**: when the run was started with it, add `--smith <name>` to every
`forge:phase-gate` call in this skill. The phase gate refuses a name that is not configured and
records the smith on the run as its executor. It does not change the model of the session doing the
work (`.claude/workflows/forge.md`, *`--smith`*).

## Process

### 1. Gather the facts

```bash
git log --oneline <base>..HEAD          # commits this run produced
git diff --stat <base>..HEAD            # files + churn
bd list --json                          # to confirm which planned tasks are closed
```

Cross-reference against the plan's Beads Issue Map so every planned task is accounted for
(closed, or explicitly deferred with a reason).

### 2. Build the before/after

Describe the observable change, not the diff. For each checkpoint: what the user could NOT do
before, and what they can do now. Capture commands/URLs and expected output.

### 3. Write the ship report

Write to `reports/<slug>-ship.md` (create `reports/` if needed):

```markdown
# Ship Report: <slug> — <feature title>
Shipped: <date>
Epic/Feature: <beads id> · Branch: <branch> · PR: <url once created>

## What Shipped
<2–4 sentences: the capability delivered, in plain language>

## Before → After
| Area | Before | After |
|------|--------|-------|
| <capability> | <old behavior / "did not exist"> | <new behavior> |

## Work Done
- Checkpoint A — <summary> (<commit shas>)
- Checkpoint B — <summary> (<commit shas>)

## Beads Completed
| Beads ID | Title | Status |
|----------|-------|--------|
| <id> | <title> | closed |

## Test It Yourself (walkthrough)
1. <setup step, e.g. `bun install` / `bun run dev`>
2. <action — exact command or UI steps>
   - Expect: <observable result>
3. Automated: `bun test <paths>` — expect all green.

## Follow-ups / Known Gaps
- <deferred Beads id + reason, or "none">
```

### 4. Quality gate, push, PR

**Gate the run through its correlation** before anything is pushed. One command runs typecheck,
lint and the tests, checks that the tree is clean and that a test file is among the branch's own
commits, and logs the result against this run and the issue it names (reuse [[ship]] for the rest
of the mechanics):

```bash
git status --porcelain                           # must be empty: commit what belongs to the run
bun run quality-gate --correlation <pointer>     # must exit 0
git pull --rebase origin <base>
git push origin <branch>
```

- `<pointer>` is what every phase-gate write of this run that named a bead printed as
  `data.correlation.pointer`. It is one path for the whole run,
  `.tmp/work/run-correlations/<slug>.json`, relative to the checkout the run builds in. Run the gate
  in that checkout.
- If that file is not there (a run whose writes named no bead, or one started before the phases
  named theirs), create it with the task the run worked last:
  `bun run forge:correlate --bead <id> --run <slug>`.
- A failing check blocks the push: fix what it names and run the gate again. `test-evidence` reads
  every commit of the branch's own, the ones since `origin/HEAD`, however far back the tests are,
  and fails when none of them holds a test file. A branch whose commits change documentation only
  (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`), or that has no commits of its own, has
  nothing to test: the check is skipped and its entry says so. With no `origin/HEAD` the gate reads
  the last five commits instead and says so (`git remote set-head origin --auto` sets it).
- Strict verdict mode (`AGENT_FORGE_EVAL_VERDICT=strict`) is opt-in. When it is on, file the run's
  verdict with this pointer before the gate (`.claude/commands/ship.md`).

**A run whose work is in another repository** (`repos/<repo>`, or a worktree of one recorded with
`--checkout`) is gated the same way, from this checkout, with that repository's own checks. Its
correlation is in the run's checkout: join the `checkout` and the `pointer` the phase gate printed.

```bash
bun run quality-gate --correlation <checkout>/<pointer>   # from this checkout; must exit 0
```

- The gate runs the `checks` list on the repository's entry in `repos/repos.json`
  ([[add-repo]] says how to write one), each in the run's checkout and without a shell. Then it runs
  clean-tree and test-evidence there. The entry is linked to the run and its issue, and logged as
  that checkout's.
- A repository with no `checks` list is refused, and the refusal names the entry to fill in. So is
  one that tracks files under `.tmp/work/run-correlations` or `.tmp/work/evaluations`.
- In strict mode the run's verdict is read from the run's checkout, where `forge:verdict` filed it.
- Then pull and push in that repository.

The PR body MUST follow the canonical template — see [[pr-description]]. The ship report you just
wrote is the source material: map its sections into the template (What Shipped → What Changed, the
goal from research → Why It's Needed, the **Test It Yourself** walkthrough → How It Was Tested, real
gate output → Test Evidence) and fill Risk & Rollback + Linked Issues & AC Trace.

```bash
mkdir -p .tmp/work
cp .claude/skills/pr-description/references/pr-template.md .tmp/work/pr-body.md
# Fill every section from reports/<slug>-ship.md + the plan's Beads map, then validate:
bun run .claude/skills/pr-description/scripts/check-pr-body.ts .tmp/work/pr-body.md   # must be "ok": true

gh pr create --title "<feature title>" --base <base> --body "$(cat .tmp/work/pr-body.md)"
```

Keep `reports/<slug>-ship.md` as the durable in-repo record; the PR body is the template-conformant
view of the same run.

### 5. Close out Beads + state

`<close-id>` is the issue this run closes: the feature or the epic. A run that closes neither keeps
the id its implement write named. This is the one write that may name a feature or an epic
(`.claude/workflows/forge.md`, *Which bead a phase names*).

When `<close-id>` is a feature or an epic, add its testing attestation first. A gate that runs
linked to that issue requires it, and after the write below the run's pointer names that issue:

```bash
bd comments add <close-id> "worklog: testing-attestation automation=<yes|no> unit=<yes|no> notes=<short context>"
```

```bash
bd close <close-id>            # skip when the implement phase already closed it (a run that closes no feature or epic)
bd comments add <close-id> "worklog: shipped — PR #<n>; report reports/<slug>-ship.md"
# The tracker is local-only: do not run `bd dolt push`.
bun run forge:phase-gate ship --slug <slug> --write --bead <close-id>     # records the run complete
```

After ship completes, the forge run is finished — the Stop hook goes quiet and the state file can
be archived or removed.

### 6. Present to the user

```
🚀 Shipped: <slug>
Report: reports/<slug>-ship.md
PR: <url>
Beads closed: <ids>

Try it: <the single most representative command from the walkthrough>
```

## Exit Criteria

- [ ] `reports/<slug>-ship.md` exists with before/after, Beads table, and a runnable walkthrough.
- [ ] The quality gate passed through the run's correlation (for a run in another repository: from
      this checkout, with that repository's checks); branch pushed; PR created with a
      [[pr-description]]-conformant body
      (`check-pr-body.ts` reports `ok: true`).
- [ ] Every planned Beads task is closed or deferred-with-reason; epic/feature closed.
- [ ] Forge state advanced to `ship` complete.
