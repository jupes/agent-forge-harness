import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssueRepoMap, readRepoContext } from "./repo-context";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A scratch checkout holding these files. */
function checkout(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "af-repo-context-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("parseIssueRepoMap", () => {
  test("reads the issues and title tags", () => {
    const { map, warnings } = parseIssueRepoMap(
      JSON.stringify({
        issues: { "agent-forge-harness-0im": "rag-chat" },
        titleTags: { dnd: "rag-chat" },
      }),
    );
    expect(map).toEqual({
      issues: { "agent-forge-harness-0im": "rag-chat" },
      titleTags: { dnd: "rag-chat" },
    });
    expect(warnings).toEqual([]);
  });

  test("a file that is not JSON gives an empty map and a warning that names the file", () => {
    const { map, warnings } = parseIssueRepoMap("{ not json");
    expect(map).toEqual({ issues: {}, titleTags: {} });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("repos/issue-repos.json is not valid JSON");
  });

  test("an entry whose repository is not a non-empty string is left out, and the warning names it", () => {
    const { map, warnings } = parseIssueRepoMap(
      JSON.stringify({
        issues: { a: "rag-chat", b: 7, c: "  " },
        titleTags: { gga: ["game-guide-ai"] },
      }),
    );
    expect(map).toEqual({ issues: { a: "rag-chat" }, titleTags: {} });
    expect(warnings).toEqual([
      'repos/issue-repos.json: issues["b"] is not a repository name; left out',
      'repos/issue-repos.json: issues["c"] is not a repository name; left out',
      'repos/issue-repos.json: titleTags["gga"] is not a repository name; left out',
    ]);
  });

  test("the committed template, repos/issue-repos.json.example, parses with no warnings", () => {
    const template = readFileSync(
      join(import.meta.dir, "..", "..", "repos", "issue-repos.json.example"),
      "utf8",
    );
    const { map, warnings } = parseIssueRepoMap(template);
    expect(warnings).toEqual([]);
    expect(Object.keys(map.issues).length).toBeGreaterThan(0);
    expect(Object.keys(map.titleTags).length).toBeGreaterThan(0);
  });

  test("a top-level key other than issues and titleTags is warned about", () => {
    const { warnings } = parseIssueRepoMap(
      JSON.stringify({ issues: {}, titletags: { dnd: "rag-chat" } }),
    );
    expect(warnings).toEqual([
      'repos/issue-repos.json: unknown key "titletags" ignored (the keys are "issues" and "titleTags")',
    ]);
  });
});

describe("readRepoContext", () => {
  test("reads the registered names from repos/repos.json and the map from repos/issue-repos.json", () => {
    const root = checkout({
      "repos/repos.json": JSON.stringify({
        repos: [
          { name: "game-guide-ai", url: "u", defaultBranch: "main" },
          { name: "skills", url: "u", defaultBranch: "main", archived: true },
        ],
      }),
      "repos/issue-repos.json": JSON.stringify({
        issues: { "agent-forge-harness-0im": "rag-chat" },
      }),
    });
    const { context, warnings } = readRepoContext(root);
    expect(context).toEqual({
      knownRepos: ["game-guide-ai", "skills"],
      map: {
        issues: { "agent-forge-harness-0im": "rag-chat" },
        titleTags: {},
      },
    });
    expect(warnings).toEqual([]);
  });

  test("with neither file, the context is empty and nothing is warned about", () => {
    const { context, warnings } = readRepoContext(checkout());
    expect(context).toEqual({ knownRepos: [] });
    expect(warnings).toEqual([]);
  });

  test("from a linked worktree, both files are read in the main checkout", () => {
    const main = checkout({
      "repos/repos.json": JSON.stringify({ repos: [{ name: "skills" }] }),
      "repos/issue-repos.json": JSON.stringify({ titleTags: { sk: "skills" } }),
    });
    mkdirSync(join(main, ".git", "worktrees", "w1"), { recursive: true });
    const worktree = checkout({
      ".git": `gitdir: ${join(main, ".git", "worktrees", "w1")}\n`,
    });
    const { context } = readRepoContext(worktree);
    expect(context).toEqual({
      knownRepos: ["skills"],
      map: { issues: {}, titleTags: { sk: "skills" } },
    });
  });
});
