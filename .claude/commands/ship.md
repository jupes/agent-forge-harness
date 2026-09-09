# /ship — Quality Gates → Commit → Push → PR

Runs all quality checks, commits staged/unstaged changes, pushes the branch, and creates or updates a PR.

## Usage
```
/ship                        # Auto-generate commit message
/ship "add login redirect"   # Use provided commit message
/ship --amend                # Amend previous commit (use sparingly)
```

---

## Step 1 — Pre-flight Check

```bash
git status                   # Show what will be committed
git diff --stat              # Show changed files summary
```

If working tree is clean (nothing to commit): report "Nothing to ship. Working tree is clean."

---

## Step 2 — Quality Gates

Run all checks. All must pass before committing.

```bash
bun run typecheck            # TypeScript — 0 errors required
bun run lint                 # Lint (skip if no lint script in package.json)
bun test                     # Tests (skip if no test files exist)
```

**Strict evaluator verdict (optional):** If `AGENT_FORGE_EVAL_VERDICT=strict` is set in the environment where hooks run, ensure **`.tmp/work/<TASK-ID>-verdict.json`** exists and matches **`.claude/protocols/evaluation-verdict.md`** before treating the task as shippable. The quality gate hook enforces this on `TaskCompleted` when `CLAUDE_TASK_ID` is set.

**If any check fails**:
1. Report which check failed and the exact error
2. Fix the issue
3. Re-run the failing check
4. Maximum 2 auto-fix attempts; escalate to user if still failing after 2

---

## Step 3 — Security Scan

Scan the diff for security issues before committing:

```bash
git diff HEAD
```

Check for:
- Hardcoded secrets, API keys, passwords, tokens
- SQL string concatenation
- `eval()` or unsafe dynamic code execution
- Auth checks being bypassed (commented out, `if (true)`)
- Unescaped user input in HTML templates

**If any security issue is found**: stop, fix, do not ship. Never commit secrets.

---

## Step 4 — Commit

Stage all changes:
```bash
git add -A
git status --short           # Confirm staged files look right
```

Commit with the provided or generated message:
```bash
# Format: type(scope): description\n\nRefs: <TASK-ID>
git commit -m "<message>"
```

If `--amend` flag: `git commit --amend --no-edit`

### Generating commit messages
If no message was provided, infer from:
1. The Beads task title (if a task is active)
2. The diff summary (most-changed files and purpose)
3. Format: `<type>(<scope>): <description>\n\nRefs: <TASK-ID>`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`

---

## Step 5 — PR Stack Detection

Check if the current branch has a stack relationship:
```bash
gh pr list --state open --json number,headRefName,baseRefName
git log --oneline master..HEAD
```

- **If current branch is based off another feature branch**: set `--base <that-branch>` in PR creation
- **If current branch is based off master**: set `--base master`

---

## Step 6 — Push

```bash
git pull --rebase origin <base-branch>   # Rebase on latest before pushing
git push origin <current-branch>
```

If push fails due to diverged history:
- `git pull --rebase` and retry once
- If still failing: report the conflict; do NOT force push

---

## Step 7 — Create or Update PR

The PR body MUST follow the canonical template — see **`.claude/skills/pr-description/SKILL.md`**.
Do not hand-roll an ad-hoc body; start from the template, fill every required section with real
content, and validate before posting.

### Check if PR already exists

```bash
gh pr list --head <current-branch> --json number,url
```

### Build the body from the template

```bash
mkdir -p .tmp/work
cp .claude/skills/pr-description/references/pr-template.md .tmp/work/pr-body.md
# Fill every section in .tmp/work/pr-body.md:
#   What Changed · Why It's Needed · How It Was Tested · Test Evidence
#   (paste real `bun test` / typecheck output) · Risk & Rollback · Linked Issues & AC Trace.
# Pull AC from: bd show <TASK-ID>
bun run .claude/skills/pr-description/scripts/check-pr-body.ts .tmp/work/pr-body.md
# Must print "ok": true before continuing.
```

### Create new PR

```bash
gh pr create \
  --title "<TASK-ID>: <task title>" \
  --base <base-branch> \
  --body "$(cat .tmp/work/pr-body.md)"
```

### Update existing PR

```bash
gh pr edit <number> --body "$(cat .tmp/work/pr-body.md)"
```

---

## Step 8 — Post-Ship

```bash
# Close Beads task
bd close <TASK-ID> 2>/dev/null || true
bd comments add <TASK-ID> "worklog: shipped — PR #<n>" 2>/dev/null || true

# Push Beads data
bd dolt push 2>/dev/null || true

# Deploy dashboard
bun run build-pages 2>/dev/null || true

# Final status
git status
echo "✓ Shipped: <branch> → PR #<n>"
```

---

## Output

```
Quality gates: PASS (tsc, lint, tests)
Security scan: PASS
Committed: abc1234 — feat(auth): add refresh token rotation
Pushed: origin/feat/T-42-refresh-tokens
PR: https://github.com/org/repo/pull/17 (created)
Beads: T-42 closed
```
