import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { defaultSkillMarkdown } from "../.claude/skills/authoring-agent-skills/scripts/scaffold-lib";

describe("defaultSkillMarkdown", () => {
  test("includes YAML frontmatter with name and description", () => {
    const md = defaultSkillMarkdown(
      "my-skill",
      "Does a thing. Use when testing.",
    );
    expect(md).toContain("name: my-skill");
    expect(parse(md.split("---")[1] ?? "").description).toBe(
      "Does a thing. Use when testing.",
    );
    expect(md.startsWith("---\n")).toBe(true);
  });

  test("preserves YAML-sensitive descriptions as data", () => {
    const description = 'Report: "progress"\nwith # evidence';
    const md = defaultSkillMarkdown("report", description);
    expect(parse(md.split("---")[1] ?? "").description).toBe(description);
  });

  test("rejects names that could escape or create nested skill directories", () => {
    for (const name of [
      "../escape",
      "a/b",
      "a\\b",
      "A Name",
      "-name",
      "a".repeat(65),
    ]) {
      expect(() => defaultSkillMarkdown(name, "Valid description")).toThrow();
    }
    expect(() => defaultSkillMarkdown("valid", "  ")).toThrow();
  });
});
