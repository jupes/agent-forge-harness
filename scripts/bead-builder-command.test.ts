import { describe, expect, test } from "bun:test";
import {
  acceptanceText,
  BEAD_TYPES,
  buildBdCreateCommand,
  titleWithRepo,
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

const sh = Bun.which("sh");
const bash = Bun.which("bash");

/**
 * Run a built command through a shell with `bd` replaced by a shell function,
 * and return the arguments the shell handed it. The function prints each
 * argument as `<length>:<value>`, so values holding newlines or colons come
 * back whole. `prelude` runs first, in the same shell.
 */
function argvFrom(shell: string, command: string, prelude = ""): string[] {
  const script = `${prelude}\nbd() { for arg in "$@"; do printf '%s:%s' "\${#arg}" "$arg"; done; }\n${command}\n`;
  const run = Bun.spawnSync([shell], {
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
const argvFromShell = (command: string) => argvFrom(sh ?? "sh", command);
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("buildBdCreateCommand", () => {
  test("renders defaults for a minimal task", () => {
    const cmd = buildBdCreateCommand(base);
    expect(cmd).toBe("bd create --type task --priority P2 --title 'My bead'");
  });

  test("falls back to task/P2 and no --repo on blank or unknown values", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      type: "nonsense",
      priority: "",
      repo: "",
    });
    expect(cmd).toBe("bd create --type task --priority P2 --title 'My bead'");
  });

  test("leaves double quotes, backticks and dollars in the title as they are inside its single quotes", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      title: 'Fix "smart" `quotes` at $PRICE',
    });
    expect(cmd).toContain("--title 'Fix \"smart\" `quotes` at $PRICE'");
  });

  test("writes a single quote inside a value as '\\''", () => {
    expect(buildBdCreateCommand({ ...base, title: "It's done" })).toContain(
      String.raw`--title 'It'\''s done'`,
    );
  });

  test("keeps the description's newlines as newlines inside its quotes, CRLF as LF", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      description: "line 1\nline 2\r\nline 3",
    });
    expect(cmd).toContain("--description 'line 1\nline 2\nline 3'");
    expect(cmd).not.toContain("\\n");
  });

  test.skipIf(!sh)(
    "a description reaches bd through sh with real newlines, not a backslash and n",
    () => {
      const args = argvFromShell(
        buildBdCreateCommand({
          ...base,
          description: "## Why\n\n  indented line\r\nlast line",
        }),
      );
      expect(argAfter(args, "--description")).toBe(
        "## Why\n\n  indented line\nlast line",
      );
    },
  );

  test("never emits the short --ac form, which bd rejects", () => {
    // `bd create --ac` fails with "unknown flag: --ac". The generated command
    // is meant to be pasted straight into a terminal, so this matters.
    const cmd = buildBdCreateCommand({
      ...base,
      acceptanceCriteria: "Something verifiable",
    });
    expect(cmd).not.toMatch(/--ac\s/);
    expect(cmd).toContain("--acceptance 'Something verifiable'");
  });

  test("normalizes comma-separated labels and drops empties", () => {
    const cmd = buildBdCreateCommand({
      ...base,
      labels: " ui , , dashboard ,",
    });
    expect(cmd).toContain("--labels 'ui,dashboard'");
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
});

describe("what the shell does with the copied command", () => {
  const hostile = String.raw`it's "q" $HOME ${"`"}echo x${"`"} $(echo y) \ \n !x`;

  test.skipIf(!sh)(
    "labels holding $HOME and a backtick command reach bd through sh literally",
    () => {
      const args = argvFromShell(
        buildBdCreateCommand({ ...base, labels: "cost$HOME,`echo x`" }),
      );
      expect(argAfter(args, "--labels")).toBe("cost$HOME,`echo x`");
    },
  );

  test.skipIf(!sh)(
    "every value reaches bd through sh unchanged when it holds quotes, dollars, backticks, backslashes and a bang",
    () => {
      const args = argvFromShell(
        buildBdCreateCommand({
          ...base,
          title: hostile,
          parent: hostile,
          description: `${hostile}\n${hostile}`,
          labels: hostile,
          acceptanceCriteria: `${hostile}\n${hostile}`,
        }),
      );
      expect({
        title: argAfter(args, "--title"),
        parent: argAfter(args, "--parent"),
        description: argAfter(args, "--description"),
        labels: argAfter(args, "--labels"),
        acceptance: argAfter(args, "--acceptance"),
      }).toEqual({
        title: hostile,
        parent: hostile,
        description: `${hostile}\n${hostile}`,
        labels: hostile,
        acceptance: `${hostile}\n${hostile}`,
      });
    },
  );

  test.skipIf(!bash)(
    "a bang reaches bd unchanged through bash with history expansion on, as in an interactive shell",
    () => {
      const args = argvFrom(
        bash ?? "bash",
        buildBdCreateCommand({
          ...base,
          title: "Ship it!now",
          description: "a!b",
          labels: "c!d",
          acceptanceCriteria: "e!f",
        }),
        "set -o history -o histexpand",
      );
      expect({
        title: argAfter(args, "--title"),
        description: argAfter(args, "--description"),
        labels: argAfter(args, "--labels"),
        acceptance: argAfter(args, "--acceptance"),
      }).toEqual({
        title: "Ship it!now",
        description: "a!b",
        labels: "c!d",
        acceptance: "e!f",
      });
    },
  );
});

