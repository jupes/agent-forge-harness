import { describe, expect, test } from "bun:test";
import {
  ageInDays,
  buildRepoEntries,
  freshnessFor,
  parseReposConfig,
} from "../../scripts/dashboard/repos-knowledge-model";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const DAY = 86_400_000;

describe("freshness bands", () => {
  test("splits knowledge age into current, aging and stale", () => {
    expect(freshnessFor(0)).toBe("current");
    expect(freshnessFor(14)).toBe("current");
    expect(freshnessFor(15)).toBe("aging");
    expect(freshnessFor(30)).toBe("aging");
    expect(freshnessFor(31)).toBe("stale");
  });

  test("reports missing when there is no knowledge file at all", () => {
    expect(freshnessFor(null)).toBe("missing");
  });

  test("ageInDays floors to whole days and never goes negative", () => {
    expect(ageInDays(NOW - 3 * DAY, NOW)).toBe(3);
    expect(ageInDays(NOW + DAY, NOW)).toBe(0);
    expect(ageInDays(null, NOW)).toBeNull();
  });
});

describe("parseReposConfig", () => {
  test("accepts both the wrapped and bare array shapes", () => {
    expect(
      parseReposConfig(JSON.stringify({ repos: [{ name: "a" }] })),
    ).toEqual([{ name: "a" }]);
    expect(parseReposConfig(JSON.stringify([{ name: "b" }]))).toEqual([
      { name: "b" },
    ]);
  });

  test("returns nothing rather than throwing on bad input", () => {
    expect(parseReposConfig(null)).toEqual([]);
    expect(parseReposConfig("nope")).toEqual([]);
    expect(parseReposConfig("{}")).toEqual([]);
  });
});

describe("buildRepoEntries", () => {
  test("joins configured repos with clone state and knowledge freshness", () => {
    const entries = buildRepoEntries({
      reposJson: JSON.stringify({
        repos: [
          { name: "game-guide-ai", url: "git@example:g.git", branch: "master" },
        ],
      }),
      clonedDirs: ["game-guide-ai"],
      knowledge: new Map([["game-guide-ai", 3]]),
      now: NOW,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "game-guide-ai",
      path: "repos/game-guide-ai",
      branch: "master",
      cloned: true,
      knowledgeFile: "knowledge/repos/game-guide-ai.yaml",
      freshness: "current",
    });
  });

  test("marks a registered repo that has not been cloned", () => {
    const entries = buildRepoEntries({
      reposJson: JSON.stringify({ repos: [{ name: "farrealms-web" }] }),
      clonedDirs: [],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries[0]?.cloned).toBe(false);
    expect(entries[0]?.freshness).toBe("missing");
  });

  test("still lists a cloned directory nobody registered", () => {
    // Otherwise a repo added by hand would be invisible on this page.
    const entries = buildRepoEntries({
      reposJson: JSON.stringify({ repos: [] }),
      clonedDirs: ["surprise-repo"],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries.map((entry) => entry.name)).toEqual(["surprise-repo"]);
    expect(entries[0]?.cloned).toBe(true);
  });

  test("does not list the same repo twice when configured and cloned", () => {
    const entries = buildRepoEntries({
      reposJson: JSON.stringify({ repos: [{ name: "dup" }] }),
      clonedDirs: ["dup"],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries).toHaveLength(1);
  });

  test("sorts by name so the table is stable between reloads", () => {
    const entries = buildRepoEntries({
      reposJson: JSON.stringify({
        repos: [{ name: "zeta" }, { name: "alpha" }],
      }),
      clonedDirs: [],
      knowledge: new Map(),
      now: NOW,
    });
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });
});
