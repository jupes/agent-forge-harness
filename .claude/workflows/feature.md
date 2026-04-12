# Feature Workflow

Use this workflow for single-task work that requires a plan: new features, significant refactors, anything touching >3 files.

**When to use**: >3 files, needs a plan, single coherent task.
**Plan file required. Conditional approval and review steps.**

---

## Step 1 — Find Work

```bash
# Option A: pick from ready queue
bd ready

# Option B: fetch specific task
bd show <TASK-ID>
```

Claim the task:
```bash
bd update <TASK-ID> --claim
bd comments add <TASK-ID> "worklog: starting feature workflow"
```

---

## Step 2 — Explore

Load knowledge first. Then map the full scope.

```bash
# 2a. Load knowledge files (mandatory)
cat knowledge/repos/<repo>.yaml
cat knowledge/_shared.yaml

# 2b. Reuse verification (mandatory — do NOT skip)
# Search for existing implementations before planning anything new
grep -r "^export function use" src/hooks/ --include="*.ts" --include="*.tsx" -l
grep -r "^export (interface|type)" src/types/ --include="*.ts" -l
grep -r "export (default|function|const)" src/components/ --include="*.tsx" -l

# 2c. Explore affected areas (Glob + Grep, read-only)
# Identify all files that will need to change — be exhaustive
# Read files relevant to the task; skip unrelated files

# 2d. Note integration points
# What does this feature depend on?
# What depends on this feature?
```

---

## Step 3 — Plan

Write a plan to `.tmp/work/<TASK-ID>-plan.md`.
Create `.tmp/work/` if it does not exist.

### Plan format:

```markdown
# Plan: <TASK-ID> — <task title>

## Summary
<~100 token description: what is being built and why>

## Implementation Steps
1. <Step> — `<file path>` — <what changes>
2. <Step> — `<file path>` — <what changes>
...

## Files to Modify
| File | Change |
|------|--------|
| `src/...` | <description> |

## Files to Create
| File | Purpose |
|------|---------|
| `src/...` | <description> |

## Test Strategy
- Unit tests for: <list>
- Integration tests for: <list>
- Edge cases: <list>

## Validation Commands
\`\`\`bash
bun run typecheck
bun test src/...
\`\`\`

## Estimated Scope
- Files: <n>
- Complexity: Low | Medium | High
- Estimated time: <n> minutes

## Interfaces (if shared with other tasks)
\`\`\`typescript
// Exact signatures for any shared interfaces
\`\`\`
```

---

## Step 4 — Approve *(conditional)*

**Skip approval if ALL of the following are true**:
- Task type is `bug` AND estimated ≤120 minutes
- OR task type is `chore` AND ≤3 files

Otherwise, present the plan summary and wait for user approval:
```
Plan ready: .tmp/work/<TASK-ID>-plan.md
Summary: <2-sentence description>
Scope: <n> files, <complexity>
Proceed? (yes/no)
```

If the user requests changes: update the plan and re-present.

---

## Step 5 — Build + Test

Follow the implementation steps from your plan, in order.

### For each implementation step:
1. Edit the file(s) per the plan
2. Run: `bun run typecheck` — fix immediately
3. Write tests alongside the implementation (not after)
4. Stage specific files only: `git add <file1> <file2>`
5. Commit: `git commit -m "feat(scope): description\n\nRefs: <TASK-ID>"`

### Test requirements:
- Unit test for each new function / hook / component
- Integration test for the end-to-end flow (if applicable)
- Test file must be adjacent to source: `*.test.ts` / `*.spec.ts`
- All tests must pass before next step

### Hard stop conditions:
- **8 files changed**: pause, report to lead agent
- **200 lines changed**: pause, report to lead agent
- **3+ failing checks after retry**: revert and file a blocker issue

---

## Step 6 — Check

```bash
bun run typecheck
bun run lint
bun test
git status --porcelain     # Must be empty
```

All must pass. Maximum 2 fix attempts per failure.

---

## Step 7 — Visual Verify *(frontend repos only)*

If changes affect UI:
1. `bun run dev`
2. Verify the feature in browser — confirm it works end-to-end
3. Check for visual regressions on adjacent pages/components
4. `bun run ui-screenshot` (if available) to capture screenshots for PR

---

## Step 8 — Review *(conditional)*

**Skip review if ALL of the following are true**:
- Task type is `bug` or `chore`
- ≤3 files changed
- ≤100 lines changed

Otherwise, perform a risk-tiered self-review:

### Review checklist

**Blocker (must fix — blocks PASS)**:
- [ ] No security vulnerabilities (injection, path traversal, auth bypass, secrets)
- [ ] No data loss risk (destructive operations without confirmation)
- [ ] No credentials or tokens in code

**High (must fix — blocks PASS)**:
- [ ] All error cases handled (no silent failures)
- [ ] No `any` types without justification comments
- [ ] All tests passing
- [ ] No breaking changes to public interfaces without migration

**Medium (create follow-up task)**:
- [ ] Code is readable without excessive comments
- [ ] Edge cases have test coverage
- [ ] Performance is acceptable for expected load

**Low (optional)**:
- [ ] Variable names are clear
- [ ] Documentation is up to date

If Blocker or High findings exist: fix them before shipping.
For Medium: create a Beads follow-up task.
Log review result: `bd comments add <TASK-ID> "review: PASS — 0B/0H/2M/1L"`

### Maximum rework iterations: 2
If you cannot resolve Blocker/High issues within 2 iterations:
1. Revert the implementation
2. File a Beads bug with findings
3. Escalate to lead agent

---

## Step 9 — Ship

```bash
# Push branch
git push origin <branch-name>

# Create PR
gh pr create \
  --title "<TASK-ID>: <task title>" \
  --body "## Summary
<what this does and why>

## Changes
<bullet list of key changes>

## Test Plan
- [ ] Unit tests added
- [ ] Integration tests pass
- [ ] Manual verification done

## AC Trace
| Criterion | Verified By |
|-----------|-------------|
| <ac1> | <test name or manual check> |

## Beads
Closes <TASK-ID>" \
  --base main

# Close Beads task
bd close <TASK-ID>
bd comments add <TASK-ID> "worklog: shipped in PR #<n>"
bd dolt push
```

---

## AC Trace Matrix

The AC Trace Matrix links each acceptance criterion to a specific test or manual verification step:

| Criterion | Test / Verification | Status |
|-----------|---------------------|--------|
| <ac from bd show> | `<test file>:<test name>` or "Manual: <steps>" | ✓ |

Include this matrix in the PR body.

---

## Quality Gate Summary

| Check | Must Pass | Conditional |
|-------|-----------|-------------|
| TypeScript | Yes | — |
| Lint | Yes (if configured) | — |
| Tests | Yes | — |
| Clean tree | Yes | — |
| Approval | — | Skip for bugs ≤120min, chores ≤3files |
| Review | — | Skip for bugs/chores ≤3files ≤100lines |
| Visual verify | — | Frontend only |
