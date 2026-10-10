import { describe, expect, test } from "bun:test";
import { BEAD_TYPES, buildBdCreateCommand } from "@docs/bead-builder";

const base = {
  title: "My bead",
  type: "task",
  priority: "P2",
  repo: ".",
  description: "",
  acceptanceCriteria: "",
  labels: "",
};

describe("buildBdCreateCommand", () => {
  test("renders defaults for a minimal task", () => {
    const cmd = buildBdCreateCommand(base);
    expect(cmd).toBe(
      'bd create --repo "." --type task --priority P2 --title "My bead"',
    );
  });

  test("falls back to task/P2/. on blank or unknown values", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      type: "nonsense",
      priority: "",
      repo: "",
    });
    expect(cmd).toBe(
      'bd create --repo "." --type task --priority P2 --title "My bead"',
    );
  });

  test("escapes double quotes and backticks in the title", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      title: 'Fix "smart" `quotes`',
    });
    expect(cmd).toContain('--title "Fix \\"smart\\" \\`quotes\\`"');
  });

  test("collapses newlines in description to literal \\n", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      description: "line 1\nline 2\r\nline 3",
    });
    expect(cmd).toContain('--description "line 1\\nline 2\\nline 3"');
  });

  test("emits one --acceptance flag per non-empty AC line", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      acceptanceCriteria: "First criterion\n\n  Second criterion  \n",
    });
    const acMatches = cmd.match(/--acceptance "[^"]*"/g) ?? [];
    expect(acMatches).toEqual([
      '--acceptance "First criterion"',
      '--acceptance "Second criterion"',
    ]);
  });

  test("never emits the short --ac form, which bd rejects", () => {
    // `bd create --ac` fails with "unknown flag: --ac". The generated command
    // is meant to be pasted straight into a terminal, so this matters.
    const cmd = buildBdCreateCommand({
      ...base,
      acceptanceCriteria: "Something verifiable",
    });
    expect(cmd).not.toMatch(/--ac\s/);
    expect(cmd).toContain('--acceptance "Something verifiable"');
  });

  test("normalizes comma-separated labels and drops empties", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      labels: " ui , , dashboard ,",
    });
    expect(cmd).toContain('--labels "ui,dashboard"');
  });

  test("omits optional flags when empty", () => {
    const cmd = buildBdCreateCommand(base);
    expect(cmd).not.toContain("--description");
    expect(cmd).not.toContain("--labels");
    expect(cmd).not.toContain("--acceptance");
  });

  test("uses overridden type, priority, and repo when valid", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      type: "feature",
      priority: "P1",
      repo: "./repos/my-api",
    });
    expect(cmd).toContain("--type feature");
    expect(cmd).toContain("--priority P1");
    expect(cmd).toContain('--repo "./repos/my-api"');
  });

  test("escapes a repo path containing a double quote", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      repo: 'weird"name',
    });
    // JSON.stringify handles quote escaping for the repo arg.
    expect(cmd).toContain('--repo "weird\\"name"');
  });

  test("escapes $ so shells do not expand variables in the title", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      title: "Price is $PRICE",
    });
    expect(cmd).toContain('--title "Price is \\$PRICE"');
  });
});

describe("the issue types the builder knows", () => {
  test("an epic is copied as an epic, not turned into a task", () => {
    expect(BEAD_TYPES).toEqual(["task", "feature", "bug", "chore", "epic"]);
    expect(buildBdCreateCommand({ ...base, type: "epic" })).toBe(
      'bd create --repo "." --type epic --priority P2 --title "My bead"',
    );
  });
});

describe("a parent in the copied command", () => {
  test("is passed as --parent, quoted like every other value, when the form has one", () => {
    expect(buildBdCreateCommand({ ...base, parent: "demo-epic.2" })).toBe(
      'bd create --repo "." --type task --priority P2 --parent "demo-epic.2" --title "My bead"',
    );
  });

  test("is left out when the field is empty or blank", () => {
    for (const parent of ["", "   ", undefined])
      expect(buildBdCreateCommand({ ...base, parent })).toBe(
        'bd create --repo "." --type task --priority P2 --title "My bead"',
      );
  });

  test("cannot break out of its quotes", () => {
    // Every quote, dollar and backtick of the value arrives behind a backslash.
    const command = buildBdCreateCommand({
      ...base,
      parent: 'x" --repo "$(id)`id`',
    });
    expect(command).toContain(
      String.raw`--parent "x\" --repo \"\$(id)\`id\`" --title`,
    );
  });
});
