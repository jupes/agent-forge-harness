import { describe, expect, test } from "bun:test";
import { runFileMapCli } from "./filemap-cli";

/** A reader over named texts, so no file is touched. */
const files =
  (texts: Record<string, string>) =>
  (path: string): string => {
    const text = texts[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };

const DESCRIPTION = "Build the thing.\n\n## Files\nsrc/a.ts\nsrc/a.test.ts\n";
const PLAN = [
  "### Checkpoint A — first",
  "#### Files",
  "src/a.ts",
  "",
  "### Checkpoint B — second",
  "#### Files",
  "src/b.ts",
].join("\n");

describe("the file-map check command (its function, with an injected reader)", () => {
  test("a task description with a usable map exits 0 and prints its globs", () => {
    const outcome = runFileMapCli(["task.md"], {
      read: files({ "task.md": DESCRIPTION }),
    });
    expect(outcome).toEqual({
      code: 0,
      body: {
        ok: true,
        data: { ok: true, globs: ["src/a.ts", "src/a.test.ts"] },
        error: null,
      },
    });
  });

  test("a map the parser refuses exits 2 and says which line and why", () => {
    const outcome = runFileMapCli(["task.md"], {
      read: files({ "task.md": "## Files\nsrc/a.ts\n<glob>\n" }),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.body.ok).toBe(false);
    expect(outcome.body.error).toContain("line 3");
    expect(outcome.body.data).toMatchObject({ reason: "invalid" });
  });

  test("a description with no Files section exits 2", () => {
    const outcome = runFileMapCli(["task.md"], {
      read: files({ "task.md": "Just words.\n" }),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.body.data).toMatchObject({ reason: "missing" });
  });

  test("--plan reads every checkpoint, and exits 0 only when each has a usable map", () => {
    const good = runFileMapCli(["plan.md", "--plan"], {
      read: files({ "plan.md": PLAN }),
    });
    expect(good.code).toBe(0);
    expect(good.body.data).toEqual({
      checkpoints: [
        {
          checkpoint: "Checkpoint A — first",
          map: { ok: true, globs: ["src/a.ts"] },
        },
        {
          checkpoint: "Checkpoint B — second",
          map: { ok: true, globs: ["src/b.ts"] },
        },
      ],
    });

    const bad = runFileMapCli(["--plan", "plan.md"], {
      read: files({
        "plan.md": PLAN.replace("src/b.ts", "src/b.ts and more"),
      }),
    });
    expect(bad.code).toBe(2);
    expect(bad.body.error).toContain("Checkpoint B — second");
    expect(bad.body.error).not.toContain("Checkpoint A");
  });

  test("--plan on a text with no checkpoint exits 2 rather than passing an empty plan", () => {
    const outcome = runFileMapCli(["plan.md", "--plan"], {
      read: files({ "plan.md": DESCRIPTION }),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.body.error).toContain("no `Checkpoint` heading");
  });

  test("no file, an unknown flag and an unreadable file exit 2", () => {
    const read = files({});
    expect(runFileMapCli([], { read }).body.error).toContain("usage:");
    expect(runFileMapCli(["task.md", "--paln"], { read }).body.error).toContain(
      "usage:",
    );
    const missing = runFileMapCli(["nope.md"], { read });
    expect(missing.code).toBe(2);
    expect(missing.body.error).toContain("cannot read nope.md");
  });

  test("`-` is taken as the place to read, not as a flag (the command maps it to standard input; that mapping is not run here)", () => {
    const outcome = runFileMapCli(["-"], {
      read: files({ "-": DESCRIPTION }),
    });
    expect(outcome.code).toBe(0);
  });
});

describe("the file-map check command: a description straight from Beads, and a plan given as a description", () => {
  const stored = "Do the thing.\n\n## Files\nsrc/a.ts\nscripts/forge/**/*.ts\n";
  const asBd = (issue: unknown): string => JSON.stringify(issue);

  test("--bd-json reads the map from the description field of what `bd show <id> --json` prints", () => {
    for (const printed of [
      asBd([{ id: "bd-1", description: stored }]),
      asBd({ id: "bd-1", description: stored }),
    ]) {
      const outcome = runFileMapCli(["-", "--bd-json"], {
        read: files({ "-": printed }),
      });
      expect(outcome.code).toBe(0);
      expect(outcome.body.data).toEqual({
        ok: true,
        globs: ["src/a.ts", "scripts/forge/**/*.ts"],
      });
    }
  });

  test("--bd-json on something that is not that output exits 2 and says what it expects", () => {
    for (const printed of [
      "not json at all",
      asBd([]),
      asBd([{ id: "bd-1" }]),
      asBd(7),
    ]) {
      const outcome = runFileMapCli(["-", "--bd-json"], {
        read: files({ "-": printed }),
      });
      expect({ printed, code: outcome.code }).toEqual({ printed, code: 2 });
      expect(outcome.body.error).toContain("bd show <id> --json");
    }
  });

  test("that output without --bd-json is not reported as a task with no map: the refusal names the flag", () => {
    const outcome = runFileMapCli(["-"], {
      read: files({ "-": asBd([{ id: "bd-1", description: stored }]) }),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.body.error).toContain("--bd-json");
  });

  test("--bd-json and --plan together are refused", () => {
    const outcome = runFileMapCli(["-", "--bd-json", "--plan"], {
      read: files({ "-": asBd([{ description: stored }]) }),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.body.error).toContain("usage:");
  });

  test("a plan given without --plan is refused, rather than passed on its first checkpoint alone", () => {
    const outcome = runFileMapCli(["plan.md"], {
      read: files({
        "plan.md": PLAN.replace("src/b.ts", "src/b.ts and more"),
      }),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.body.error).toContain("--plan");
  });
});

describe("the file-map check command: a task whose description carries its checkpoint heading", () => {
  test("--bd-json reads it as the one task it is, not as a plan", () => {
    const stored =
      "### Checkpoint A — The export document\nBuild it.\n\n## Files\nsrc/settings/export.ts\n";
    const outcome = runFileMapCli(["-", "--bd-json"], {
      read: files({
        "-": JSON.stringify([{ id: "bd-1", description: stored }]),
      }),
    });
    expect(outcome.code).toBe(0);
    expect(outcome.body.data).toEqual({
      ok: true,
      globs: ["src/settings/export.ts"],
    });
  });
});
