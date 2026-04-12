# Epic Workflow

Use this workflow for epics: a set of related tasks that can be partially parallelized.

**When to use**: Epic ID provided, `--epic` flag used, or multiple tasks from a spec.
**Requires Lead Agent to coordinate. Workers run in isolated git worktrees.**

---

## Step 1 — Find Work

```bash
# Load the epic
bd show <EPIC-ID>

# List all tasks in this epic
bd ready --epic <EPIC-ID>

# Check for existing worktrees from a prior session
bun run worktree list
```

Claim the epic:
```bash
bd update <EPIC-ID> --claim
bd comments add <EPIC-ID> "worklog: starting epic workflow"
```

---

## Step 2 — Batch Plan

Before spawning workers, plan the full execution.

### 2a. Dependency analysis
```bash
# Review all tasks and their dependencies
bd show <EPIC-ID>   # shows child tasks and deps
```

Build a dependency graph (can be informal):
```
T-1 (no deps)     → can run in batch 1
T-2 (no deps)     → can run in batch 1
T-3 (no deps)     → can run in batch 1
T-4 (needs T-1)   → must wait for batch 1
T-5 (needs T-2,3) → must wait for batch 1
```

### 2b. File exclusivity check
For tasks in the same batch, verify no two workers will edit the same file:
```bash
# For each planned parallel task, list its expected files
# If overlap detected: serialize those two tasks (add dependency)
```

### 2b.5. Pre-task alignment
For each task in the batch, run the 3-way alignment protocol (see `.claude/agents/lead.md` Step 2.5) before spawning workers:
- Spawn a Worker in planning mode + Evaluator in alignment mode for each task
- Reconcile any disagreements on scope or success criteria
- Save alignment documents to `.tmp/work/<TASK-ID>-alignment.md`
- Do not spawn implementation workers until alignment is confirmed for all tasks in the batch

### 2c. Interface contracts
For each batch, identify shared interfaces:
- Which tasks produce exports that other tasks consume?
- Write contracts for these to `.tmp/work/<EPIC-ID>-interfaces.md`
- See `.claude/protocols/interfaces.md` for the format

### 2d. Create the batch schedule
```
Batch 1: [T-1, T-2, T-3]  (WIP ≤ 3)
Batch 2: [T-4, T-5]
Batch 3: [T-6]             (depends on batch 2)
```

---

## Step 3 — Execute Batch

For each batch (up to 3 tasks in parallel):

### 3a. Create worktrees
```bash
# For each worker in this batch
bun run worktree create feat/<EPIC-ID>-worker-<n>
# Returns: { "ok": true, "worktree": { "id": "a1b2c3", "path": "trees/a1b2c3", "branch": "..." } }
```

### 3b. Spawn workers
Use the `Task()` tool to spawn each worker simultaneously.

Worker prompt template:
```
You are a Worker Agent. Follow .claude/workflows/feature.md.

Your task: bd show <TASK-ID>
Worktree: trees/<worktree-id>/
Branch: <branch-name>

Interface contract: .tmp/work/<EPIC-ID>-interfaces.md
(Read the contract before writing any code. Implement signatures exactly.)

cd trees/<worktree-id> before making any changes.
Report Contract: COMPLIANT or DEVIATED at the end.
```

### 3c. Error isolation
- One worker's failure does NOT cancel sibling workers
- Monitor all workers; if one fails, log the failure and continue others
- Failed task: revert its worktree branch, file a Beads blocker issue, continue to next batch without it

### 3d. Merge completed workers
For each worker that succeeds:
```bash
# Verify quality gate passed
bun run typecheck

# Merge the worker branch
git merge --no-ff <worker-branch> -m "feat: merge <TASK-ID> (<worker-branch>)"

# Clean up worktree
bun run worktree cleanup <worktree-id>

# Close the Beads task
bd close <TASK-ID>
bd comments add <TASK-ID> "worklog: merged in batch for <EPIC-ID>"
```

---

## Step 3.5 — Integration Verify

After each batch merges:

```bash
bun run typecheck     # All merged code typechecks together
bun test              # Full test suite
```

If integration fails after merging:
1. Identify which worker's changes caused the conflict
2. Fix inline if trivial (type mismatch, wrong import path)
3. If structural: revert the offending merge and spawn a targeted fix worker before continuing to next batch

---

## Step 4 — Next Batch Loop

After integration verify passes:

```bash
# Check for newly unblocked tasks
bd ready --epic <EPIC-ID>
```

If more tasks are ready: go back to Step 3 with the next batch.
Continue until `bd ready --epic <EPIC-ID>` returns nothing.

---

## Step 5 — Epic Verify

All tasks are complete. Run the full suite:

```bash
bun run typecheck
bun run lint
bun test
git status --porcelain    # Must be empty
```

Verify every acceptance criterion in the epic:
```bash
bd show <EPIC-ID>         # Review epic AC list
```

For each AC item: identify the test that covers it or document manual verification.

---

## Step 6 — Report

Generate the epic completion report and add it as a Beads comment:

```bash
bd comments add <EPIC-ID> "worklog: epic complete

## Batch Summary
- Batch 1: T-1 ✓, T-2 ✓, T-3 ✓
- Batch 2: T-4 ✓, T-5 ✗ (reverted — see T-6 blocker)
- Batch 3: T-6 ✓

## Quality
- TypeScript: PASS
- Tests: PASS (47 new)
- Lint: PASS

## AC Verification
- [x] <criterion 1>
- [x] <criterion 2>

## Contract Compliance
- T-1 → T-4: COMPLIANT
- T-2 → T-5: COMPLIANT"
```

Ship the epic branch (if using an integration branch):
```bash
git push origin <epic-branch>

gh pr create \
  --title "<EPIC-ID>: <epic title>" \
  --body "$(cat .tmp/work/<EPIC-ID>-pr-body.md)" \
  --base main

bd close <EPIC-ID>
bd dolt push
```

---

## Worktree Management

### Worker lifecycle
```
create worktree → spawn worker → worker completes → merge branch → cleanup worktree
```

### WIP limit: 3
Never have more than 3 active worktrees at once. Wait for a worker to complete before spawning a 4th.

### Cleanup orphaned worktrees
```bash
bun run worktree list
bun run worktree cleanup-all   # Use only if session is fresh and no workers are running
```

---

## File Exclusivity Rules

Before spawning parallel workers, verify no file conflicts:

| Task | Expected files | Conflicts with |
|------|---------------|----------------|
| T-1 | `src/api/users.ts`, `src/types/user.ts` | — |
| T-2 | `src/components/UserCard.tsx` | — |
| T-3 | `src/api/users.ts` | **T-1** ← CONFLICT |

If conflict: make T-3 depend on T-1 (serialize them in separate batches).

---

## Quality Gate Summary

| Check | When | Must Pass |
|-------|------|-----------|
| TypeScript (per worker) | After each worker | Yes |
| Tests (per worker) | After each worker | Yes |
| Integration typecheck | After each batch merge | Yes |
| Full test suite | After all batches | Yes |
| Contract compliance | After all batches | Yes (or fix inline) |
| Epic AC verification | Before closing epic | Yes |
