import { describe, expect, test } from "bun:test";
import type { BdExportRow } from "../beads-dashboard";
import {
  type IssueRepoMap,
  issueRepos,
  type RepoContext,
  resolveIssueRepos,
} from "./issue-repo";

const HOST = "agent-forge-harness";

/** One export row; `parent` adds the parent-child edge bd exports. */
function row(
  short: string,
  title: string,
  extra: Partial<BdExportRow> & { parent?: string } = {},
): BdExportRow {
  const { parent, ...rest } = extra;
  const id = `${HOST}-${short}`;
  return {
    id,
    title,
    status: "open",
    created_at: "2026-01-01T00:00:00Z",
    ...(parent
      ? {
          dependencies: [
            {
              issue_id: id,
              depends_on_id: `${HOST}-${parent}`,
              type: "parent-child",
            },
          ],
        }
      : {}),
    ...rest,
  };
}

const repoOf = (
  rows: BdExportRow[],
  short: string,
  context: RepoContext = {},
): string | undefined => issueRepos(rows, context).get(`${HOST}-${short}`);

const map = (
  issues: Record<string, string>,
  titleTags: Record<string, string> = {},
): IssueRepoMap => ({
  issues: Object.fromEntries(
    Object.entries(issues).map(([short, repo]) => [`${HOST}-${short}`, repo]),
  ),
  titleTags,
});

describe("issueRepos: the repository map", () => {
  test("an entry for the issue's own id wins over its repo: label", () => {
    const rows = [row("a1", "Mapped", { labels: ["repo:my-api"] })];
    expect(repoOf(rows, "a1", { map: map({ a1: "my-frontend" }) })).toBe(
      "my-frontend",
    );
  });

  test("an epic's entry covers its children and their children", () => {
    const rows = [
      row("e10", "API epic", { issue_type: "epic" }),
      row("e10.1", "Child", { parent: "e10" }),
      row("e10.1.2", "Grandchild", { parent: "e10.1" }),
    ];
    const context = { map: map({ e10: "my-api" }) };
    expect(repoOf(rows, "e10", context)).toBe("my-api");
    expect(repoOf(rows, "e10.1", context)).toBe("my-api");
    expect(repoOf(rows, "e10.1.2", context)).toBe("my-api");
  });

  test("an epic's entry covers a child even when the export leaves the epic out", () => {
    const rows = [row("e10.1", "Child of a missing epic", { parent: "e10" })];
    expect(repoOf(rows, "e10.1", { map: map({ e10: "my-api" }) })).toBe(
      "my-api",
    );
  });

  test("a child's own label, title prefix or entry wins over its epic's entry", () => {
    const rows = [
      row("e10", "Epic"),
      row("e10.1", "Labelled", {
        parent: "e10",
        labels: ["repo:docs-site"],
      }),
      row("e10.2", "[my-frontend] Prefixed", { parent: "e10" }),
      row("e10.3", "Own entry", { parent: "e10" }),
    ];
    const context = {
      knownRepos: ["my-frontend"],
      map: map({ e10: "my-api", "e10.3": "billing" }),
    };
    expect(repoOf(rows, "e10.1", context)).toBe("docs-site");
    expect(repoOf(rows, "e10.2", context)).toBe("my-frontend");
    expect(repoOf(rows, "e10.3", context)).toBe("billing");
  });

  test("an issue with nothing of its own takes the repository its parent names with a label or a title prefix", () => {
    const rows = [
      row("e1", "Labelled epic", { labels: ["repo:my-api"] }),
      row("e1.1", "Plain child", { parent: "e1" }),
      row("e2", "[my-frontend] Prefixed epic"),
      row("e2.1", "Plain child", { parent: "e2" }),
    ];
    const context = { knownRepos: ["my-frontend"] };
    expect(repoOf(rows, "e1.1", context)).toBe("my-api");
    expect(repoOf(rows, "e2.1", context)).toBe("my-frontend");
  });

  test("the host prefix shows only when neither the issue nor an ancestor names a repository", () => {
    const rows = [
      row("x1gs", "[dashboard] Harness epic"),
      row("x1gs.8", "[hearth] Child", { parent: "x1gs" }),
    ];
    expect(repoOf(rows, "x1gs.8", { map: map({ other: "my-api" }) })).toBe(
      HOST,
    );
  });

  test("a title tag the map lists stands for its repository", () => {
    const rows = [row("a1", "[api] Rate limits")];
    expect(repoOf(rows, "a1", { map: map({}, { api: "my-api" }) })).toBe(
      "my-api",
    );
  });

  test("a repository the map names is known to the title rule", () => {
    const rows = [row("a1", "[billing] Rates page")];
    expect(repoOf(rows, "a1", { map: map({ other: "billing" }) })).toBe(
      "billing",
    );
  });

  test("a parent loop ends: each issue in it shows the host prefix", () => {
    const rows = [
      row("p1", "Loop one", { parent: "p2" }),
      row("p2", "Loop two", { parent: "p1" }),
    ];
    expect(repoOf(rows, "p1")).toBe(HOST);
    expect(repoOf(rows, "p2")).toBe(HOST);
  });
});

describe("resolveIssueRepos: where each repository came from", () => {
  test("names the rule that decided it", () => {
    const rows = [
      row("e1", "Epic"),
      row("e1.1", "Child", { parent: "e1" }),
      row("a1", "Labelled", { labels: ["repo:my-api"] }),
      row("a2", "[my-frontend] Prefixed"),
      row("a3", "Field", { repo: "./repos/custom-repo" }),
      row("a4", "Nothing"),
    ];
    const resolved = resolveIssueRepos(rows, {
      knownRepos: ["my-frontend"],
      map: map({ e1: "docs-site" }),
    });
    const from = (short: string) => resolved.get(`${HOST}-${short}`)?.from;
    expect(from("e1")).toBe("map");
    expect(from("e1.1")).toBe("parent");
    expect(from("a1")).toBe("label");
    expect(from("a2")).toBe("title");
    expect(from("a3")).toBe("field");
    expect(from("a4")).toBe("host");
  });
});
