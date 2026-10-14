import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../docs/js/generated/commands";
import {
  CATALOG_MODULE,
  catalogFromDir,
  parseCommandFile,
  renderCatalogModule,
} from "./commands-catalog";

const ROOT = resolve(import.meta.dir, "..", "..");
const COMMANDS_DIR = join(ROOT, ".claude", "commands");

describe("parseCommandFile", () => {
  test("reads the command and its description from the first heading, `# /name — description`", () => {
    expect(
      parseCommandFile(
        "go.md",
        "# /go — Adaptive Workflow Router\n\nSingle entry point.\n\n# A later heading\n",
      ),
    ).toEqual({
      ok: true,
      entry: { name: "/go", description: "Adaptive Workflow Router" },
    });
  });

  test("a first heading that names another command, or has no description, is an error that names the file", () => {
    expect(parseCommandFile("go.md", "# /plan — Explore\n")).toEqual({
      ok: false,
      error:
        'go.md: the first heading must be "# /go — <description>", found "# /plan — Explore"',
    });
    expect(parseCommandFile("go.md", "# /go\n")).toEqual({
      ok: false,
      error:
        'go.md: the first heading must be "# /go — <description>", found "# /go"',
    });
    expect(parseCommandFile("go.md", "No heading at all\n")).toEqual({
      ok: false,
      error:
        'go.md: the first heading must be "# /go — <description>", found none',
    });
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

  test("every command file's heading parses", () => {
    expect(catalogFromDir(COMMANDS_DIR).errors).toEqual([]);
  });

  test(`${CATALOG_MODULE} is what bun run dashboard:commands writes from .claude/commands`, () => {
    const { entries } = catalogFromDir(COMMANDS_DIR);
    expect(readFileSync(join(ROOT, CATALOG_MODULE), "utf8")).toBe(
      renderCatalogModule(entries),
    );
  });
});
