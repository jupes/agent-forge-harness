# AGENTS.md — Non-Interactive Shell & Session Rules

This file governs how agents must behave when running shell commands and managing sessions.
Every sub-repo should contain its own AGENTS.md with repo-specific overrides.

---

## Non-Interactive Shell Rules

Agents run in non-interactive shell environments. These rules are mandatory:

### 1. Never prompt for input
All commands must complete without waiting for stdin. Use flags to suppress prompts:
```bash
# WRONG — will hang waiting for input
git commit

# RIGHT — non-interactive
git commit -m "message" --no-edit
gh pr create --title "..." --body "..." --no-edit
```

### 2. Always use `--yes` / `-y` / `--force` where safe
```bash
bun install --frozen-lockfile   # deterministic, no prompts
gh repo clone org/repo -- --depth=1
```

### 3. Pipe stderr to stdout when capturing output
```bash
result=$(bun run scripts/worktree.ts create feat/my-branch 2>&1)
```

### 4. Set timeouts on long-running processes
```bash
timeout 120 bun test || echo "Tests timed out"
```

---

## JSON Output Convention

Scripts in this repo emit **structured JSON** so agents can parse results reliably.

### Standard output envelope
```json
{
  "ok": true,
  "data": { ... },
  "error": null
}
```

### On failure
```json
{
  "ok": false,
  "data": null,
  "error": "Human-readable error message"
}
```

Agents must check `ok` before using `data`. Never `JSON.parse` without a try/catch.

---

## Session Start Protocol

At the beginning of every session:

1. `bd sync` — pull latest issue data from remote
2. `git status` — verify clean working tree
3. `git pull --rebase` — get latest commits
4. Check `bd ready` to orient on available work
5. Read relevant `knowledge/repos/<repo>.yaml` before touching code

---

## Session End Protocol (Mandatory)

Before ending any session, complete ALL steps:

1. File Beads issues for unfinished work
2. Run quality gates: `bun run typecheck && bun test`
3. Close/update Beads issues
4. Run: `git pull --rebase && bd dolt push && git push`
5. Verify `git status` output confirms "up to date with origin/main"

**If `git push` fails: investigate and resolve. Do not stop until it succeeds.**

---

## Branch Naming

```
feat/<TASK-ID>-short-description    # features
fix/<TASK-ID>-short-description     # bug fixes
chore/<TASK-ID>-short-description   # maintenance
epic/<EPIC-ID>-name                 # epic integration branches
```

---

## Commit Message Format

```
<type>(<scope>): <short description>

[optional body — what and why, not how]

Refs: <TASK-ID>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`

Example:
```
feat(auth): add refresh token rotation

Rotate refresh tokens on each use to limit replay attack window.
Previous implementation reused tokens indefinitely.

Refs: T-42
```

---

## PR Requirements

- Title matches the Beads task title
- Body includes: Summary, Test Plan, AC checklist, Screenshots (for UI changes)
- All CI checks must pass before merge
- No force-push to main/master
- Squash or merge-commit — no rebase-merge to main (preserves history)

---

## Worktree Management

Parallel workers use isolated git worktrees. Managed via `scripts/worktree.ts`:

```bash
# Create a worktree for a worker
bun run worktree create feat/EPIC-1-worker-1
# → { "ok": true, "worktree": { "id": "a1b2c3", "path": "trees/a1b2c3", "branch": "..." } }

# List active worktrees
bun run worktree list

# Clean up after worker completes
bun run worktree cleanup a1b2c3
```

Workers must clean up their worktree after merging. The lead agent is responsible for
calling `cleanup` on any orphaned worktrees.

---

## Sub-Repo Conventions

When working inside `repos/<repo-name>/`:
- Read `repos/<repo-name>/AGENTS.md` first — it overrides these defaults
- Read `repos/<repo-name>/CONTRIBUTING.md` if it exists
- Follow the sub-repo's own commit format, branch naming, and test commands
- Create Beads issues with `bd create --repo ./repos/<repo-name>`

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
