# Plan: agent-forge-harness-8ji.20 — Investigate and port skill: write-a-skill

## Summary

Port `repos/skills/write-a-skill` into the harness by extending `.claude/skills/authoring-agent-skills` with the same authoring process, description rules, progressive disclosure, and review checklist—paths and conventions aligned to Agent Forge (Bun scaffold, JSON scripts, `references/`).

## Implementation Steps

1. Add `scaffold-lib.ts` — extract default `SKILL.md` body for reuse and unit tests.
2. Update `scaffold.ts` — call `defaultSkillMarkdown` from the lib.
3. Expand `authoring-agent-skills/SKILL.md` — process, triggers, when to script/split, link to references.
4. Add `references/AUTHORING-GUIDE.md` — full template and extended checklist (keeps main SKILL scannable).
5. Add `scripts/authoring-scaffold.test.ts` — assert stub shape (frontmatter, sections).

## Files to Modify

| File | Change |
|------|--------|
| `.claude/skills/authoring-agent-skills/scripts/scaffold.ts` | Use shared markdown builder |
| `.claude/skills/authoring-agent-skills/SKILL.md` | Ported authoring guidance |

## Files to Create

| File | Purpose |
|------|---------|
| `.claude/skills/authoring-agent-skills/scripts/scaffold-lib.ts` | Testable default skill markdown |
| `.claude/skills/authoring-agent-skills/references/AUTHORING-GUIDE.md` | Long-form template + detail |
| `scripts/authoring-scaffold.test.ts` | Unit tests for stub output |

## Test Strategy

- Unit: `defaultSkillMarkdown` includes YAML frontmatter, `name:` matches slug, harness-oriented sections.

## Validation Commands

```bash
bun run typecheck
bun test scripts/authoring-scaffold.test.ts
```

## Estimated Scope

- Files: 6
- Complexity: Low
- Estimated time: 25 minutes

## Interfaces

```typescript
export function defaultSkillMarkdown(name: string, desc: string): string;
```
