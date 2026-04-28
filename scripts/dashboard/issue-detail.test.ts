// @ts-nocheck — `docs/js/issue-detail.mjs` is the browser module; Bun runs tests against it without TS declarations.
import { describe, expect, test } from "bun:test";
import {
  buildIssueDetailPanelHtml,
  commentsForIssue,
  depsTouchingIssue,
  escapeHtml,
  issueIdCopyControlHtml,
  toggleExpandedState,
  workBranchesFromCommentBodies,
} from "../../docs/js/issue-detail.mjs";

describe("escapeHtml", () => {
  test("escapes HTML special characters", () => {
    expect(escapeHtml("<script>&\"'")).toBe("&lt;script&gt;&amp;&quot;'"); // ' not escaped in our fn
  });

  test("handles nullish", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("issueIdCopyControlHtml", () => {
  test("renders button with escaped id in data-copy-text and code", () => {
    const html = issueIdCopyControlHtml('T-1&"');
    expect(html).toContain('class="issue-id-copy"');
    expect(html).toContain("data-copy-text=");
    expect(html).toContain("T-1&amp;&quot;");
    expect(html).toContain("<code>");
  });

  test("returns empty string for empty id", () => {
    expect(issueIdCopyControlHtml("")).toBe("");
    expect(issueIdCopyControlHtml(null)).toBe("");
  });
});

describe("toggleExpandedState", () => {
  test("opens when nothing expanded", () => {
    expect(toggleExpandedState(null, "T-1")).toBe("T-1");
  });

  test("closes when same row clicked", () => {
    expect(toggleExpandedState("T-1", "T-1")).toBeNull();
  });

  test("switches when different row clicked", () => {
    expect(toggleExpandedState("T-1", "T-2")).toBe("T-2");
  });

  test("empty clicked id leaves state unchanged", () => {
    expect(toggleExpandedState("T-1", "")).toBe("T-1");
  });
});

describe("workBranchesFromCommentBodies", () => {
  test("collects Branch token and backtick feat paths, deduped in order", () => {
    const branches = workBranchesFromCommentBodies([
      { body: "worklog: Branch feat/a-task — done" },
      { body: "see `feat/a-task` and `fix/b-bug`" },
      { body: "noise feat/not-a-branch-word" },
    ]);
    expect(branches).toEqual(["feat/a-task", "fix/b-bug"]);
  });

  test("returns empty when no branch-shaped tokens", () => {
    expect(
      workBranchesFromCommentBodies([{ body: "worklog: no branch here" }]),
    ).toEqual([]);
  });
});

describe("commentsForIssue", () => {
  test("filters and sorts by createdAt", () => {
    const list = [
      {
        issueId: "A",
        body: "b",
        author: "u",
        createdAt: "2026-01-02T00:00:00Z",
      },
      {
        issueId: "B",
        body: "x",
        author: "u",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        issueId: "B",
        body: "y",
        author: "u",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ];
    const got = commentsForIssue("B", list);
    expect(got.map((c: { body: string }) => c.body)).toEqual(["x", "y"]);
  });
});

describe("depsTouchingIssue", () => {
  test("includes edges where issue is from or to", () => {
    const deps = [
      { from: "A", to: "B", type: "blocks" },
      { from: "C", to: "D", type: "blocks" },
    ];
    expect(depsTouchingIssue("B", deps)).toHaveLength(1);
    expect(depsTouchingIssue("A", deps)).toHaveLength(1);
    expect(depsTouchingIssue("C", deps)).toHaveLength(1);
    expect(depsTouchingIssue("X", deps)).toHaveLength(0);
  });
});

describe("buildIssueDetailPanelHtml", () => {
  test("includes close control and escaped title", () => {
    const issue = {
      id: "T-99",
      type: "task",
      title: "<x>",
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const html = buildIssueDetailPanelHtml(issue, { comments: [], deps: [] });
    expect(html).toContain("issue-detail-close");
    expect(html).toContain("issue-id-copy");
    expect(html).toContain("data-copy-text=");
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("<x>");
    expect(html).toContain("T-99");
    expect(html).toContain("No comments in this export.");
  });

  test("renders comments and dependency copy for blocked issue", () => {
    const issue = {
      id: "T-1",
      type: "task",
      title: "Do",
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const html = buildIssueDetailPanelHtml(issue, {
      comments: [
        {
          issueId: "T-1",
          body: "worklog: hi",
          author: "a",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
      deps: [{ from: "T-1", to: "T-2", type: "blocks" }],
    });
    expect(html).toContain("worklog: hi");
    expect(html).not.toContain("No comments in this export.");
    expect(html).toContain("Blocked by");
    expect(html).toContain("T-2");
  });

  test("renders work branch section when comments mention Branch feat/…", () => {
    const issue = {
      id: "T-9",
      type: "task",
      title: "W",
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const html = buildIssueDetailPanelHtml(issue, {
      comments: [
        {
          issueId: "T-9",
          body: "worklog: Branch feat/z-impl",
          author: "a",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
      deps: [],
    });
    expect(html).toContain("Work branches (from comments)");
    expect(html).toContain("feat/z-impl");
  });

  test("renders Blocks when issue is the blocker", () => {
    const issue = {
      id: "T-2",
      type: "task",
      title: "Blocker",
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const html = buildIssueDetailPanelHtml(issue, {
      comments: [],
      deps: [{ from: "T-1", to: "T-2", type: "blocks" }],
    });
    expect(html).toContain("Blocks");
    expect(html).toContain("T-1");
  });
});
