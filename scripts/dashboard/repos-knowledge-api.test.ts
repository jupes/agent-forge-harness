import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ageInDays,
  buildRepoEntries,
  freshnessFor,
  parseReposConfig,
  sharedConventionsFrom,
  worktreeViews,
} from "../../scripts/dashboard/repos-knowledge-model";
import type { WorktreeEntry } from "../../types/beads";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const DAY = 86_400_000;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** repos.json exactly as scripts/setup.ts writes it. */
function reposJson(...repos: Record<string, unknown>[]): string {
  return JSON.stringify({ repos });
}

describe("freshness bands", () => {
  test("splits knowledge age into current, aging and stale", () => {
    expect(freshnessFor(0)).toBe("current");
    expect(freshnessFor(14)).toBe("current");
    expect(freshnessFor(15)).toBe("aging");
    expect(freshnessFor(30)).toBe("aging");
    expect(freshnessFor(31)).toBe("stale");
    expect(freshnessFor(null)).toBe("missing");
  });

  test("ageInDays floors to whole days and never goes negative", () => {
    expect(ageInDays(NOW - 3 * DAY, NOW)).toBe(3);
    expect(ageInDays(NOW + DAY, NOW)).toBe(0);
    expect(ageInDays(null, NOW)).toBeNull();
  });
});

describe("parseReposConfig", () => {
  test("reads the canonical { repos: [...] } file", () => {
    expect(
      parseReposConfig(
        reposJson({ name: "a", url: "u", defaultBranch: "main" }),
      ),
    ).toEqual([{ name: "a", url: "u", defaultBranch: "main" }]);
  });

  test("returns nothing rather than throwing on bad input", () => {
    expect(parseReposConfig(null)).toEqual([]);
    expect(parseReposConfig("nope")).toEqual([]);
    expect(parseReposConfig("{}")).toEqual([]);
  });
});

