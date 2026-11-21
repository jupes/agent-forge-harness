/**
 * Default SKILL.md body for new harness skills (used by scaffold.ts and tests).
 */
export function defaultSkillMarkdown(name: string, desc: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(
      "Skill name must be a kebab-case slug of at most 64 characters",
    );
  }
  if (!desc.trim())
    throw new Error("A capability and invocation description is required");
  return `---
name: ${name}
description: ${JSON.stringify(desc)}
---

# ${name}

## Outcome and inputs

Describe the requested result, required inputs, and defaults. Replace this scaffold before use.

## Workflow

1. Resolve the task from supplied context; identify any missing decision that prevents progress.
2. Replace this step with the domain-specific operation and its observable result.
3. Verify the result and report any incomplete work or tool failure.

## Completion

Replace with the evidence that distinguishes a completed result from a partial attempt.

## Supporting resources

Link resources at the workflow branch that needs them; remove this section if none are needed.
`;
}
