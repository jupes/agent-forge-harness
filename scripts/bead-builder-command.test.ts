import { describe, expect, test } from "bun:test";
import {
  acceptanceText,
  BEAD_TYPES,
  buildBdCreateCommand,
} from "@docs/bead-builder";

const base = {
  title: "My bead",
  type: "task",
  priority: "P2",
  repo: ".",
  description: "",
  acceptanceCriteria: "",
  labels: "",
};

/**
 * Run a built command through `sh` with `bd` replaced by a shell function, and
 * return the arguments the shell handed it. The function prints each argument
 * as `<length>:<value>`, so values holding newlines or colons come back whole.
 */
const sh = Bun.which("sh");
function argvFromShell(command: string): string[] {
  const script = `bd() { for arg in "$@"; do printf '%s:%s' "\${#arg}" "$arg"; done; }\n${command}\n`;
  const run = Bun.spawnSync([sh ?? "sh"], {
    stdin: new TextEncoder().encode(script),
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const out = run.stdout.toString();
  const args: string[] = [];
  let at = 0;
  while (at < out.length) {
    const colon = out.indexOf(":", at);
    const length = Number(out.slice(at, colon));
    args.push(out.slice(colon + 1, colon + 1 + length));
    at = colon + 1 + length;
  }
  return args;
}

describe("buildBdCreateCommand", () => {
  test("renders defaults for a minimal task", () => {
    const cmd = buildBdCreateCommand(base);
    expect(cmd).toBe('bd create --type task --priority P2 --title "My bead"');
  });

  test("falls back to task/P2 and no --repo on blank or unknown values", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      type: "nonsense",
      priority: "",
      repo: "",
    });
    expect(cmd).toBe('bd create --type task --priority P2 --title "My bead"');
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

  test("uses overridden type and priority when valid", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      type: "feature",
      priority: "P1",
    });
    expect(cmd).toContain("--type feature");
    expect(cmd).toContain("--priority P1");
  });

  test("escapes $ so shells do not expand variables in the title", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      title: "Price is $PRICE",
    });
    expect(cmd).toContain('--title "Price is \\$PRICE"');
  });
});

describe("the repo in the copied command", () => {
  test("adds nothing when Repo is `.`, empty or blank", () => {
    for (const repo of [".", "", "   ", " . ", "./"])
      expect(buildBdCreateCommand({ ...base, repo })).toBe(
        'bd create --type task --priority P2 --title "My bead"',
      );
  });

  test("is never passed as --repo: another repo is named at the start of the title", () => {
    for (const repo of [
      "my-api",
      " ./repos/my-api ",
      "repos/my-api/",
      ".\\repos\\my-api",
    ])
      expect(buildBdCreateCommand({ ...base, repo })).toBe(
        'bd create --type task --priority P2 --title "[my-api] My bead"',
      );
  });

  test("is not named twice when the title already starts with it", () => {
    expect(
      buildBdCreateCommand({ ...base, repo: "my-api", title: "[My-API] Fix" }),
    ).toBe('bd create --type task --priority P2 --title "[My-API] Fix"');
  });

  test("stays inside the title's quotes when the name holds a quote or a dollar", () => {
    expect(buildBdCreateCommand({ ...base, repo: 'we"ird$x' })).toContain(
      String.raw`--title "[we\"ird\$x] My bead"`,
    );
  });

  test.skipIf(!sh)(
    "reaches bd through sh only as the start of the title",
    () => {
      const args = argvFromShell(
        buildBdCreateCommand({ ...base, repo: "./repos/my-api" }),
      );
      expect(args).not.toContain("--repo");
      expect(args[args.indexOf("--title") + 1]).toBe("[my-api] My bead");
    },
  );
});

describe("acceptance criteria in the copied command", () => {
  test("are one --acceptance flag holding every non-empty line, trimmed, a line each", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      acceptanceCriteria: "First criterion\r\n\n  Second criterion  \nThird\n",
    });
    expect(cmd.match(/--acceptance/g)).toEqual(["--acceptance"]);
    expect(cmd).toBe(
      'bd create --type task --priority P2 --title "My bead" --acceptance "First criterion\nSecond criterion\nThird"',
    );
  });

  test("acceptanceText keeps every non-empty line, trimmed, a line each", () => {
    expect(acceptanceText("First criterion\r\n\n  Second criterion  \n")).toBe(
      "First criterion\nSecond criterion",
    );
    expect(acceptanceText(" \n\n ")).toBe("");
  });

  test.skipIf(!sh)(
    "reach bd through sh as one argument holding every line when the command is run",
    () => {
      const criteria = "it is created\n\n  it is claimed  \nit is closed";
      const args = argvFromShell(
        buildBdCreateCommand({ ...base, acceptanceCriteria: criteria }),
      );
      expect(args.filter((arg) => arg === "--acceptance")).toHaveLength(1);
      expect(args[args.indexOf("--acceptance") + 1]).toBe(
        acceptanceText(criteria),
      );
      expect(args).not.toContain("--repo");
    },
  );

  test.skipIf(!sh)(
    "reach bd through sh unchanged when a line holds quotes, dollars, backticks and backslashes",
    () => {
      const hostile = 'say "hi" to $HOME and `id`\nC:\\path\\n stays';
      const args = argvFromShell(
        buildBdCreateCommand({ ...base, acceptanceCriteria: hostile }),
      );
      expect(args[args.indexOf("--acceptance") + 1]).toBe(hostile);
    },
  );
});

describe("the issue types the builder knows", () => {
  test("an epic is copied as an epic, not turned into a task", () => {
    expect(BEAD_TYPES).toEqual(["task", "feature", "bug", "chore", "epic"]);
    expect(buildBdCreateCommand({ ...base, type: "epic" })).toBe(
      'bd create --type epic --priority P2 --title "My bead"',
    );
  });
});

describe("a parent in the copied command", () => {
  test("is passed as --parent, quoted like every other value, when the form has one", () => {
    expect(buildBdCreateCommand({ ...base, parent: "demo-epic.2" })).toBe(
      'bd create --type task --priority P2 --parent "demo-epic.2" --title "My bead"',
    );
  });

  test("is left out when the field is empty or blank", () => {
    for (const parent of ["", "   ", undefined])
      expect(buildBdCreateCommand({ ...base, parent })).toBe(
        'bd create --type task --priority P2 --title "My bead"',
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
