import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BENCH_NAMES } from "../../types/hearth";
import { type FileMap, parseFileMap } from "./filemap";

const ROOT = join(import.meta.dir, "..", "..");

/** The globs of a map that must parse; a refusal fails the test with its error. */
function globs(map: FileMap): string[] {
  if (!map.ok) throw new Error(`refused (${map.reason}): ${map.error}`);
  return map.globs;
}

describe("parseFileMap: a well-formed map", () => {
  test("a `## Files` section gives its globs, one per line, in order", () => {
    const text = [
      "Add the parser.",
      "",
      "## Files",
      "scripts/scheduler/filemap.ts",
      "scripts/scheduler/*.test.ts",
      "docs/**",
    ].join("\n");
    expect(parseFileMap(text)).toEqual({
      ok: true,
      globs: [
        "scripts/scheduler/filemap.ts",
        "scripts/scheduler/*.test.ts",
        "docs/**",
      ],
    });
  });

  test("a deeper heading level is read the same way, so a plan can carry one per checkpoint", () => {
    expect(
      globs(parseFileMap("### Checkpoint A\n\n#### Files\nsrc/a.ts\n")),
    ).toEqual(["src/a.ts"]);
  });

  test("Windows line endings change nothing", () => {
    expect(globs(parseFileMap("## Files\r\nsrc/a.ts\r\nsrc/b.ts\r\n"))).toEqual(
      ["src/a.ts", "src/b.ts"],
    );
  });

  test("`**` alone is a map: the whole repository", () => {
    expect(globs(parseFileMap("## Files\n**\n"))).toEqual(["**"]);
  });
});

describe("parseFileMap: where the section is", () => {
  test("text with no `Files` heading has no map", () => {
    const map = parseFileMap("Just a description.\n\n## Notes\nsrc/a.ts\n");
    expect(map).toMatchObject({ ok: false, reason: "missing" });
  });

  test("a heading that only starts with Files, or a top-level one, is not a file map", () => {
    for (const heading of [
      "## Files to Create / Modify",
      "## Files:",
      "# Files",
      "Files",
    ]) {
      expect({
        heading,
        map: parseFileMap(`${heading}\nsrc/a.ts\n`),
      }).toMatchObject({ heading, map: { ok: false, reason: "missing" } });
    }
  });

  test("the section ends at the next heading of any level, or at a horizontal rule", () => {
    for (const end of ["## Notes", "# Title", "#### Deeper", "---", "***"]) {
      expect({
        end,
        globs: globs(
          parseFileMap(`## Files\nsrc/a.ts\n\n${end}\nnot a glob at all\n`),
        ),
      }).toEqual({ end, globs: ["src/a.ts"] });
    }
  });

  test("only the first `Files` heading is read", () => {
    const text =
      "#### Files\nsrc/a.ts\n\n### Checkpoint B\n\n#### Files\nsrc/b.ts\n";
    expect(globs(parseFileMap(text))).toEqual(["src/a.ts"]);
  });
});

describe("parseFileMap: an empty map", () => {
  test("a heading with nothing under it is empty, not missing", () => {
    expect(parseFileMap("## Files\n")).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(parseFileMap("## Files\n\n## Notes\nsrc/a.ts\n")).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });

  test("a section of blank lines and comments only is empty", () => {
    expect(
      parseFileMap("## Files\n\n<!-- to be filled in -->\n\n"),
    ).toMatchObject({ ok: false, reason: "empty" });
  });
});

