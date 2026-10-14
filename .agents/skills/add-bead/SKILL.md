---
name: add-bead
description: Capture free-text work as a tracked Beads issue. Use when the user runs /add-bead or wants to quickly file a Beads issue.
---

# /add-bead — Capture work as a Beads issue

Create a tracked Beads issue from free text in one step, in the harness tracker (for the harness or one of its sub-repos).

## Usage

```
/add-bead <text>
```

Examples:

```
/add-bead Fix flaky quality-gate timeout on Windows
/add-bead Add OAuth refresh token rotation. Document TTL in the auth knowledge file.
```

If `<text>` is empty, stop and ask the user for a short title or paste.

---

## Title and description

Apply in order after trimming:

1. **Contains a newline:** first line → `--title`; following lines (trimmed, newline-joined) → `--description` (omit `--description` if nothing remains).
2. **Single line, multiple sentences** (more text after a sentence end: `. `, `? `, or `! `): first sentence → `--title`; remainder → `--description`.
3. **Otherwise:** whole string → `--title` only.

If the derived title would exceed ~120 characters, truncate at a word boundary and move the overflow into `--description` (prepend a short line such as `Details:` if helpful).

---

## Issue type and priority

- Default **`--type task`**.
- If the text clearly indicates a defect (e.g. starts with “fix”, “bug”, “regression”, “crash”, “error” describing broken behavior) use **`--type bug`**.
- If it reads like net-new capability (“add”, “implement”, “support”, “feature”) use **`--type feature`**.
- **Priority is mandatory for the creating agent** — follow `.claude/skills/beads-priority-assignment/SKILL.md` and pass **`--priority`** on every `bd create` (your CLI may accept integers `0`–`4`, `P0`–`P4`, and/or `critical` / `high` / `medium` / `low`; confirm with `bd doctor` if unsure).
- If the user states urgency (“P0”, “urgent”, “critical”, “backlog”, “whenever”), map that to `--priority` directly.
- If they give **no** priority signal, infer from the rubric in that skill; if still ambiguous, use harness default **P2 / `2` / `medium`** — do not omit `--priority` when supported.

Optional **`--labels`** only when the user names labels explicitly (comma-separated).

---

## Repository context

- **Every issue goes into the harness tracker.** Pass no `--repo`: `.` is the only repository registered with `bd`, and given any other `--repo`, `bd create` still prints an id but files the issue where no `bd show` or `bd list` run here finds it (see the multi-repo rule in `CLAUDE.md`).
- **Work inside `repos/<name>/`:** start the title with **`[<name>]`** so the issue says which sub-repo it is for.

If unsure which repo applies, infer from `git rev-parse --show-toplevel` and `repos/repos.json`; when the top-level is the harness checkout, the title needs no sub-repo prefix.

---

## Create and confirm

Run non-interactively (no prompts). Prefer machine-readable output:

```bash
bd create --json --type <task|bug|feature> --title "<title>" [--description "<body>"] [--labels a,b] [--priority <n-or-Pn>]
```

Parse the JSON **`id`** field from stdout. If `--json` is unavailable in an older `bd`, fall back to:

```bash
bd create --silent ...   # prints id only
```

Then show the issue for the user:

```bash
bd show <id>
```

**Report back:** new issue **id**, **title**, **type**, and the sub-repo the title names, if any.

---

## After creation

- Suggest next step: `/go <id>` or `bd ready` depending on whether the user wants to start work immediately.
- Do not claim the issue unless the user asks you to.
