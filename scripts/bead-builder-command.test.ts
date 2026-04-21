import { describe, expect, test } from "bun:test";
import { buildBdCreateCommand } from "@docs/bead-builder";

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

  test("emits one --ac flag per non-empty AC line", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      acceptanceCriteria: "First criterion\n\n  Second criterion  \n",
    });
    const acMatches = cmd.match(/--ac "[^"]*"/g) ?? [];
    expect(acMatches).toEqual([
      '--ac "First criterion"',
      '--ac "Second criterion"',
    ]);
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
    expect(cmd).not.toContain("--ac");
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
