import { describe, expect, test } from "bun:test";
import { folderNameForSkill } from "@docs/skill-builder";

describe("folderNameForSkill", () => {
  test("maps spaces to kebab-case", () => {
    expect(folderNameForSkill("test skill")).toBe("test-skill");
  });

  test("trims and lowercases", () => {
    expect(folderNameForSkill("  Deploy-Staging  ")).toBe("deploy-staging");
  });

  test("collapses punctuation runs", () => {
    expect(folderNameForSkill("foo___bar")).toBe("foo-bar");
  });

  test("falls back when empty", () => {
    expect(folderNameForSkill("")).toBe("skill");
    expect(folderNameForSkill("!!!")).toBe("skill");
  });
});
