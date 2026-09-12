import { describe, expect, test } from "bun:test";
import {
  activeBlockerIdsByIssue,
  dashboardSections,
  filterListIssues,
  LIST_ROW_CAP,
} from "../../docs/js/islands/issues-views-model";
import type { BeadsIssue, BeadsPayload } from "../../types/beads";

function issue(over: Partial<BeadsIssue> & { id: string }): BeadsIssue {
  return {
    type: "task",
    title: `Title ${over.id}`,
    status: "open",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  } as BeadsIssue;
}

function payloadOf(issues: BeadsIssue[], over: Partial<BeadsPayload> = {}) {
  const byStatus = {
    open: issues.filter((i) => i.status === "open"),
    in_progress: issues.filter((i) => i.status === "in_progress"),
    closed: issues.filter((i) => i.status === "closed"),
    blocked: issues.filter((i) => i.status === "blocked"),
  };
  return {
    version: "1.0.0",
    generatedAt: "2026-09-10T00:00:00.000Z",
    issues,
    comments: [],
    deps: [],
    derived: {
      byStatus,
      byType: { epic: [], feature: [], task: [], bug: [], chore: [] },
      byRepo: {},
      ready: issues.filter((i) => i.status === "open"),
      blocked: byStatus.blocked,
      deps: [],
    },
    ...over,
  } as BeadsPayload;
}

describe("dashboard sections", () => {
  test("caps each table at the size the dashboard has always used", () => {
    const many = Array.from({ length: 40 }, (_, n) =>
      issue({ id: `open-${n}` }),
    );
    const sections = dashboardSections(payloadOf(many), "all");

    // 25 / 15 / 15 / 25 — the full counts stay visible in the headings.
    expect(sections.inProgress.rows.length).toBeLessThanOrEqual(25);
    expect(sections.ready.rows).toHaveLength(15);
    expect(sections.ready.total).toBe(40);
    expect(sections.closed.rows.length).toBeLessThanOrEqual(25);
  });

  test("preserves the two different in-progress counts, unfiltered", () => {
    // Long-standing quirk: the stat card counts strict `in_progress` while the
    // section heading also counts open issues that have an assignee. They are
    // allowed to disagree — do not "fix" this into one number.
    const issues = [
      issue({ id: "a", status: "in_progress" }),
      issue({ id: "b", status: "open", assignee: "jupes" }),
    ];
    const sections = dashboardSections(payloadOf(issues), "all");
    expect(sections.stats.inProgress).toBe(1);
    expect(sections.inProgress.total).toBe(2);
  });

  test("the two counts converge once an initiative is selected", () => {
    const epic = issue({ id: "epic-1", type: "epic" });
    const issues = [
      epic,
      issue({ id: "a", status: "in_progress", parent: "epic-1" }),
      issue({ id: "b", status: "open", assignee: "jupes", parent: "epic-1" }),
    ];
    const sections = dashboardSections(payloadOf(issues), "epic-1");
    expect(sections.stats.inProgress).toBe(sections.inProgress.total);
  });

  test("hides the blocked section entirely when nothing is blocked", () => {
    const sections = dashboardSections(payloadOf([issue({ id: "a" })]), "all");
    expect(sections.blocked.total).toBe(0);
  });

  test("sorts in-progress and closed by most recently updated", () => {
    const issues = [
      issue({ id: "old", status: "closed", updatedAt: "2026-01-01T00:00:00Z" }),
      issue({ id: "new", status: "closed", updatedAt: "2026-09-01T00:00:00Z" }),
    ];
    const sections = dashboardSections(payloadOf(issues), "all");
    expect(sections.closed.rows[0]?.id).toBe("new");
  });
});

describe("list filtering", () => {
  const issues = [
    issue({ id: "af-1", title: "Add auth" }),
    issue({ id: "af-2", title: "Fix router", status: "closed" }),
    issue({ id: "af-3", title: "Auth cleanup", status: "in_progress" }),
  ];

  test("matches on title or id, case-insensitively", () => {
    expect(
      filterListIssues(issues, {
        search: "auth",
        status: "all",
        initiative: "all",
      }).map((i) => i.id),
    ).toEqual(["af-1", "af-3"]);
    expect(
      filterListIssues(issues, {
        search: "AF-2",
        status: "all",
        initiative: "all",
      }).map((i) => i.id),
    ).toEqual(["af-2"]);
  });

  test("filters by status", () => {
    expect(
      filterListIssues(issues, {
        search: "",
        status: "closed",
        initiative: "all",
      }).map((i) => i.id),
    ).toEqual(["af-2"]);
  });

  test("caps the rendered rows at 100 while reporting the true total", () => {
    const many = Array.from({ length: 130 }, (_, n) => issue({ id: `i-${n}` }));
    const filtered = filterListIssues(many, {
      search: "",
      status: "all",
      initiative: "all",
    });
    expect(filtered).toHaveLength(130);
    expect(filtered.slice(0, LIST_ROW_CAP)).toHaveLength(100);
  });
});

describe("activeBlockerIdsByIssue", () => {
  test("lists only open blockers, ignoring closed ones", () => {
    const issues = [
      issue({ id: "blocked-1" }),
      issue({ id: "blocker-open" }),
      issue({ id: "blocker-done", status: "closed" }),
    ];
    const map = activeBlockerIdsByIssue(issues, [
      { from: "blocked-1", to: "blocker-open", type: "blocks" },
      { from: "blocked-1", to: "blocker-done", type: "blocks" },
    ]);
    expect(map.get("blocked-1")).toEqual(["blocker-open"]);
  });

  test("ignores relation types that do not block", () => {
    const map = activeBlockerIdsByIssue(
      [issue({ id: "a" }), issue({ id: "b" })],
      [{ from: "a", to: "b", type: "relates" }],
    );
    expect(map.get("a")).toBeUndefined();
  });
});
