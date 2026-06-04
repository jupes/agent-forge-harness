# Forge Mini Workflow

The trimmed Forge path for **low-complexity** work — small bugs, chores, config, copy tweaks,
single-function changes. Same spirit as the full pipeline (Beads-tracked, TDD where it fits, a demo
you can see, a short handoff) but collapsed into three lightweight steps to keep turns and cost down.

```
scope  →  build  →  wrap
(quick    (TDD +    (short summary
 plan +    one       + verify steps
 1 Q max)  demo)     + push/PR)
```

**When to use**: ≤~3 files, clear scope, no new architecture, at most one real decision to confirm.
For anything bigger — multiple files, a new component/system, several unknowns, cross-cutting scope
— use the full pipeline (`.claude/workflows/forge.md`). `/forgemaster` picks for you and lets you
override.

**What's trimmed vs full** (the cost savings): no separate research/plan/ship **doc files**, no
`forge:phase-gate` / `forge-state.json`, and far fewer approval gates. Tracking lives in **Beads**
(the task status is the source of truth). Run at a lower model tier when quality allows — see
`.claude/protocols/model-tier-policy.md`.

**What's kept** (non-negotiable): Beads is mandatory, TDD for code changes, one runnable demo, and a
short "how to verify" handoff.

---

## Step 0 — Preflight

Beads is required. `bd ready >/dev/null` — if it errors, run `bd dolt start` and retry. Do not
proceed without Beads.

---

## Step 1 — Scope (quick plan, inline)

Keep it to a few minutes of reading, not a research project.

1. Read only the files the change touches (and `knowledge/` if a registered repo is involved).
   Answer everything you can from the code yourself.
2. Ask **at most one** clarifying question — and only if a real decision can't be settled from the
   code. Lead with a one-or-two-sentence plain-language *why* before the options (don't dump a menu
   the user can't parse); include a recommended answer. Prefer `AskUserQuestion`. Often this is
   **zero** questions.
3. State the approach inline (2–4 sentences): what changes, in which files, and how it'll be
   verified. No `plans/` doc unless the user asks for one.
4. Beads: create or reuse one task, set it in progress, and claim it:
   ```bash
   bd create --repo <repo> --type <bug|chore|task> --title "<title>" --priority <p> \
     --acceptance "<observable done condition>"   # skip if a task already exists
   bd update <id> --claim                          # sets assignee + status=in_progress
   ```
   Priority via `.claude/skills/beads-priority-assignment/SKILL.md`.

Then briefly confirm the approach with the user before building (one lightweight gate).

---

## Step 2 — Build (TDD + one demo)

Follow `.claude/skills/tdd/SKILL.md` for code changes — **vertically**: one failing test → minimal
code → repeat; refactor only while green. For non-code changes (config, docs), the "test" is the
relevant command (e.g. `bun run lint`, a build, a CLI invocation).

- Make the change; run `bun run typecheck` and the relevant test/command as you go.
- Produce **one demo** the user can run: the exact command/URL and the expected result (or note
  `(no live demo)` and point to the passing test/command).
- Add a `worklog:` comment capturing the result:
  `bd comments add <id> "worklog: <what works> — demo: <cmd>; tested: yes"`.
- Commit (tests alongside code):
  ```bash
  git add <files>
  git commit -m "<type>(<scope>): <summary>

  Refs: <id>"
  ```

Show the demo result and pause for the user to look before wrapping.

---

## Step 3 — Wrap (short handoff + push)

Keep the summary inline — no `reports/` file unless asked.

1. Quality gates: `bun run typecheck && bun run lint && bun test`; working tree clean.
2. Close the task with evidence:
   ```bash
   bd close <id>
   bd comments add <id> "worklog: done — <one-line result>"
   ```
3. Push (and PR if the change warrants one):
   ```bash
   git pull --rebase origin <base>
   git push origin <branch>
   gh pr create --base <base> --title "<title>" --body "<short summary + how to verify>"   # if a PR is wanted
   bd dolt push
   ```
4. Report inline: **what changed**, **how to verify it** (1–3 steps with expected output), and the
   **Beads id closed** + PR link.

---

## Escalate if it grows

If, mid-run, the work turns out bigger than "mini" (scope creep past ~3 files, a new abstraction, or
multiple real decisions surface): **stop and switch to the full pipeline** — run
`/forge-research <slug>` to capture the now-non-trivial context properly, and tell the user you're
escalating and why. Don't quietly carry a medium task through the trimmed path.