describe("the repo in the copied command", () => {
  test("adds nothing when Repo is `.`, empty or blank", () => {
    for (const repo of [".", "", "   ", " . ", "./"])
      expect(buildBdCreateCommand({ ...base, repo })).toBe(
        "bd create --type task --priority P2 --title 'My bead'",
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
        "bd create --type task --priority P2 --title '[my-api] My bead'",
      );
  });

  test("is not named twice when the title already starts with it", () => {
    expect(
      buildBdCreateCommand({ ...base, repo: "my-api", title: "[My-API] Fix" }),
    ).toBe("bd create --type task --priority P2 --title '[My-API] Fix'");
  });

  test("stays inside the title's quotes when the name holds a quote or a dollar", () => {
    expect(buildBdCreateCommand({ ...base, repo: "we'ird$x" })).toContain(
      String.raw`--title '[we'\''ird$x] My bead'`,
    );
  });

  test("titleWithRepo gives the title the copied command quotes", () => {
    for (const [title, repo, expected] of [
      ["My bead", ".", "My bead"],
      ["My bead", "", "My bead"],
      ["My bead", "./repos/my-api", "[my-api] My bead"],
      ["[my-api] My bead", "my-api", "[my-api] My bead"],
    ] as const) {
      expect(titleWithRepo(title, repo)).toBe(expected);
      expect(buildBdCreateCommand({ ...base, title, repo })).toContain(
        `--title '${expected}'`,
      );
    }
  });

  test.skipIf(!sh)(
    "reaches bd through sh only as the start of the title",
    () => {
      const args = argvFromShell(
        buildBdCreateCommand({ ...base, repo: "./repos/my-api" }),
      );
      expect(args).not.toContain("--repo");
      expect(argAfter(args, "--title")).toBe("[my-api] My bead");
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
      "bd create --type task --priority P2 --title 'My bead' --acceptance 'First criterion\nSecond criterion\nThird'",
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
      expect(argAfter(args, "--acceptance")).toBe(acceptanceText(criteria));
      expect(args).not.toContain("--repo");
    },
  );

  test.skipIf(!sh)(
    "reach bd through sh unchanged when a line holds quotes, dollars, backticks and backslashes",
    () => {
      const lines = 'say "hi" to $HOME and `id`\nC:\\path\\n stays';
      const args = argvFromShell(
        buildBdCreateCommand({ ...base, acceptanceCriteria: lines }),
      );
      expect(argAfter(args, "--acceptance")).toBe(lines);
    },
  );
});

describe("the issue types the builder knows", () => {
  test("an epic is copied as an epic, not turned into a task", () => {
    expect(BEAD_TYPES).toEqual(["task", "feature", "bug", "chore", "epic"]);
    expect(buildBdCreateCommand({ ...base, type: "epic" })).toBe(
      "bd create --type epic --priority P2 --title 'My bead'",
    );
  });
});

describe("a parent in the copied command", () => {
  test("is passed as --parent, quoted like every other value, when the form has one", () => {
    expect(buildBdCreateCommand({ ...base, parent: "demo-epic.2" })).toBe(
      "bd create --type task --priority P2 --parent 'demo-epic.2' --title 'My bead'",
    );
  });

  test("is left out when the field is empty or blank", () => {
    for (const parent of ["", "   ", undefined])
      expect(buildBdCreateCommand({ ...base, parent })).toBe(
        "bd create --type task --priority P2 --title 'My bead'",
      );
  });

  test("cannot break out of its quotes", () => {
    // A single quote ends the quoted text, so it is written '\'' and nothing
    // else of the value is special inside single quotes.
    const command = buildBdCreateCommand({
      ...base,
      parent: "x' --repo '$(id)`id`",
    });
    expect(command).toContain(
      "--parent 'x'\\'' --repo '\\''$(id)`id`' --title",
    );
  });
});
