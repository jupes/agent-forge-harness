# Skill authoring guide (harness)

This file expands **authoring-agent-skills** with long-form templates and checklists. Keep **SKILL.md** in each skill as the agent-facing entry; move depth here when a skill would exceed ~100 lines.

## Relationship to upstream

The **write-a-skill** skill in [mattpocock/skills](https://github.com/mattpocock/skills) (`write-a-skill/SKILL.md`) was analyzed and merged into this harness flow: same ideas (progressive disclosure, description as routing signal, when to script), with Agent Forge specifics (`.claude/skills/`, Bun, JSON from scripts, Beads not TODOs).

## Recommended folder layout

```
skill-name/
├── SKILL.md              # Required — primary instructions
├── references/           # Optional — deep docs, schemas, long examples
├── scripts/              # Optional — Bun/TS with JSON stdout envelope
```

Legacy names like `REFERENCE.md` at the skill root are fine if you prefer a flat layout; the harness convention is `references/` for consistency with other skills here.

## SKILL.md template

```md
---
name: skill-name
description: What it does in one line. Use when [specific triggers: keywords, contexts, file types].
---

# Skill name

## Quick start

[Minimal working path]

## Workflows

[Numbered steps, exact commands where possible]

## Advanced features

Rarely needed detail lives under `references/` in this skill; see `@.claude/skills/authoring-agent-skills` for the pattern.
```

## YAML `description` field

The description is the main signal for **which skill to load**. It appears beside other skills in the agent context.

**Goals**

1. What capability the skill provides.
2. When to use it (explicit triggers).

**Constraints**

- Prefer under ~1024 characters (tooling may enforce limits).
- Third person, concrete triggers: “Use when …”.
- First sentence: capability; second: triggers (pattern from upstream write-a-skill).

**Good**

> Validates Beads issue JSON exports and flags malformed envelopes. Use when debugging `bd` JSON output, beads scripts, or agent tooling that parses issue files.

**Bad**

> Helps with issues.

## When to add `scripts/`

- Deterministic steps (format, validate, transform).
- You want **structured JSON** on stdout for agents (`{ "ok": true, "data": … }` per repo AGENTS.md).
- The same code would otherwise be regenerated every run.

## When to split out of SKILL.md

- SKILL.md would exceed ~100 lines.
- Distinct domains (e.g. finance vs deployment) that are not always needed.
- Large examples or tables — move to `references/`.

## Review checklist

- [ ] `description` includes clear triggers (“Use when …”).
- [ ] SKILL.md stays focused; overflow lives under `references/`.
- [ ] No time-sensitive trivia (version pins belong in repo docs or comments near usage).
- [ ] Terminology matches the rest of the harness (Beads, workflows, knowledge/).
- [ ] Scripts emit JSON with `ok` / `data` / `error` where applicable.
- [ ] Steps use imperative, testable language (commands, file paths).
