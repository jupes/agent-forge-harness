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
    const rows = [row("a1", "Mapped", { labels: ["repo:rag-chat"] })];
    expect(repoOf(rows, "a1", { map: map({ a1: "game-guide-ai" }) })).toBe(
      "game-guide-ai",
    );
  });

  test("an epic's entry covers its children and their children", () => {
    const rows = [
      row("0im", "D&D epic", { issue_type: "epic" }),
      row("0im.1", "Child", { parent: "0im" }),
      row("0im.1.2", "Grandchild", { parent: "0im.1" }),
    ];
    const context = { map: map({ "0im": "rag-chat" }) };
    expect(repoOf(rows, "0im", context)).toBe("rag-chat");
    expect(repoOf(rows, "0im.1", context)).toBe("rag-chat");
    expect(repoOf(rows, "0im.1.2", context)).toBe("rag-chat");
  });

  test("an epic's entry covers a child even when the export leaves the epic out", () => {
    const rows = [row("0im.1", "Child of a missing epic", { parent: "0im" })];
    expect(repoOf(rows, "0im.1", { map: map({ "0im": "rag-chat" }) })).toBe(
      "rag-chat",
    );
  });

  test("a child's own label, title prefix or entry wins over its epic's entry", () => {
    const rows = [
      row("0im", "Epic"),
      row("0im.1", "Labelled", {
        parent: "0im",
        labels: ["repo:skills"],
      }),
      row("0im.2", "[game-guide-ai] Prefixed", { parent: "0im" }),
      row("0im.3", "Own entry", { parent: "0im" }),
    ];
    const context = {
      knownRepos: ["game-guide-ai"],
      map: map({ "0im": "rag-chat", "0im.3": "financial-services" }),
    };
    expect(repoOf(rows, "0im.1", context)).toBe("skills");
    expect(repoOf(rows, "0im.2", context)).toBe("game-guide-ai");
    expect(repoOf(rows, "0im.3", context)).toBe("financial-services");
  });

  test("an issue with nothing of its own takes the repository its parent names with a label or a title prefix", () => {
    const rows = [
      row("e1", "Labelled epic", { labels: ["repo:rag-chat"] }),
      row("e1.1", "Plain child", { parent: "e1" }),
      row("e2", "[game-guide-ai] Prefixed epic"),
      row("e2.1", "Plain child", { parent: "e2" }),
    ];
    const context = { knownRepos: ["game-guide-ai"] };
    expect(repoOf(rows, "e1.1", context)).toBe("rag-chat");
    expect(repoOf(rows, "e2.1", context)).toBe("game-guide-ai");
  });

  test("the host prefix shows only when neither the issue nor an ancestor names a repository", () => {
    const rows = [
      row("x1gs", "[dashboard] Harness epic"),
      row("x1gs.8", "[hearth] Child", { parent: "x1gs" }),
    ];
    expect(repoOf(rows, "x1gs.8", { map: map({ other: "rag-chat" }) })).toBe(
      HOST,
    );
  });

  test("a title tag the map lists stands for its repository", () => {
    const rows = [row("a1", "[dnd] Monster stat blocks")];
    expect(repoOf(rows, "a1", { map: map({}, { dnd: "rag-chat" }) })).toBe(
      "rag-chat",
    );
  });

  test("a repository the map names is known to the title rule", () => {
    const rows = [row("a1", "[financial-services] Rates page")];
    expect(
      repoOf(rows, "a1", { map: map({ other: "financial-services" }) }),
    ).toBe("financial-services");
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
      row("a1", "Labelled", { labels: ["repo:rag-chat"] }),
      row("a2", "[game-guide-ai] Prefixed"),
      row("a3", "Field", { repo: "./repos/custom-repo" }),
      row("a4", "Nothing"),
    ];
    const resolved = resolveIssueRepos(rows, {
      knownRepos: ["game-guide-ai"],
      map: map({ e1: "skills" }),
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