describe("parseFileMap: what a line may look like", () => {
  test("blank lines and comment lines are skipped", () => {
    const text = [
      "## Files",
      "<!-- one glob per line, relative to the repository root -->",
      "",
      "src/a.ts",
      "",
      "<!-- the tests -->",
      "src/a.test.ts",
    ].join("\n");
    expect(globs(parseFileMap(text))).toEqual(["src/a.ts", "src/a.test.ts"]);
  });

  test("a list bullet and surrounding backticks are dropped", () => {
    const text = [
      "## Files",
      "- src/a.ts",
      "* `src/b.ts`",
      "+ src/c.ts",
      "`src/d.ts`",
      "  - src/e.ts",
    ].join("\n");
    expect(globs(parseFileMap(text))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
  });

  test("a glob that starts with a star is not mistaken for a bullet", () => {
    expect(globs(parseFileMap("## Files\n*.md\n**/*.test.ts\n"))).toEqual([
      "*.md",
      "**/*.test.ts",
    ]);
  });

  test("a leading ./ is dropped and a trailing slash means everything under it", () => {
    expect(
      globs(parseFileMap("## Files\n./src/a.ts\nscripts/scheduler/\n")),
    ).toEqual(["src/a.ts", "scripts/scheduler/**"]);
  });

  test("duplicate globs collapse, after they are normalised, keeping first order", () => {
    const text =
      "## Files\nsrc/a.ts\nsrc/b.ts\n./src/a.ts\n- `src/b.ts`\nsrc/\nsrc/**\n";
    expect(globs(parseFileMap(text))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/**",
    ]);
  });
});

/** The problems of a map that must be refused as invalid. */
function problems(map: FileMap): Array<{ line: number; why: string }> {
  if (map.ok || map.reason !== "invalid") {
    throw new Error(`expected an invalid map, got ${JSON.stringify(map)}`);
  }
  return map.problems.map(({ line, why }) => ({ line, why }));
}

describe("parseFileMap: what it refuses", () => {
  test("an absolute path", () => {
    for (const entry of [
      "/etc/passwd",
      "C:/Users/x/a.ts",
      "C:\\Users\\x",
      "~/a.ts",
    ]) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [{ line: 2, why: expect.stringContaining("absolute") }],
      });
    }
  });

  test("a path that leaves the repository", () => {
    for (const entry of ["../other/a.ts", "src/../../a.ts", "..", "..\\a.ts"]) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [
          { line: 2, why: expect.stringContaining("leaves the repository") },
        ],
      });
    }
  });

  test("a backslash path", () => {
    expect(problems(parseFileMap("## Files\nsrc\\a.ts\n"))).toEqual([
      { line: 2, why: expect.stringContaining("backslash") },
    ]);
  });

  test("an unfilled placeholder, so a template nobody filled in is never a map", () => {
    expect(problems(parseFileMap("## Files\n<glob>\n"))).toEqual([
      { line: 2, why: expect.stringContaining("no path") },
    ]);
    expect(problems(parseFileMap("## Files\n- `<path/to/file.ts>`\n"))).toEqual(
      [{ line: 2, why: expect.stringContaining("no path") }],
    );
  });

  test("prose: a line with whitespace is never read as a glob", () => {
    expect(
      problems(
        parseFileMap("## Files\nsrc/a.ts\nDemo: bun test src/a.test.ts\n"),
      ),
    ).toEqual([{ line: 3, why: expect.stringContaining("whitespace") }]);
  });

  test("a negation", () => {
    expect(
      problems(parseFileMap("## Files\nsrc/**\n!src/generated/**\n")),
    ).toEqual([{ line: 3, why: expect.stringContaining("negation") }]);
  });

  test("a line that names nothing", () => {
    expect(problems(parseFileMap("## Files\n./\n"))).toEqual([
      { line: 2, why: expect.stringContaining("names nothing") },
    ]);
  });

  test("one bad line refuses the whole map, and every bad line is named with its line number", () => {
    const text = [
      "Intro.",
      "",
      "## Files",
      "src/a.ts",
      "/abs/b.ts",
      "src/c.ts",
      "../d.ts",
    ].join("\n");
    const map = parseFileMap(text);
    expect(map.ok).toBe(false);
    expect(problems(map).map((problem) => problem.line)).toEqual([5, 7]);
    expect(map.ok ? "" : map.error).toContain("line 5");
    expect(map.ok ? "" : map.error).toContain("line 7");
  });
});

// ── The documents that show the format ───────────────────────────────────────

const FILES_HEADING = /^#{2,6}[ \t]+Files$/m;

/** The contents of every fenced block in a Markdown document. */
function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      if (open === null) open = [];
      else {
        blocks.push(open.join("\n"));
        open = null;
      }
    } else if (open !== null) {
      open.push(line);
    }
  }
  return blocks;
}

/** A plan's checkpoints: each `### Checkpoint` heading with the text under it. */
function checkpoints(plan: string): string[] {
  return plan
    .split(/^(?=### Checkpoint\b)/m)
    .filter((part) => part.startsWith("### Checkpoint"));
}

const COMPLEXITY = /complexity:([a-z|<>]+)/g;

describe("the forge-plan documents show a file map the parser reads", () => {
  /** Read inside each test, so a document that is missing fails that test and no other. */
  const document = (...path: string[]): string =>
    readFileSync(
      join(ROOT, ".claude", "skills", "forge-plan", ...path),
      "utf8",
    );
  const skill = (): string => document("SKILL.md");
  const example = (): string => document("references", "example-plan.md");

  test("the template passes exactly as written: its Files blocks hold `**`, the map of a task nobody narrowed", () => {
    const blocks = fencedBlocks(skill()).filter((block) =>
      FILES_HEADING.test(block),
    );
    // The plan template (one map per checkpoint) and the task description.
    expect(blocks).toHaveLength(2);
    const maps = blocks.flatMap((block) => {
      const parts = checkpoints(block);
      return parts.length > 0 ? parts : [block];
    });
    expect(maps.length).toBeGreaterThanOrEqual(3);
    for (const map of maps) {
      expect(parseFileMap(map)).toEqual({ ok: true, globs: ["**"] });
    }
  });

  test("the template names the complexity label with the bench names and nothing else", () => {
    const named = [...skill().matchAll(COMPLEXITY)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const value of named) {
      const values = (value ?? "").replace(/[<>]/g, "").split("|");
      for (const one of values) {
        expect(BENCH_NAMES as readonly string[]).toContain(one);
      }
    }
    expect(skill()).toContain(`complexity:<${BENCH_NAMES.join("|")}>`);
  });

  test("every checkpoint of the example plan has a narrow map that parses, and a complexity label", () => {
    const parts = checkpoints(example());
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      const title = part.split("\n")[0];
      const map = parseFileMap(part);
      expect({ title, ok: map.ok }).toEqual({ title, ok: true });
      expect(globs(map)).not.toContain("**");
      const label = /complexity:(\w+)/.exec(part)?.[1];
      expect({ title, label: BENCH_NAMES.includes(label as never) }).toEqual({
        title,
        label: true,
      });
    }
  });

  test("the maps of the example plan are different per checkpoint", () => {
    const maps = checkpoints(example()).map((part) =>
      globs(parseFileMap(part)).join(","),
    );
    expect(new Set(maps).size).toBe(maps.length);
  });
});
