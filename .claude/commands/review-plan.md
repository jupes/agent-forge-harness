# /review-plan — Fact-check a plan against real code + first-party docs

Review a **plan** for **inaccuracies**, grounding every finding in the real codebase and first-party
documentation. For each issue it reports **what** is wrong, **why** it's a problem, and the
**evidence** that proves it — with a severity tier.

This is *not* a code review (`/review` does that) — it checks whether a plan's claims about the
system actually hold up *before* you build it.

## Usage
```
/review-plan plans/drafts/<slug>.md     # a plan file on disk
/review-plan agent-forge-harness-cz4    # a Beads issue (its description/design/AC, + any linked plan)
/review-plan                            # review a plan pasted/attached in this chat
/review-plan <input> --no-file          # print the write-up only; don't save a report
```

Accepts a **Beads issue**, a **filesystem path**, or a **plan pasted into chat** — first match wins:
path → bead (`bd show`) → chat. If none resolve, it asks you for one.

## What to do

Follow **`.claude/skills/review-plan/SKILL.md`** in full. In short:

1. **Resolve** the input to the plan text; state what you're reviewing.
2. **Inventory** the plan's checkable claims (paths, symbols, signatures, current behavior, data
   shapes, dependencies, library/API behavior, assumptions) — prioritize load-bearing ones.
3. **Verify** each against ground truth: real code (Glob/Grep/Read) first, then first-party docs
   (`knowledge/`, README/AGENTS, `package.json`, official library docs). Only flag with **evidence**;
   mark **Confirmed** vs **Needs confirmation**; never assert from memory.
4. **Classify** each finding (Blocker / High / Medium / Low) and write it as
   **What / Why it's an issue / Evidence (cited) / Suggested correction**.
5. **Verdict** (SOUND / NEEDS REVISION / UNSOUND + counts). Print the write-up and save it to
   `reports/<slug>-plan-review.md` (unless `--no-file`). If the plan came from a bead, log
   `bd comments add <id> "review: plan <verdict> — <#B>/<#H>/<#M>/<#L>"`.

Pairs well after `/forge-plan` (or `/plan`) and before `/forge-implement`.
