/**
 * Default SKILL.md body for new harness skills (used by scaffold.ts and tests).
 */
export function defaultSkillMarkdown(name: string, desc: string): string {
  return `---
name: ${name}
description: ${desc}
---

# ${name}

## Quick start

Minimal workflow or one-liner agents can run first.

## When to Use

- TODO: concrete triggers (user phrases, file types, commands)

## Workflows

### 1. TODO

\`\`\`bash
# command
\`\`\`

## Advanced features

If this skill grows past ~100 lines in SKILL.md, move rarely used detail to \`references/\` and link here (patterns: \`@.claude/skills/authoring-agent-skills\`).
`;
}
