import { describe, expect, test } from "bun:test";
import {
  buildDerivedFromIssuesAndDeps,
  collectBlockDeps,
  issuesAndDepsFromExportRows,
  mapNumericPriority,
  normalizeBdExportRow,
  normalizeIssueType,
  normalizeStatus,
  parseBdExportStdout,
} from "./beads-dashboard";
import type { BeadsDependency, BeadsIssue } from "../types/beads";

describe("normalizeBdExportRow", () => {
  test("maps owner as metadata and assignee only when set (owner does not fill assignee)", () => {
    const row = {
      id: "T-1",
      title: "Do thing",
      status: "open",
      issue_type: "task",
      priority: 1,
      acceptance_criteria: "AC text",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      owner: "agent-1",
      dependencies: [{ issue_id: "T-1", depends_on_id: "EPIC-1", type: "parent-child" }],
    };
    const issue = normalizeBdExportRow(row);
    expect(issue.id).toBe("T-1");
    expect(issue.type).toBe("task");
    expect(issue.status).toBe("open");
    expect(issue.priority).toBe("high");
    expect(issue.description).toBe("AC text");
    expect(issue.parent).toBe("EPIC-1");
    expect(issue.owner).toBe("agent-1");
    expect(issue.assignee).toBeUndefined();
  });

  test("maps explicit assignee when present", () => {
    const issue = normalizeBdExportRow({
      id: "T-2",
      title: "Claimed",
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
      owner: "creator",
      assignee: "worker-1",
    });
    expect(issue.owner).toBe("creator");
    expect(issue.assignee).toBe("worker-1");
  });

  test("unknown status becomes open; unknown type becomes task", () => {
    const issue = normalizeBdExportRow({
      id: "X",
      title: "x",
      status: "weird",
      created_at: "2026-01-01T00:00:00Z",
      issue_type: "unknown-kind",
    });
    expect(issue.status).toBe("open");
    expect(issue.type).toBe("task");
  });
});

describe("mapNumericPriority", () => {
  test("maps numeric bands", () => {
    expect(mapNumericPriority(0)).toBe("critical");
    expect(mapNumericPriority(-1)).toBe("critical");
    expect(mapNumericPriority(1)).toBe("high");
    expect(mapNumericPriority(2)).toBe("medium");
    expect(mapNumericPriority(3)).toBe("low");
    expect(mapNumericPriority(99)).toBe("low");
    expect(mapNumericPriority(undefined)).toBeUndefined();
  });
});

describe("collectBlockDeps", () => {
  test("dedupes blocks edges and ignores non-blocks", () => {
    const rows = [
      {
        id: "A",
        title: "a",
        status: "open",
        dependencies: [
          { issue_id: "A", depends_on_id: "B", type: "blocks" },
          { issue_id: "A", depends_on_id: "B", type: "blocks" },
          { issue_id: "A", depends_on_id: "C", type: "relates" },
        ],
      },
    ];
    const deps = collectBlockDeps(rows);
    expect(deps).toEqual([{ from: "A", to: "B", type: "blocks" }]);
  });
});

describe("parseBdExportStdout", () => {
  test("parses NDJSON lines and skips bad lines", () => {
    const stdout = '{"id":"1","title":"a","status":"open"}\nnot json\n{"id":"2","title":"b","status":"closed"}\n';
    const rows = parseBdExportStdout(stdout);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("issuesAndDepsFromExportRows", () => {
  test("produces issues + block deps from export rows", () => {
    const { issues, deps } = issuesAndDepsFromExportRows([
      {
        id: "T-1",
        title: "t",
        status: "open",
        created_at: "2026-01-01T00:00:00Z",
        dependencies: [{ issue_id: "T-1", depends_on_id: "T-2", type: "blocks" }],
      },
      { id: "T-2", title: "blocker", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(issues).toHaveLength(2);
    expect(deps).toEqual([{ from: "T-1", to: "T-2", type: "blocks" }]);
  });
});

describe("buildDerivedFromIssuesAndDeps", () => {
  const baseIssue = (partial: Partial<BeadsIssue> & Pick<BeadsIssue, "id" | "title" | "status">): BeadsIssue =>
    ({
      type: "task",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ...partial,
    }) as BeadsIssue;

  test("ready = open, no assignee, not blocked by open blocker", () => {
    const issues: BeadsIssue[] = [
      baseIssue({ id: "R", title: "ready", status: "open" }),
      baseIssue({ id: "B", title: "blocked", status: "open" }),
      baseIssue({ id: "K", title: "blocker", status: "open" }),
    ];
    const deps: BeadsDependency[] = [{ from: "B", to: "K", type: "blocks" }];
    const derived = buildDerivedFromIssuesAndDeps(issues, deps);
    /** Blocker `K` is also open/unclaimed and not listed in `blocked`, so it appears in `ready`. */
    expect(derived.ready.map((i) => i.id).sort()).toEqual(["K", "R"]);
    expect(derived.blocked.map((i) => i.id)).toEqual(["B"]);
  });

  test("closed blocker does not block downstream", () => {
    const issues: BeadsIssue[] = [
      baseIssue({ id: "B", title: "was blocked", status: "open" }),
      baseIssue({ id: "K", title: "done", status: "closed" }),
    ];
    const derived = buildDerivedFromIssuesAndDeps(issues, [{ from: "B", to: "K", type: "blocks" }]);
    expect(derived.ready.map((i) => i.id)).toEqual(["B"]);
    expect(derived.blocked).toHaveLength(0);
  });

  test("normalizeIssueType / normalizeStatus helpers", () => {
    expect(normalizeIssueType("EPIC")).toBe("epic");
    expect(normalizeStatus("in_progress")).toBe("in_progress");
  });
});
