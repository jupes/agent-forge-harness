---
name: add-repo
description: Register a new sub-repo in the knowledge base.
---

# add-repo

Adds a new sub-repo to the harness: updates **local** `repos/repos.json` (gitignored), clones, generates knowledge YAML.

If `repos/repos.json` is missing, copy `repos/repos.json.example` to `repos/repos.json` and edit entries there. Do not commit `repos/repos.json`.

## When to Use

- Bringing a new repository under Agent Forge management

## Steps

### 1. Resolve location

Accept HTTPS, SSH URL, or local path. Extract repo name from URL (last segment without .git).

### 2. Check for duplicates

```bash
cat repos/repos.json | jq '.repos[] | select(.name == "<repo-name>")'
```

If already exists: report and stop.

### 3. Update repos.json

Add: `{"name":"<name>","url":"<url>","defaultBranch":"main"}`

For a dormant or reference-only repository, add `"archived": true`: it stays registered, and
all-repos runs skip it unless it is named (see the syncing-repos skill, *Archived repos*).

### 4. Clone

```bash
bun run repo init --repo <repo-name> --human
```

### 5. Generate knowledge

```bash
/sync-knowledge <repo-name>
```

### 6. Give the quality gate the repository's checks

A Forge run that builds in this repository is gated from the harness
(`bun run quality-gate --correlation <checkout>/<pointer>`). The gate runs the `"checks"` list on the
repository's entry, in the run's checkout. Each check is a `"name"` and an `"argv"`: the program,
then its arguments. Ask the user which commands the repository's own checks are, and add them to
the entry:

```json
{
  "name": "my-service",
  "url": "https://github.com/org/my-service.git",
  "defaultBranch": "main",
  "checks": [
    { "name": "typecheck", "argv": ["bun", "run", "typecheck"] },
    { "name": "lint", "argv": ["bun", "run", "lint"] },
    { "name": "tests", "argv": ["bun", "test"], "timeoutSeconds": 900 }
  ]
}
```

- Each check runs without a shell. There is no `&&`, no pipe, no `$VAR` and no glob: a check is one
  program with its arguments.
- **Windows:** a check must name a real executable (an `.exe`). `npm`, `pnpm`, `yarn` and other
  `.cmd` shims can only be run by cmd.exe, so the gate refuses to run them and the check fails. Name
  `node` and the tool's script instead, for example
  `["node", "node_modules/typescript/bin/tsc", "--noEmit"]`, or the tool's own `.exe`.
- A check's name is letters, digits, dot, dash or underscore, and must be unique. It may not be a
  check the gate runs itself: `clean-tree`, `ac-verify`, `close-testing-attestation`,
  `test-evidence`, `eval-verdict` or `gate-log`.
- A check is stopped after two minutes unless it sets its own limit: `"timeoutSeconds"`, a whole
  number of seconds from 1 to 3600 (one hour). Set it on a suite that takes longer. A check stopped
  at its limit fails the gate, and its entry says it was stopped for time (`"timedOut": true`, and
  an output that starts `stopped after <n> seconds`) rather than that it failed. When the gate runs
  as a hook, the host's own time limit for the hook still applies.
- Ignore `.tmp/` in the repository, in its `.gitignore` or in `.git/info/exclude`. The harness keeps
  the run's correlation and verdicts there. If the repository tracks files under
  `.tmp/work/run-correlations` or `.tmp/work/evaluations`, the gate refuses to run.
- If the entry has no `"checks"` list, the gate refuses the run and names the entry to fill in.