describe("buildRepoEntries", () => {
  test("shows defaultBranch — the canonical field — in the branch column", () => {
    // The first version read a non-existent `branch` field, so every real repo
    // rendered a dash.
    const [entry] = buildRepoEntries({
      reposJson: reposJson({
        name: "game-guide-ai",
        url: "https://github.com/jupes/game-guide-ai.git",
        defaultBranch: "master",
      }),
      clonedDirs: ["game-guide-ai"],
      knowledge: new Map([["game-guide-ai", 3]]),
      now: NOW,
    });
    expect(entry).toEqual({
      name: "game-guide-ai",
      path: "repos/game-guide-ai",
      url: "https://github.com/jupes/game-guide-ai.git",
      defaultBranch: "master",
      cloned: true,
      knowledgeFile: "knowledge/repos/game-guide-ai.yaml",
      knowledgeAgeDays: 3,
      freshness: "current",
      archived: false,
    });
  });

  test("ignores a non-canonical `branch` field instead of guessing from it", () => {
    const [entry] = buildRepoEntries({
      reposJson: reposJson({ name: "x", branch: "dev" }),
      clonedDirs: [],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entry?.defaultBranch).toBeNull();
  });

  test("marks a registered repo that has not been cloned", () => {
    const [entry] = buildRepoEntries({
      reposJson: reposJson({ name: "farrealms-web", defaultBranch: "main" }),
      clonedDirs: [],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entry?.cloned).toBe(false);
    expect(entry?.freshness).toBe("missing");
  });

  test("still lists a cloned directory nobody registered", () => {
    const entries = buildRepoEntries({
      reposJson: reposJson(),
      clonedDirs: ["surprise-repo"],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries.map((entry) => entry.name)).toEqual(["surprise-repo"]);
    expect(entries[0]?.cloned).toBe(true);
  });

  test("carries archived from repos.json: only the boolean true archives a repository", () => {
    const entries = buildRepoEntries({
      reposJson: reposJson(
        { name: "old-docs", archived: true },
        { name: "web", archived: false },
        { name: "plain" },
        { name: "yes-string", archived: "yes" },
        { name: "one", archived: 1 },
      ),
      clonedDirs: ["surprise-repo"],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries.map((entry) => [entry.name, entry.archived])).toEqual([
      ["old-docs", true],
      ["one", false],
      ["plain", false],
      ["surprise-repo", false],
      ["web", false],
      ["yes-string", false],
    ]);
  });

  test("does not band an archived repository's knowledge age into aging or stale", () => {
    // /sync-knowledge --all skips an archived repository, so its file is not
    // overdue for a refresh however old it is; the age is still reported.
    const entries = buildRepoEntries({
      reposJson: reposJson(
        { name: "frozen-api", archived: true },
        { name: "frozen-docs", archived: true },
        { name: "frozen-new", archived: true },
        { name: "frozen-none", archived: true },
        { name: "frozen-unreadable", archived: true },
        { name: "live-api", archived: false },
      ),
      clonedDirs: [],
      knowledge: new Map([
        ["frozen-api", 400],
        ["frozen-docs", 20],
        ["frozen-new", 2],
        ["frozen-unreadable", null],
        ["live-api", 400],
      ]),
      now: NOW,
    });
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("frozen-api")).toMatchObject({
      archived: true,
      knowledgeAgeDays: 400,
      freshness: "archived",
    });
    expect(byName.get("frozen-docs")?.freshness).toBe("archived");
    expect(byName.get("frozen-new")?.freshness).toBe("archived");
    // No file to be old: still reported as missing, not as archived knowledge.
    expect(byName.get("frozen-none")).toMatchObject({
      archived: true,
      knowledgeFile: null,
      knowledgeAgeDays: null,
      freshness: "missing",
    });
    // A file whose age could not be read has no age to leave unbanded.
    expect(byName.get("frozen-unreadable")?.freshness).toBe("missing");
    // An active repository with the same age is still stale.
    expect(byName.get("live-api")).toMatchObject({
      archived: false,
      freshness: "stale",
    });
  });

  test("does not list a repo twice and sorts by name", () => {
    const entries = buildRepoEntries({
      reposJson: reposJson(
        { name: "zeta" },
        { name: "alpha" },
        { name: "zeta" },
      ),
      clonedDirs: ["alpha"],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("worktrees", () => {
  const entry = (path: string, more: Partial<WorktreeEntry> = {}) => ({
    path,
    kind: "trees" as const,
    branch: "feat/x",
    head: "abc",
    detached: false,
    locked: false,
    prunable: false,
    missing: false,
    ...more,
  });

  test("keeps the registry's order and flags entries whose directory is gone", () => {
    const entries: WorktreeEntry[] = [
      entry("C:/repo", { kind: "main", branch: "master" }),
      entry("C:/repo/trees/new1", { id: "new1", createdAt: "2026-09-09" }),
      entry("C:/repo/trees/old1", {
        id: "old1",
        createdAt: "2026-08-01",
        missing: true,
      }),
      entry("C:/repo/.claude/worktrees/app", { kind: "claude" }),
    ];
    const views = worktreeViews(entries, (path) => !path.endsWith("old1"));
    expect(views.map((view) => [view.path, view.pathExists])).toEqual([
      ["C:/repo", true],
      ["C:/repo/trees/new1", true],
      ["C:/repo/trees/old1", false],
      ["C:/repo/.claude/worktrees/app", true],
    ]);
    expect(views[1]).toMatchObject({ id: "new1", kind: "trees" });
  });
});

describe("sharedConventionsFrom", () => {
  test("reads the real knowledge/_shared.yaml", () => {
    const yaml = readFileSync(
      join(REPO_ROOT, "knowledge", "_shared.yaml"),
      "utf8",
    );
    const conventions = sharedConventionsFrom(yaml, "knowledge/_shared.yaml");
    const byKey = new Map(conventions.entries.map((e) => [e.key, e.value]));

    expect(conventions.error).toBeNull();
    expect(byKey.get("commit_format.pattern")).toBe(
      "<type>(<scope>): <short description>",
    );
    expect(byKey.get("branch_naming.pattern")).toBe(
      "<type>/<task-id>-<short-description>",
    );
    expect(byKey.get("commit_format.footer")).toBe("Refs: <TASK-ID>");
    expect(byKey.get("commit_format.types")).toBe(
      "feat; fix; refactor; test; docs; chore; build",
    );
    // Was a multi-line quoted scalar with column-0 continuation lines, which
    // made the whole file invalid YAML.
    expect(byKey.get("commit_format.example")).toBe(
      "feat(auth): add refresh token rotation\n\nRotate tokens on each use.\n\nRefs: T-42",
    );
    // Only the shared_conventions block — not the integration map or notes.
    expect([...byKey.keys()].some((key) => key.startsWith("integration"))).toBe(
      false,
    );
  });

  test("reports a parse error instead of throwing", () => {
    const conventions = sharedConventionsFrom(
      "shared_conventions: [unclosed",
      "x.yaml",
    );
    expect(conventions.entries).toEqual([]);
    expect(conventions.error).not.toBeNull();
  });

  test("is empty, not an error, when the block is absent", () => {
    expect(sharedConventionsFrom("other: 1", "x.yaml")).toEqual({
      source: "x.yaml",
      entries: [],
      error: null,
    });
  });
});
