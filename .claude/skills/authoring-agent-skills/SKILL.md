---
name: authoring-agent-skills
description: Meta-skill for creating new Agent Forge skills. Spec, best practices, scaffold script.
---

# authoring-agent-skills

Creates well-structured skills for the harness.

## When to Use

- Creating a new skill for any repeatable workflow or tool

## Skill Anatomy

A skill lives in `.claude/skills/<name>/` and contains:
- `SKILL.md` — required instructions
- `scripts/` — optional TypeScript scripts
- `references/` — optional docs

## SKILL.md Frontmatter

```yaml
---
name: <skill-name>
description: <one-liner>
---
```

## Best Practices

1. Single responsibility
2. Numbered concrete steps with exact commands
3. JSON output from all scripts
4. Idempotent — safe to run twice
5. Clear error reporting

## Scaffold

```bash
bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts <skill-name> "<description>"
```
