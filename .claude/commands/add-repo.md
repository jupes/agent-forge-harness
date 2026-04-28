# /add-repo — Register a sub-repo in the harness

Clones a repository into `repos/<name>/`, registers it in **local** `repos/repos.json` (gitignored; bootstrap from `repos/repos.json.example` when missing), and (after clone) runs knowledge generation so agents can work against it with up-to-date context.

## Usage

```
/add-repo <git-url | ssh-url | local-path>
```

Examples:

```
/add-repo https://github.com/org/my-service.git
/add-repo git@github.com:org/my-service.git
/add-repo C:\work\my-service
```

If the argument is missing, ask once for a URL or path, then continue.

---

## Required workflow: follow the add-repo skill

**Before doing anything else, read the full skill and execute it in order:**

`.claude/skills/add-repo/SKILL.md`

Do not skip steps, substitute a different clone command, or skip `repos/repos.json` / duplicate checks — the skill is the source of truth. If the skill and this command ever disagree, follow the **skill**.

---

## What “done” looks like

- `repos/repos.json` contains a new entry with correct `name`, `url`, and `defaultBranch`.
- `bun run repo init --repo <name> --human` (or the skill’s equivalent) has completed successfully and `repos/<name>/` exists.
- `/sync-knowledge <name>` has been run (or the agent performed the same exploration + `knowledge/repos/<name>.yaml` synthesis as in `.claude/commands/sync-knowledge.md`).

**Report back:** registry entry, clone path, and that knowledge was generated (or the path to the new YAML file).

---

## Not in scope (unless the user asks)

- Beads issues, PRs, or pushing harness commits — the skill does not require them; offer `/ship` or `/add-bead` only if the user wants follow-up.
