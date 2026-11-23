---
name: pr-description
description: Write or validate a Forge PR body using the canonical template. Use when creating or editing a PR, or checking its description.
---

# pr-description

The single source of truth for **how every Agent Forge PR body is written**. All ship paths
(`/ship`, `/forge-ship`, `/forgemaster`'s ship phase) compose the PR body from this template and
validate it before `gh pr create`.

The template lives at [references/pr-template.md](references/pr-template.md) — edit that file to
change the standard; everything else references it.

Read [the canonical template](references/pr-template.md) before drafting or checking a body; it defines every required section.

## Process

### 1. Start from the template

```bash
cp .claude/skills/pr-description/references/pr-template.md .tmp/work/pr-body.md
```

Fill every section. For a `/forge-ship` run, the ship report (`reports/<slug>-ship.md`) already
contains the narrative and walkthrough — map it into the template sections rather than duplicating
prose. Paste **actual** test output into `## Test Evidence`; never green-wash.

### 2. Validate before creating the PR

```bash
bun run .claude/skills/pr-description/scripts/check-pr-body.ts .tmp/work/pr-body.md
```

The validator emits `{ ok, data: { present, missing, empty }, error }` and exits non-zero if any
required section is missing or left as a placeholder. Fix and re-run until `ok: true`.

### 3. Open or update the PR

```bash
gh pr create --base <base> --title "<title>" --body-file .tmp/work/pr-body.md
# or, on an existing PR:
gh pr edit <n> --body-file .tmp/work/pr-body.md
```

To check a PR that already exists:

```bash
gh pr view <n> --json body -q .body | bun run .claude/skills/pr-description/scripts/check-pr-body.ts -
```

## Exit Criteria

- [ ] PR body contains all six required sections, each filled.
- [ ] `## Test Evidence` holds real output, not a promise.
- [ ] `check-pr-body.ts` reports `ok: true`.
