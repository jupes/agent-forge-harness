---
name: syncing-repos
description: Multi-repo git operations — init, reset, status, branch management, refresh (rebase), stacked rebase. JSON output for agent consumption.
---

# syncing-repos

Manages multiple sub-repos registered in **local** `repos/repos.json` (gitignored; bootstrap from `repos/repos.json.example`). All operations emit JSON so agents can parse results.

## When to Use

- Cloning repos for the first time (`init`)
- Pulling latest changes across all repos (`refresh`)
- Creating feature branches across repos for an epic (`branch create`)
- Cleaning up merged branches (`branch cleanup`)
- Checking sync status of all repos (`status`)
- Rebasing stacked branches

## CLI Usage

```bash
bun run repo <command> [options]
```

All commands accept `--repo <name>` to target a single repo, or operate on all repos by default.

### Archived repos

An entry with `"archived": true` stays registered (and cloned, if it is) but every all-repos run
skips it: `init`, `status`, `refresh`, `reset` and the `branch` commands, and `/sync-knowledge --all`.
The JSON output lists the ones left out under `"skipped"`. To act on one anyway:

```bash
bun run repo refresh --repo old-docs          # naming an archived repo still works
bun run repo status --include-archived        # every repo, archived ones included
```

Archive a dormant or reference-only repo instead of removing its entry, so it keeps its clone,
its knowledge file and its name in the Repo column (`docs/HARNESS-GUIDE.md`).

## Commands

### init
Clone or pull all repos in repos.json.
```bash
bun run repo init              # Non-interactive, JSON output
bun run repo init --human      # Human-readable output with progress
```

### status
Show sync status of all repos.
```bash
bun run repo status
# → { "repos": [{ "name": "my-api", "branch": "main", "ahead": 0, "behind": 2, "dirty": false }] }
```

### refresh
Pull and rebase all repos on their default branch.
```bash
bun run repo refresh
bun run repo refresh --repo my-api
```

### reset
Hard reset a repo to its remote HEAD. Discards all local changes.
```bash
bun run repo reset --repo my-api    # DESTRUCTIVE — confirm before use
```

### branch create
Create a feature branch in one or all repos.
```bash
bun run repo branch create feat/T-42-my-feature
bun run repo branch create feat/T-42-my-feature --repo my-api
```

### branch cleanup
Delete merged branches from one or all repos.
```bash
bun run repo branch cleanup
bun run repo branch cleanup --repo my-api --dry-run
```

### stacked-rebase
Rebase a stack of branches sequentially.
```bash
bun run repo stacked-rebase feat/base feat/feature-a feat/feature-b
```

## Output Format

All commands return:
```json
{
  "ok": true,
  "command": "init",
  "repos": [
    {
      "name": "my-api",
      "ok": true,
      "action": "cloned",
      "path": "repos/my-api",
      "branch": "main"
    }
  ],
  "skipped": ["old-docs"],
  "errors": []
}
```

`"skipped"` names the archived entries the run left out (empty when there are none).

On failure:
```json
{
  "ok": false,
  "command": "refresh",
  "repos": [...],
  "errors": [{ "repo": "my-api", "message": "merge conflict in src/index.ts" }]
}
```

## repos.json Schema

```json
{
  "repos": [
    {
      "name": "my-api",
      "url": "https://github.com/org/my-api.git",
      "defaultBranch": "main",
      "checks": [
        { "name": "typecheck", "argv": ["bun", "run", "typecheck"] },
        { "name": "tests", "argv": ["bun", "test"] }
      ]
    },
    {
      "name": "old-docs",
      "url": "https://github.com/org/old-docs.git",
      "defaultBranch": "main",
      "archived": true
    }
  ]
}
```

`"archived"` is optional; only `true` archives (see *Archived repos* above).

`"checks"` is optional here. It is what the quality gate runs for a Forge run that builds in the
repository, each `"argv"` without a shell; without it the gate refuses such a run. The add-repo skill
says how to write it, including the Windows limit on `.cmd` shims.
