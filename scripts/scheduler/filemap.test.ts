import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BENCH_NAMES } from "../../types/hearth";
import { type FileMap, parseFileMap, parsePlanFileMaps } from "./filemap";

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

  test("the section ends at the next heading of level two or deeper, or at a horizontal rule", () => {
    for (const end of ["## Notes", "#### Deeper", "---", "***"]) {
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

describe("parseFileMap: a line is judged as the glob it becomes", () => {
  test("a path that is absolute, negated or home-relative once its ./ and bullet are gone is refused like any other", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [".//etc/passwd", "absolute"],
      ["- `.//abs/a.ts`", "absolute"],
      ["./~/x", "absolute"],
      ["././/x", "absolute"],
      ["./!src/a.ts", "negation"],
      ["./../a.ts", "leaves the repository"],
    ];
    for (const [entry, why] of cases) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [{ line: 2, why: expect.stringContaining(why) }],
      });
    }
  });

  test("brace alternation is not part of the format: it could hide a `..` or a second path", () => {
    for (const entry of ["{..,src}/a.ts", "src/{a,b}.ts", "src/a.{ts,tsx}"]) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [{ line: 2, why: expect.stringContaining("alternation") }],
      });
    }
  });

  test("the wildcards are *, ** and ?; brackets stand for themselves", () => {
    expect(
      globs(parseFileMap("## Files\nsrc/**/a?.ts\napp/[id]/page.tsx\n*.md\n")),
    ).toEqual(["src/**/a?.ts", "app/[id]/page.tsx", "*.md"]);
  });

  test("a line that names nothing: an empty bullet, a lone dot, a bare ./", () => {
    for (const entry of ["-", "+", ".", "./", "- ."]) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\nsrc/a.ts\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [{ line: 3, why: expect.stringContaining("names nothing") }],
      });
    }
  });

  test("a `# …` line inside the section is refused, not taken as its end: the globs after it are not dropped unseen", () => {
    const map = parseFileMap("## Files\nsrc/a.ts\n# tests\nsrc/a.test.ts\n");
    expect(problems(map)).toEqual([
      { line: 3, why: expect.stringContaining("comment") },
    ]);
  });

  test("a heading of level two or deeper still ends the section", () => {
    expect(
      globs(
        parseFileMap("#### Files\nsrc/a.ts\n### Checkpoint B\nnot a glob\n"),
      ),
    ).toEqual(["src/a.ts"]);
  });
});

describe("parsePlanFileMaps: one map per checkpoint of a plan", () => {
  const plan = [
    "# Plan: demo",
    "",
    "## Build Sequence & Checkpoints",
    "",
    "### Checkpoint A — first",
    "Steps: one",
    "",
    "#### Files",
    "src/a.ts",
    "",
    "### Checkpoint B — second",
    "Steps: two",
    "",
    "#### Files",
    "src/b.ts",
    "src/b.test.ts",
    "",
    "## Files to Create / Modify",
    "| File | Purpose |",
    "",
    "## Files",
    "src/not-a-checkpoint.ts",
  ].join("\n");

  test("each `### Checkpoint` heading gives its title and the map under it", () => {
    expect(parsePlanFileMaps(plan)).toEqual([
      {
        checkpoint: "Checkpoint A — first",
        map: { ok: true, globs: ["src/a.ts"] },
      },
      {
        checkpoint: "Checkpoint B — second",
        map: { ok: true, globs: ["src/b.ts", "src/b.test.ts"] },
      },
    ]);
  });

  test("a checkpoint ends at the next heading of its level or above, so a later `Files` section is not its map", () => {
    const withoutMap = plan.replace(
      "#### Files\nsrc/b.ts\nsrc/b.test.ts\n",
      "",
    );
    expect(parsePlanFileMaps(withoutMap)[1]).toMatchObject({
      checkpoint: "Checkpoint B — second",
      map: { ok: false, reason: "missing" },
    });
  });

  test("a broken map in a later checkpoint is found, which parsing the whole plan as one text misses", () => {
    const broken = plan.replace("src/b.ts\n", "src/b.ts and whatever else\n");
    expect(parseFileMap(broken)).toEqual({ ok: true, globs: ["src/a.ts"] });
    const maps = parsePlanFileMaps(broken);
    expect(maps[0]?.map.ok).toBe(true);
    expect(maps[1]?.map).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("a text with no checkpoint heading has no checkpoints", () => {
    expect(parsePlanFileMaps("## Files\nsrc/a.ts\n")).toEqual([]);
  });
});

describe("parseFileMap: what the second review found", () => {
  test("`**` is a whole segment: inside one it has no meaning here, and what plain `bd show` makes of a glob is refused", () => {
    for (const entry of [
      "src/**a/b.ts",
      "src/a**/b.ts",
      "src/***/a.ts",
      "**scripts/forge/****/*.ts",
    ]) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [{ line: 2, why: expect.stringContaining("whole segment") }],
      });
    }
    expect(
      globs(parseFileMap("## Files\n**\nsrc/**\n**/a.ts\nsrc/**/a.ts\n")),
    ).toEqual(["**", "src/**", "**/a.ts", "src/**/a.ts"]);
  });

  test("a line that starts with `#` is never a glob, with or without a space after it", () => {
    for (const entry of ["#tests", "#", "# tests"]) {
      expect({
        entry,
        problems: problems(parseFileMap(`## Files\nsrc/a.ts\n${entry}\n`)),
      }).toEqual({
        entry,
        problems: [{ line: 3, why: expect.stringContaining("comment") }],
      });
    }
  });

  test("control and format characters are refused: soft hyphen and direction marks as well as NUL and zero-width space", () => {
    const hidden = [
      0x0000, 0x0007, 0x00ad, 0x061c, 0x200b, 0x200e, 0x2060, 0xfeff,
    ];
    for (const code of hidden) {
      const entry = `src/a${String.fromCodePoint(code)}b.ts`;
      expect({
        code: code.toString(16),
        problems: problems(parseFileMap(`## Files\n${entry}\n`)),
      }).toEqual({
        code: code.toString(16),
        problems: [
          { line: 2, why: expect.stringContaining("control or format") },
        ],
      });
    }
  });

  test("a letter outside ASCII is a path character like any other", () => {
    expect(globs(parseFileMap("## Files\ndocs/résumé.md\n"))).toEqual([
      "docs/résumé.md",
    ]);
  });
});

