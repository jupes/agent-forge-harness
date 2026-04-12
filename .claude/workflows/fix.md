# Fix Workflow

Use this workflow for small, contained changes: bug fixes, minor updates, configuration changes.

**When to use**: ≤3 files, clear scope, no new architecture needed.
**No plan file required. No approval step.**

---

## Step 0 — Ensure Bead

Check whether a Beads task already exists for this work:
```bash
bd ready | grep -i "<keyword from task description>"
```

- **If a task exists**: claim it — `bd update <id> --claim`
- **If no task exists** (spec-driven or trivial): create one
  ```bash
  bd create --type bug --title "<short description>" --repo <repo>
  bd update <id> --claim
  ```
- **If truly trivial** (typo fix, comment update, whitespace): skip Beads entirely

---

## Step 1 — Explore

Load knowledge first, then map affected code. **All read-only in this step.**

```bash
# 1a. Load knowledge
cat knowledge/repos/<repo>.yaml

# 1b. Map affected files
# Use Glob and Grep — do NOT open every file
# Goal: identify the ≤3 files you will edit

# 1c. Read only the affected files + their direct imports
# Understand the current behavior before changing anything
```

**Stop if you find more than 3 files need changing** — switch to the Feature workflow.

---

## Step 2 — Build

Edit files, typecheck after each, commit as you go.

### For each file change:
1. Edit the file
2. Run: `bun run typecheck` — fix errors immediately; do not accumulate
3. Write or update the test for this change (in the same commit)
4. Stage specific files: `git add <file1> <file2>`
5. Commit: `git commit -m "fix(scope): description\n\nRefs: <TASK-ID>"`

### Test requirements:
- Write a regression test that would have caught this bug
- Test must live adjacent to the code (`*.test.ts` or `*.spec.ts`)
- Test must pass before committing

---

## Step 3 — Visual Verify *(frontend repos only)*

If the changed files affect UI:

1. Start the dev server: `bun run dev` (or per-repo equivalent)
2. Navigate to the affected page/component
3. Verify the fix visually — does it look correct?
4. Check for regressions on adjacent UI
5. Stop the dev server

Skip this step entirely for backend, scripts, or infrastructure changes.

---

## Step 4 — Check

Run the full quality gate suite:

```bash
bun run typecheck          # TypeScript — must be 0 errors
bun run lint               # Lint — must be 0 warnings on changed files (skip if no lint script)
bun test                   # Tests — must all pass (skip if no tests in repo)
git status --porcelain     # Must output nothing (clean tree)
```

**If any check fails**: fix it and re-run. Maximum 2 fix attempts.
If you cannot fix within 2 attempts:
1. Revert the change: `git revert HEAD --no-edit`
2. File a Beads bug with the failure details
3. Report the blocker

---

## Step 5 — Security Scan + Evaluator *(conditional)*

### Security scan
Lightweight diff scan on your changes:

```bash
git diff HEAD~1..HEAD
```

Check for:
- **Secrets**: API keys, passwords, tokens, private keys — any string that looks like a credential
- **SQL injection**: string concatenation into queries
- **Path traversal**: `../` in user-controlled paths
- **Auth bypass**: commented-out auth checks, `if (true)` replacements
- **XSS**: unescaped user input in HTML/JSX

If any blocker is found: fix before proceeding. Do NOT ship with security issues.

### Evaluator spawn *(skip for trivial fixes: ≤2 files, ≤50 lines, type is `bug` or `chore`)*

For anything above the trivial threshold, spawn a fresh Evaluator Agent before shipping — **do not self-evaluate**:

```
Task(
  description: "Evaluate output for <TASK-ID>",
  prompt: "You are the Evaluator Agent. Follow .claude/agents/evaluator.md.

Evaluate the output produced for this fix:
- Baseline: bd show <TASK-ID> (use the Beads issue AC as the evaluation spec)
- Files changed: <list from git diff --name-only HEAD~1..HEAD>
- Worker summary: <paste your summary here>

Produce the structured verdict. Do not write, edit, or commit anything."
)
```

On FAIL: fix BLOCKER/HIGH findings, re-run security scan, respawn evaluator. Maximum 2 iterations — then revert and file a bug.

---

## Step 6 — Ship

### Primary repo (ship to main):
```bash
git push origin main
```

### Sub-repos (branch + PR):
```bash
# Push the branch
git push origin <branch-name>

# Create PR
gh pr create \
  --title "<TASK-ID>: <task title>" \
  --body "## Summary
<what this fixes and why>

## Test Plan
- [ ] Regression test added
- [ ] Manual verification complete

## Beads
Closes <TASK-ID>" \
  --base main

# Close the Beads task
bd close <id>
bd comments add <id> "worklog: shipped in PR #<n>"
```

### After shipping:
```bash
bd dolt push               # Push issue data to remote
git status                 # Verify clean state
```

---

## Quality Gate Summary

| Check | Tool | Must Pass |
|-------|------|-----------|
| TypeScript | `tsc --noEmit` | Yes |
| Lint | `bun run lint` | Yes (if configured) |
| Tests | `bun test` | Yes (if tests exist) |
| Clean tree | `git status` | Yes |
| Security scan | Manual diff review | Yes |
| Evaluator review | Evaluator Agent `Task()` | Skip for trivial (≤2 files, ≤50 lines) |
