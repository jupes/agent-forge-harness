import { describe, expect, test } from "bun:test";
import { defaultSkillMarkdown } from "../.claude/skills/authoring-agent-skills/scripts/scaffold-lib";

describe("defaultSkillMarkdown", () => {
  test("includes YAML frontmatter with name and description", () => {
    const md = defaultSkillMarkdown(
      "my-skill",
      "Does a thing. Use when testing.",
    );
    expect(md).toContain("name: my-skill");
    expect(md).toContain("description: Does a thing. Use when testing.");
    expect(md.startsWith("---\n")).toBe(true);
  });

  test("includes harness-oriented sections", () => {
    const md = defaultSkillMarkdown("x", "y");
    expect(md).toContain("# x");
    expect(md).toContain("## When to Use");
    expect(md).toContain("## Workflows");
    expect(md).toContain("```bash");
  });
});