describe("parsePlanFileMaps: what the second review found", () => {
  test("a refusal names the line of the plan, not of the checkpoint", () => {
    const plan = [
      "# Plan: demo", // 1
      "", // 2
      "### Checkpoint A — first", // 3
      "#### Files", // 4
      "src/a.ts", // 5
      "", // 6
      "### Checkpoint B — second", // 7
      "Steps: two", // 8
      "", // 9
      "#### Files", // 10
      "src/b.ts", // 11
      "src/b and more", // 12
    ].join("\n");
    const second = parsePlanFileMaps(plan)[1]?.map;
    expect(second).toMatchObject({
      ok: false,
      reason: "invalid",
      problems: [{ line: 12, text: "src/b and more" }],
    });
    expect(second?.ok === false ? second.error : "").toContain("line 12");
  });

  test("a `#` line inside a fenced block does not end the checkpoint", () => {
    const plan = [
      "### Checkpoint A — first",
      "Demo:",
      "```bash",
      "# run the tests",
      "bun test src/a.test.ts",
      "```",
      "",
      "#### Files",
      "src/a.ts",
    ].join("\n");
    expect(parsePlanFileMaps(plan)).toEqual([
      {
        checkpoint: "Checkpoint A — first",
        map: { ok: true, globs: ["src/a.ts"] },
      },
    ]);
  });

  test("a `Files` heading at the checkpoint's own level is still its map", () => {
    const plan =
      "### Checkpoint A — first\nSteps: one\n\n### Files\nsrc/a.ts\n\n### Checkpoint B — second\n\n### Files\nsrc/b.ts\n";
    expect(parsePlanFileMaps(plan).map(({ map }) => map)).toEqual([
      { ok: true, globs: ["src/a.ts"] },
      { ok: true, globs: ["src/b.ts"] },
    ]);
  });

  test("a checkpoint heading at another level is read too, so a mis-levelled one is not skipped unseen", () => {
    const plan =
      "### Checkpoint A — first\n#### Files\nsrc/a.ts\n\n#### Checkpoint B — second\n##### Files\nsrc/b and more\n";
    const maps = parsePlanFileMaps(plan);
    expect(maps.map(({ checkpoint }) => checkpoint)).toEqual([
      "Checkpoint A — first",
      "Checkpoint B — second",
    ]);
    expect(maps[0]?.map).toEqual({ ok: true, globs: ["src/a.ts"] });
    expect(maps[1]?.map).toMatchObject({ ok: false, reason: "invalid" });
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
    // A block with checkpoints is the plan template; the other is one description.
    const maps = blocks.flatMap((block) => {
      const perCheckpoint = parsePlanFileMaps(block).map(({ map }) => map);
      return perCheckpoint.length > 0 ? perCheckpoint : [parseFileMap(block)];
    });
    expect(maps.length).toBeGreaterThanOrEqual(3);
    for (const map of maps) {
      expect(map).toEqual({ ok: true, globs: ["**"] });
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
    const parts = parsePlanFileMaps(example());
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const { checkpoint, map } of parts) {
      expect({ checkpoint, ok: map.ok }).toEqual({ checkpoint, ok: true });
      expect(globs(map)).not.toContain("**");
    }
    // One label line per checkpoint, each a bench name.
    const labels = [...example().matchAll(/^Label: `complexity:(\w+)`$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(labels).toHaveLength(parts.length);
    for (const label of labels) {
      expect(BENCH_NAMES as readonly string[]).toContain(label);
    }
  });

  test("the maps of the example plan are different per checkpoint", () => {
    const maps = parsePlanFileMaps(example()).map(({ map }) =>
      globs(map).join(","),
    );
    expect(new Set(maps).size).toBe(maps.length);
  });
});
