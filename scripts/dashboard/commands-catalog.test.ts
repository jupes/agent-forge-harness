import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../docs/js/generated/commands";
import { SKILLS } from "../../docs/js/generated/skills";
import {
  CATALOG_MODULE,
  catalogFromDir,
  generate,
  parseCommandFile,
  parseSkillFile,
  renderCatalogModule,
  renderSkillsModule,
  SKILLS_MODULE,
  SUMMARY_LIMIT,
  skillsFromDir,
  summarizeDescription,
} from "./commands-catalog";

const ROOT = resolve(import.meta.dir, "..", "..");
const COMMANDS_DIR = join(ROOT, ".claude", "commands");
const SKILLS_DIR = join(ROOT, ".claude", "skills");

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "commands catalog "));
  scratch.push(dir);
  return dir;
}

/** A command file's text: frontmatter holding the hint, then the rest. */
function command(hint: string, rest: string): string {
  return `---\nargument-hint: ${JSON.stringify(hint)}\n---\n\n${rest}`;
}

function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

describe("parseCommandFile", () => {
  test("reads the command and its description from the first heading, `# /name — description`, and its arguments from the argument-hint", () => {
    expect(
      parseCommandFile(
        "go.md",
        command(
          "[task] [--epic]",
          "# /go — Adaptive Workflow Router\n\nSingle entry point.\n\n# A later heading\n",
        ),
      ),
    ).toEqual({
      ok: true,
      entry: {
        name: "/go",
        argumentHint: "[task] [--epic]",
        description: "Adaptive Workflow Router",
      },
    });
  });

  test("reads a file with CRLF line endings the same way", () => {
    expect(
      parseCommandFile(
        "go.md",
        '---\r\nargument-hint: "[task]"\r\n---\r\n\r\n# /go — Router\r\n\r\nBody.\r\n',
      ),
    ).toEqual({
      ok: true,
      entry: { name: "/go", argumentHint: "[task]", description: "Router" },
    });
  });

  test("a comment in the frontmatter is not the heading", () => {
    expect(
      parseCommandFile(
        "go.md",
        '---\n# a note, not a heading\nargument-hint: "[task]"\n---\n\n# /go — Router\n',
      ),
    ).toEqual({
      ok: true,
      entry: { name: "/go", argumentHint: "[task]", description: "Router" },
    });
  });

  test('an argument-hint of "" is a command that takes no arguments', () => {
    expect(
      parseCommandFile("status.md", command("", "# /status — Workspace\n")),
    ).toEqual({
      ok: true,
      entry: { name: "/status", argumentHint: "", description: "Workspace" },
    });
  });

  test("a first heading that names another command, or has no description, is an error that names the file", () => {
    expect(
      parseCommandFile("go.md", command("[task]", "# /plan — Explore\n")),
    ).toEqual({
      ok: false,
      error:
        'go.md: the first heading must be "# /go — <description>", found "# /plan — Explore"',
    });
    expect(parseCommandFile("go.md", command("[task]", "# /go\n"))).toEqual({
      ok: false,
      error:
        'go.md: the first heading must be "# /go — <description>", found "# /go"',
    });
    expect(
      parseCommandFile("go.md", command("[task]", "No heading at all\n")),
    ).toEqual({
      ok: false,
      error:
        'go.md: the first heading must be "# /go — <description>", found none',
    });
  });

  test("a file with no frontmatter, or none that has an argument-hint, is an error that names the file", () => {
    const missing =
      'go.md: the frontmatter must have an argument-hint (use "" for a command that takes no arguments)';
    expect(parseCommandFile("go.md", "# /go — Router\n")).toEqual({
      ok: false,
      error: missing,
    });
    expect(
      parseCommandFile("go.md", "---\ndescription: x\n---\n# /go — Router\n"),
    ).toEqual({ ok: false, error: missing });
  });

  test("an argument-hint that is not a string is an error: an unquoted [task] is a YAML list", () => {
    expect(
      parseCommandFile(
        "go.md",
        "---\nargument-hint: [task]\n---\n# /go — Router\n",
      ),
    ).toEqual({
      ok: false,
      error:
        'go.md: argument-hint must be a string, found a list (quote it: "[task]" is a string, an unquoted [task] is a YAML list)',
    });
    expect(
      parseCommandFile("go.md", "---\nargument-hint:\n---\n# /go — Router\n"),
    ).toEqual({
      ok: false,
      error:
        'go.md: argument-hint must be a string, found nothing (write "" for a command that takes no arguments)',
    });
  });

  test("frontmatter that is not YAML is an error that names the file", () => {
    const parsed = parseCommandFile(
      "go.md",
      '---\nargument-hint: "[task]\n---\n# /go — Router\n',
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toStartWith(
      "go.md: the frontmatter is not valid YAML",
    );
  });
});

describe("summarizeDescription", () => {
  test("drops the trigger text, from `Use when` on", () => {
    expect(
      summarizeDescription(
        "Register a new sub-repo. Use when the user adds a repo or runs /add-repo.",
      ),
    ).toBe("Register a new sub-repo.");
    expect(
      summarizeDescription(
        "Fact-check a plan. Use this to check a plan before building. Accepts a bead or a path.",
      ),
    ).toBe("Fact-check a plan.");
  });

  test("keeps every sentence before the trigger, so a skill that opens with a label still says what it does", () => {
    expect(
      summarizeDescription(
        "Phase 3 of the Forge pipeline. Execute the plan's Beads tasks. Use when starting /forge-implement.",
      ),
    ).toBe("Phase 3 of the Forge pipeline. Execute the plan's Beads tasks.");
  });

  test("keeps a description that has no trigger whole, and joins its lines into one", () => {
    expect(
      summarizeDescription(
        "Ultra-compressed communication mode that\n  preserves technical accuracy\nwhile dropping filler.",
      ),
    ).toBe(
      "Ultra-compressed communication mode that preserves technical accuracy while dropping filler.",
    );
  });

  test("a description that opens with its trigger is not emptied", () => {
    expect(summarizeDescription("Use when the user asks for a glossary.")).toBe(
      "Use when the user asks for a glossary.",
    );
  });

  test(`cuts a description longer than ${SUMMARY_LIMIT} characters at a word, with an ellipsis, within the limit`, () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const long = words.join(" ");
    const summary = summarizeDescription(long);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(summary.endsWith("…")).toBe(true);
    const kept = summary.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  test("a description of exactly the limit is kept; one character more is cut", () => {
    const exact = `${"a".repeat(SUMMARY_LIMIT - 4)} bbb`;
    expect(exact.length).toBe(SUMMARY_LIMIT);
    expect(summarizeDescription(exact)).toBe(exact);
    expect(summarizeDescription(`${exact}b`).endsWith("…")).toBe(true);
  });

  test("a cut does not leave a comma or a dash in front of the ellipsis", () => {
    const text = `${"x".repeat(100)}, ${"y".repeat(100)}`;
    expect(summarizeDescription(text)).toBe(`${"x".repeat(100)}…`);
    const dashed = `${"x".repeat(100)} — ${"y".repeat(100)}`;
    expect(summarizeDescription(dashed)).toBe(`${"x".repeat(100)}…`);
  });
});

describe("parseSkillFile", () => {
  test("reads the skill's name and a shortened description from its frontmatter", () => {
    expect(
      parseSkillFile(
        "tdd/SKILL.md",
        "---\nname: tdd\ndescription: Run red-green-refactor in vertical slices. Use when building a feature.\n---\n\n# tdd\n",
      ),
    ).toEqual({
      ok: true,
      entry: {
        name: "tdd",
        summary: "Run red-green-refactor in vertical slices.",
      },
    });
  });

  test("a skill in a file not named SKILL.md is marked not loaded: Claude Code reads only SKILL.md", () => {
    const text = "---\nname: ui-shot\ndescription: Takes shots.\n---\n";
    expect(parseSkillFile("ui-shot/ui-shot.md", text)).toEqual({
      ok: true,
      entry: { name: "ui-shot", summary: "Takes shots.", notLoaded: true },
    });
    const loaded = parseSkillFile("ui-shot/SKILL.md", text);
    expect(loaded.ok && "notLoaded" in loaded.entry).toBe(false);
  });

  test("reads a description folded over several lines", () => {
    expect(
      parseSkillFile(
        "caveman/SKILL.md",
        "---\nname: caveman\ndescription: >-\n  Ultra-compressed mode that\n  drops filler. Use when asked.\n---\n",
      ),
    ).toEqual({
      ok: true,
      entry: {
        name: "caveman",
        summary: "Ultra-compressed mode that drops filler.",
      },
    });
  });

  test("a file with no frontmatter is an error that names the file", () => {
    expect(parseSkillFile("tdd/SKILL.md", "# tdd\n")).toEqual({
      ok: false,
      error:
        "tdd/SKILL.md: the file must open with a frontmatter block holding a name and a description",
    });
  });

  test("a name that is not the folder's name is an error: sync-codex and Codex would disagree on it", () => {
    expect(
      parseSkillFile(
        "tdd/SKILL.md",
        "---\nname: test-driven\ndescription: Run red-green-refactor.\n---\n",
      ),
    ).toEqual({
      ok: false,
      error: 'tdd/SKILL.md: name must be "tdd", found "test-driven"',
    });
    expect(
      parseSkillFile("tdd/SKILL.md", "---\ndescription: Run it.\n---\n"),
    ).toEqual({
      ok: false,
      error: 'tdd/SKILL.md: name must be "tdd", found nothing',
    });
  });

  test("a missing, empty or non-string description is an error that names the file", () => {
    const error = "tdd/SKILL.md: the frontmatter must have a description";
    expect(parseSkillFile("tdd/SKILL.md", "---\nname: tdd\n---\n")).toEqual({
      ok: false,
      error,
    });
    expect(
      parseSkillFile("tdd/SKILL.md", '---\nname: tdd\ndescription: ""\n---\n'),
    ).toEqual({ ok: false, error });
    expect(
      parseSkillFile("tdd/SKILL.md", "---\nname: tdd\ndescription: [a]\n---\n"),
    ).toEqual({ ok: false, error });
  });

  test("frontmatter that is not YAML is an error that names the file", () => {
    const parsed = parseSkillFile(
      "tdd/SKILL.md",
      '---\nname: tdd\ndescription: "Run it.\n---\n',
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toStartWith(
      "tdd/SKILL.md: the frontmatter is not valid YAML",
    );
  });
});

describe("skillsFromDir", () => {
  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: Does ${name}. Use when asked.\n---\n`;

  test("lists each folder's skill by name, reading <folder>.md where a folder has no SKILL.md, and skips plain files", () => {
    const root = scratchRoot();
    write(root, "zoom-out/SKILL.md", skill("zoom-out"));
    write(root, "alpha/SKILL.md", skill("alpha"));
    write(root, "ui-shot/ui-shot.md", skill("ui-shot"));
    write(root, "ATTRIBUTION.md", "Credits.\n");
    expect(skillsFromDir(root)).toEqual({
      entries: [
        { name: "alpha", summary: "Does alpha." },
        { name: "ui-shot", summary: "Does ui-shot.", notLoaded: true },
        { name: "zoom-out", summary: "Does zoom-out." },
      ],
      errors: [],
    });
  });

  test("a folder with neither SKILL.md nor <folder>.md is an error that names it; the others are still listed", () => {
    const root = scratchRoot();
    write(root, "alpha/SKILL.md", skill("alpha"));
    write(root, "empty/notes.txt", "nothing\n");
    expect(skillsFromDir(root)).toEqual({
      entries: [{ name: "alpha", summary: "Does alpha." }],
      errors: ["empty: the folder has neither SKILL.md nor empty.md"],
    });
  });

  test("a SKILL.md that does not parse is an error that names the file", () => {
    const root = scratchRoot();
    write(root, "alpha/SKILL.md", "# alpha\n");
    expect(skillsFromDir(root).errors).toEqual([
      "alpha/SKILL.md: the file must open with a frontmatter block holding a name and a description",
    ]);
  });
});

/**
 * The repo's own formatter, run on text as if it were a generated module (the
 * installed binary, never fetched): what `bun run lint` would make of it.
 */
function formatted(text: string): string {
  const biome = join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "biome.exe" : "biome",
  );
  const run = Bun.spawnSync(
    [biome, "format", "--stdin-file-path", join(ROOT, SKILLS_MODULE)],
    {
      cwd: ROOT,
      stdin: Buffer.from(text),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

describe("the generated modules, whatever the text in them", () => {
  const texts = [
    'Say "hi" to the "world"',
    "Don't stop, it's fine",
    `Both: "one" and "two" and "three" with 'one' and 'two'`,
    `Both: 'one' and 'two' and 'three' with "one" and "two"`,
    `Even: it's a "quoted word`,
    'A back\\slash before "a quote" and "another"',
    `A back\\slash before a single quote\\'s end and "q"`,
    `${"x".repeat(70)} "quoted" "twice"`,
    `${"y".repeat(60)} don't`,
    "日本語のテキスト".repeat(5),
    `${"z".repeat(55)} 日本語 "q" "r"`,
  ];

  test("the formatter changes none of them: the quote is the one it chooses, and it wraps where it wraps", () => {
    const commands = renderCatalogModule(
      texts.map((text, i) => ({
        name: `/c${i}`,
        argumentHint: text,
        description: text,
      })),
    );
    const skills = renderSkillsModule(
      texts.map((summary, i) => ({ name: `s${i}`, summary })),
    );
    expect(formatted(commands)).toBe(commands);
    expect(formatted(skills)).toBe(skills);
  }, 30_000);

  test("each is the text it was given, once the module is read back", async () => {
    const skills = renderSkillsModule(
      texts.map((summary, i) => ({ name: `s${i}`, summary })),
    );
    const dir = scratchRoot();
    write(dir, "skills.ts", skills.replace(/^import type .*\n/m, ""));
    const loaded = (await import(join(dir, "skills.ts"))) as {
      SKILLS: { summary: string }[];
    };
    expect(loaded.SKILLS.map((skill) => skill.summary)).toEqual(texts);
  });
});

describe("generate", () => {
  test("writes the two modules the Commands page imports, from .claude/commands and .claude/skills", () => {
    const root = scratchRoot();
    write(
      root,
      ".claude/commands/go.md",
      command("[task]", "# /go — Router\n"),
    );
    write(
      root,
      ".claude/skills/tdd/SKILL.md",
      "---\nname: tdd\ndescription: Run red-green-refactor. Use when building.\n---\n",
    );
    expect(generate(root)).toEqual({
      ok: true,
      data: { wrote: [CATALOG_MODULE, SKILLS_MODULE], commands: 1, skills: 1 },
    });
    expect(readFileSync(join(root, CATALOG_MODULE), "utf8")).toBe(
      renderCatalogModule([
        { name: "/go", argumentHint: "[task]", description: "Router" },
      ]),
    );
    expect(readFileSync(join(root, SKILLS_MODULE), "utf8")).toBe(
      renderSkillsModule([{ name: "tdd", summary: "Run red-green-refactor." }]),
    );
  });

  test("writes neither module, and reports every file that does not parse, when any does not", () => {
    const root = scratchRoot();
    write(root, ".claude/commands/go.md", "# /go — Router\n");
    write(root, ".claude/skills/tdd/SKILL.md", "# tdd\n");
    const result = generate(root);
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain(
      "go.md: the frontmatter must have an argument-hint",
    );
    expect(error).toContain(
      "tdd/SKILL.md: the file must open with a frontmatter",
    );
    expect(readdirSync(root).includes("docs")).toBe(false);
  });
});

describe("the Commands page catalog", () => {
  test("every command file under .claude/commands has an entry on the Commands page, and the page lists no other", () => {
    const files = readdirSync(COMMANDS_DIR)
      .filter((file) => file.endsWith(".md"))
      .map((file) => `/${file.slice(0, -".md".length)}`)
      .sort();
    const shown = COMMANDS.map((command) => command.name);
    expect({
      missing: files.filter((name) => !shown.includes(name)),
      extra: shown.filter((name) => !files.includes(name)),
    }).toEqual({ missing: [], extra: [] });
  });

  test("every command file's frontmatter and heading parse", () => {
    expect(catalogFromDir(COMMANDS_DIR).errors).toEqual([]);
  });

  test("every command's row shows the argument-hint its file gives", () => {
    const byName = (a: unknown[], b: unknown[]) =>
      String(a[0]) < String(b[0]) ? -1 : 1;
    const expected = readdirSync(COMMANDS_DIR)
      .filter((file) => file.endsWith(".md"))
      .map((file) => {
        const hint = /^argument-hint: "(.*)"\s*$/m.exec(
          readFileSync(join(COMMANDS_DIR, file), "utf8"),
        );
        if (!hint)
          throw new Error(`${file} has no double-quoted argument-hint`);
        return [`/${file.slice(0, -".md".length)}`, hint[1] ?? ""];
      })
      .sort(byName);
    const shown = COMMANDS.map((c) => [c.name, c.argumentHint]).sort(byName);
    expect(shown).toEqual(expected);
  });

  test(`${CATALOG_MODULE} is what bun run dashboard:commands writes from .claude/commands`, () => {
    const { entries } = catalogFromDir(COMMANDS_DIR);
    expect(readFileSync(join(ROOT, CATALOG_MODULE), "utf8")).toBe(
      renderCatalogModule(entries),
    );
  });
});

describe("the Commands page skills", () => {
  test("every skill folder under .claude/skills has an entry on the Commands page, and the page lists no other", () => {
    const folders = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const shown = SKILLS.map((skill) => skill.name);
    expect({
      missing: folders.filter((name) => !shown.includes(name)),
      extra: shown.filter((name) => !folders.includes(name)),
    }).toEqual({ missing: [], extra: [] });
  });

  test("every skill file's frontmatter parses", () => {
    expect(skillsFromDir(SKILLS_DIR).errors).toEqual([]);
  });

  test(`${SKILLS_MODULE} is what bun run dashboard:commands writes from .claude/skills`, () => {
    const { entries } = skillsFromDir(SKILLS_DIR);
    expect(readFileSync(join(ROOT, SKILLS_MODULE), "utf8")).toBe(
      renderSkillsModule(entries),
    );
  });
});
